import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { rateLimit } from "../rate-limit";
import { getSmsProvider, smsDestinationAllowed } from "../providers/sms";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const DAY_MS = 86400_000;
const limits = () => ({
  perUser: Number(process.env.SMS_DAILY_LIMIT_PER_USER || 20),
  global: Number(process.env.SMS_DAILY_LIMIT || 2000),
  perNumberCodes: 5,
});
const NOT_CONFIGURED = "Text messages aren't set up on this server.";
export const isSmsAvailable = () => !!getSmsProvider();

type SendInput = { userId: string | null; to: string; body: string; purpose: "verification" | "reminder" | "summary"; storedBody?: string };

/**
 * Send a text and record it. Never throws for delivery problems; returns the recorded status.
 * Enforces the destination allowlist and per-user / global daily caps (cost and abuse control).
 */
export async function sendSms(input: SendInput) {
  const provider = getSmsProvider();
  const record = (status: "OUTBOX" | "SENT" | "FAILED", extra: { providerId?: string; error?: string } = {}) =>
    db.smsMessage.create({
      data: {
        userId: input.userId, to: input.to, purpose: input.purpose, provider: provider?.name ?? "none", status, ...extra,
        // Verification codes are only ever stored in the dev outbox; real SMS stores a masked copy.
        body: provider?.name === "outbox" ? input.body : (input.storedBody ?? input.body),
      },
    });
  const fail = async (error: string) => {
    await record("FAILED", { error });
    return { ok: false as const, status: "FAILED" as const, error };
  };
  if (!provider) return fail(NOT_CONFIGURED);
  if (!smsDestinationAllowed(input.to)) return fail("This country isn't enabled for text messages.");
  const since = new Date(Date.now() - DAY_MS);
  const counted = { status: { in: ["SENT", "OUTBOX"] as ("SENT" | "OUTBOX")[] }, createdAt: { gte: since } };
  const [mine, all] = await Promise.all([
    input.userId ? db.smsMessage.count({ where: { userId: input.userId, ...counted } }) : 0,
    db.smsMessage.count({ where: counted }),
  ]);
  if (mine >= limits().perUser) return fail("Daily text-message limit reached for this account.");
  if (all >= limits().global) return fail("Daily text-message limit reached for this server.");
  try {
    const r = await provider.send(input.to, input.body);
    await record(r.status, { providerId: r.providerId });
    return { ok: true as const, status: r.status };
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    console.error("[sms] send failed", error);
    return fail(error);
  }
}

const hashCode = (userId: string, phone: string, code: string) => createHash("sha256").update(`${userId}:${phone}:${code}`).digest("hex");

/** Text a 6-digit code to the user's saved number. */
export async function startPhoneVerification(ctx: { userId: string; organizationId: string }) {
  const provider = getSmsProvider();
  if (!provider) throw new AppError("NOT_CONFIGURED", NOT_CONFIGURED);
  rateLimit(`phone-verify-start:${ctx.userId}`, Number(process.env.SMS_VERIFY_STARTS_PER_10MIN || 3), 10 * 60_000);
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedVia: true } });
  if (!user.phoneNumber) throw new AppError("VALIDATION", "Add your mobile number in your profile first.");
  if (user.phoneVerifiedAt && user.phoneVerifiedVia === provider.name) return { alreadyVerified: true, provider: provider.name };
  if (!smsDestinationAllowed(user.phoneNumber)) throw new AppError("VALIDATION", "Text messages to this country aren't enabled on this server.");
  // A number can receive only a few codes a day, whichever accounts ask (stops SMS bombing a stranger).
  const recent = await db.smsMessage.count({ where: { to: user.phoneNumber, purpose: "verification", createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
  if (recent >= limits().perNumberCodes) throw new AppError("RATE_LIMITED", "Too many codes were sent to this number today. Try again tomorrow.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const data = { phone: user.phoneNumber, codeHash: hashCode(ctx.userId, user.phoneNumber, code), attempts: 0, expiresAt: new Date(Date.now() + CODE_TTL_MS) };
  await db.phoneVerification.upsert({ where: { userId: ctx.userId }, create: { userId: ctx.userId, ...data }, update: data });
  const text = (c: string) => `Your MeetMind verification code is ${c}. It expires in 10 minutes.`;
  const sent = await sendSms({ userId: ctx.userId, to: user.phoneNumber, body: text(code), storedBody: text("••••••"), purpose: "verification" });
  if (!sent.ok) throw new AppError("PROVIDER_UNAVAILABLE", `We couldn't send the text message: ${sent.error}`);
  await audit({ action: "phone.verify_start", actorUserId: ctx.userId, organizationId: ctx.organizationId });
  return { alreadyVerified: false, provider: provider.name };
}

export async function confirmPhoneVerification(ctx: { userId: string; organizationId: string }, raw: unknown) {
  rateLimit(`phone-verify:${ctx.userId}`, 10, 10 * 60_000);
  const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(raw);
  const provider = getSmsProvider();
  if (!provider) throw new AppError("NOT_CONFIGURED", NOT_CONFIGURED);
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { phoneNumber: true } });
  // Claim one attempt atomically before comparing, so parallel guesses can't exceed the limit.
  const claim = await db.phoneVerification.updateMany({
    where: { userId: ctx.userId, phone: user.phoneNumber ?? "", expiresAt: { gt: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claim.count === 0) {
    const v = await db.phoneVerification.findUnique({ where: { userId: ctx.userId } });
    if (v && v.attempts >= MAX_ATTEMPTS && v.expiresAt > new Date()) throw new AppError("RATE_LIMITED", "Too many wrong codes. Send a new one.");
    throw new AppError("VALIDATION", "That code has expired. Send a new one.");
  }
  const v = await db.phoneVerification.findUniqueOrThrow({ where: { userId: ctx.userId } });
  const ok = timingSafeEqual(Buffer.from(v.codeHash, "hex"), Buffer.from(hashCode(ctx.userId, user.phoneNumber!, code), "hex"));
  if (!ok) throw new AppError("VALIDATION", "That code isn't right.");
  await db.$transaction([
    db.user.update({ where: { id: ctx.userId }, data: { phoneVerifiedAt: new Date(), phoneVerifiedVia: provider.name } }),
    db.phoneVerification.delete({ where: { userId: ctx.userId } }),
  ]);
  await audit({ action: "phone.verified", actorUserId: ctx.userId, organizationId: ctx.organizationId, metadata: { via: provider.name } });
  return { verified: true };
}

/** True when SMS can actually reach this user: verified through the provider in use now. */
export function canTextUser(u: { phoneNumber: string | null; phoneVerifiedAt: Date | null; phoneVerifiedVia: string | null }) {
  const provider = getSmsProvider();
  return !!(provider && u.phoneNumber && u.phoneVerifiedAt && u.phoneVerifiedVia === provider.name);
}

export async function setSmsReminders(ctx: { userId: string }, raw: unknown) {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(raw);
  const u = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedVia: true } });
  if (enabled && !canTextUser(u)) throw new AppError("VALIDATION", "Verify your mobile number first.");
  await db.user.update({ where: { id: ctx.userId }, data: { smsReminders: enabled } });
  return { enabled };
}

/** Your own text messages. Verification codes are masked unless this is the dev outbox. */
export async function listMySms(ctx: { userId: string }) {
  const messages = await db.smsMessage.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, to: true, body: true, purpose: true, provider: true, status: true, error: true, createdAt: true },
  });
  return { provider: getSmsProvider()?.name ?? null, messages };
}
