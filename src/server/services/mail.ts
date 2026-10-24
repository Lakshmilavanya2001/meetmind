import "server-only";
import { db } from "../db";
import { getEmailProvider } from "../providers/email";

export type MailMode = "smtp" | "outbox" | "off";
/** Development: EMAIL_DEV_OUTBOX=true records emails in the app instead of sending them. */
export const mailMode = (): MailMode => (process.env.EMAIL_DEV_OUTBOX === "true" ? "outbox" : getEmailProvider() ? "smtp" : "off");

/** Send an email and log it (Settings → Messages). Never throws for delivery problems. */
export async function sendLoggedEmail(input: { userId: string | null; to: string; subject: string; text: string; html?: string; purpose: string }) {
  const log = (status: "OUTBOX" | "SENT" | "FAILED", error?: string) =>
    db.emailMessage.create({ data: { userId: input.userId, to: input.to, subject: input.subject, text: input.text, purpose: input.purpose, status, error } });
  const mode = mailMode();
  if (mode === "outbox") {
    await log("OUTBOX");
    return { ok: true as const, status: "OUTBOX" as const };
  }
  const provider = getEmailProvider();
  if (!provider) {
    await log("FAILED", "Email isn't configured on this server.");
    return { ok: false as const, status: "FAILED" as const, error: "Email isn't configured on this server." };
  }
  try {
    await provider.send({ to: input.to, subject: input.subject, text: input.text, html: input.html });
    await log("SENT");
    return { ok: true as const, status: "SENT" as const };
  } catch (err) {
    const error = (err as Error).message.slice(0, 300);
    await log("FAILED", error);
    return { ok: false as const, status: "FAILED" as const, error };
  }
}

export async function listMyEmails(ctx: { userId: string }) {
  return db.emailMessage.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, to: true, subject: true, text: true, purpose: true, status: true, error: true, createdAt: true } });
}
