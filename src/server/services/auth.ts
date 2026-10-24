import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { getDummyHash, hashPassword, verifyPassword } from "../auth/password";
import { generateHumanCode } from "../auth/tokens";
import { assertUnderLimit, rateLimit, recordHit } from "../rate-limit";
import {
  changePasswordSchema,
  loginSchema,
  signupSchema,
  type SignupInput,
} from "@/lib/validation";
import { Prisma } from "@/generated/prisma/client";

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${generateHumanCode([4])}`;
}

export async function signup(raw: SignupInput, meta: { ip?: string | null } = {}) {
  // Per-IP when the client address is known; otherwise a generous global ceiling (a shared
  // "unknown" bucket with a per-IP limit would let one abuser block every signup).
  if (meta.ip) rateLimit(`signup:${meta.ip}`, 10, 60 * 60 * 1000);
  else rateLimit("signup:global", 200, 60 * 60 * 1000);
  const input = signupSchema.parse(raw);

  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) throw new AppError("CONFLICT", "An account with this email already exists.");

  let joinOrgId: string | null = null;
  if (input.workspaceMode === "join") {
    const org = await db.organization.findUnique({ where: { joinCode: input.joinCode! } });
    if (!org) throw new AppError("VALIDATION", "That workspace join code is not valid.");
    joinOrgId = org.id;
  }

  const passwordHash = await hashPassword(input.password);
  try {
    const result = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          timezone: input.timezone,
        },
      });
      const organizationId =
        joinOrgId ??
        (
          await tx.organization.create({
            data: {
              name: input.workspaceName!,
              slug: slugify(input.workspaceName!),
              joinCode: generateHumanCode([4, 4]),
            },
          })
        ).id;
      await tx.organizationMember.create({
        data: { organizationId, userId: user.id, role: joinOrgId ? "MEMBER" : "OWNER" },
      });
      return { userId: user.id, organizationId };
    });
    await audit({
      action: joinOrgId ? "auth.signup.join_workspace" : "auth.signup.create_workspace",
      actorUserId: result.userId,
      organizationId: result.organizationId,
      ipAddress: meta.ip,
    });
    return result;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AppError("CONFLICT", "An account with this email already exists.");
    }
    throw e;
  }
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function login(raw: unknown, meta: { ip?: string | null } = {}) {
  const input = loginSchema.parse(raw);
  // Only failed attempts count, so legitimate sign-ins from many devices are never locked out.
  // IP limits only apply when the real client IP is known (see clientIp); never share one bucket across users.
  // Per-email failures are counted per source IP when known, so others can't lock you out from elsewhere;
  // a high global per-email ceiling still stops distributed guessing.
  const ipKey = meta.ip ? `login:ip:${meta.ip}` : null;
  const emailKey = meta.ip ? `login:email:${input.email}:${meta.ip}` : `login:email:${input.email}`;
  const emailGlobalKey = `login:email-global:${input.email}`;
  if (ipKey) assertUnderLimit(ipKey, 50);
  assertUnderLimit(emailKey, 8);
  assertUnderLimit(emailGlobalKey, 100);

  const user = await db.user.findUnique({
    where: { email: input.email },
    include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
  const ok = await verifyPassword(input.password, user?.passwordHash ?? getDummyHash());
  if (!user || !ok || !user.isActive) {
    if (ipKey) recordHit(ipKey, LOGIN_WINDOW_MS);
    recordHit(emailKey, LOGIN_WINDOW_MS);
    recordHit(emailGlobalKey, LOGIN_WINDOW_MS);
    await audit({ action: "auth.login.failed", actorUserId: user?.id, ipAddress: meta.ip });
    throw new AppError("UNAUTHENTICATED", "Incorrect email or password.");
  }
  const organizationId = user.memberships[0]?.organizationId ?? null;
  if (!organizationId) throw new AppError("FORBIDDEN", "Your account is not a member of any workspace.");

  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ action: "auth.login", actorUserId: user.id, organizationId, ipAddress: meta.ip });
  return { userId: user.id, organizationId };
}

export async function changePassword(
  ctx: { userId: string; sessionId: string; organizationId: string },
  raw: unknown,
) {
  const input = changePasswordSchema.parse(raw);
  rateLimit(`pwchange:${ctx.userId}`, 5, 15 * 60 * 1000);
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError("VALIDATION", "Current password is incorrect.");
  }
  await db.$transaction([
    db.user.update({
      where: { id: ctx.userId },
      data: { passwordHash: await hashPassword(input.newPassword) },
    }),
    // Sign out every other device.
    db.session.deleteMany({ where: { userId: ctx.userId, id: { not: ctx.sessionId } } }),
  ]);
  await audit({ action: "auth.password_change", actorUserId: ctx.userId, organizationId: ctx.organizationId });
}
