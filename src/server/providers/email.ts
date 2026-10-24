import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import { AppError } from "../errors";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Calendar invite (RFC 5545), shown by mail clients as an "add to calendar" card. */
  icalEvent?: { method: "REQUEST" | "CANCEL"; content: string; filename?: string };
};

export interface EmailProvider {
  readonly name: string;
  /** Set while sending is paused after an authentication failure. */
  readonly pausedUntil?: Date | null;
  send(message: EmailMessage): Promise<{ messageId: string }>;
  /** Authenticates against the server without sending anything. */
  verify(): Promise<void>;
}

type SmtpConfig = { host: string; port: number; user: string; password: string; from: string };

export function readSmtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM } = env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;
  return {
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    user: SMTP_USER,
    password: SMTP_PASSWORD,
    from: EMAIL_FROM || SMTP_USER,
  };
}

// SMTP errors worth retrying: network failures and 4xx (temporary) server replies.
// Auth failures (535) and 5xx rejections are permanent.
const TRANSIENT_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "EDNS"]);
export function isTransientSmtpError(err: unknown) {
  const e = err as { code?: string; responseCode?: number };
  if (e?.responseCode) return e.responseCode >= 400 && e.responseCode < 500;
  return !!e?.code && TRANSIENT_CODES.has(e.code);
}

const recipientSchema = z.email();

export function createSmtpProvider(
  config: SmtpConfig,
  transport: Pick<Transporter, "sendMail" | "verify"> = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  }),
  { retries = 2, backoffMs = 500, authCooldownMs = 15 * 60_000 } = {},
): EmailProvider {
  // After the server rejects our credentials, stop trying for a while: repeated failed logins
  // can get a mailbox (e.g. Gmail) locked or flagged.
  let authFailedUntil = 0;
  return {
    get pausedUntil() {
      return authFailedUntil > Date.now() ? new Date(authFailedUntil) : null;
    },
    name: "smtp",
    async verify() {
      await transport.verify();
    },
    async send(message) {
      if (!recipientSchema.safeParse(message.to).success) {
        throw new AppError("VALIDATION", "Invalid recipient email address.");
      }
      if (Date.now() < authFailedUntil) {
        throw new AppError("PROVIDER_UNAVAILABLE", "Email is temporarily disabled because the mail server rejected the configured credentials.");
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const info = await transport.sendMail({ from: config.from, ...message });
          return { messageId: String(info.messageId) };
        } catch (err) {
          if (attempt < retries && isTransientSmtpError(err)) {
            await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
            continue;
          }
          const e = err as { code?: string; responseCode?: number };
          if (e.code === "EAUTH" || e.responseCode === 535) {
            authFailedUntil = Date.now() + authCooldownMs;
            console.error("[email] SMTP authentication failed; pausing email for", authCooldownMs / 60_000, "minutes. Check SMTP_USER/SMTP_PASSWORD (npm run email:verify).");
          } else {
            console.error("[email] send failed", { code: e.code });
          }
          throw new AppError("PROVIDER_UNAVAILABLE", "The email could not be sent. Please try again later.");
        }
      }
    },
  };
}

let cached: EmailProvider | null | undefined;

/** The configured email provider, or null when SMTP is not configured. */
export function getEmailProvider(): EmailProvider | null {
  if (cached === undefined) {
    const config = readSmtpConfig();
    cached = config ? createSmtpProvider(config) : null;
  }
  return cached;
}

export const isEmailConfigured = () => readSmtpConfig() !== null;

export async function sendEmail(message: EmailMessage) {
  const provider = getEmailProvider();
  if (!provider) {
    throw new AppError("NOT_CONFIGURED", "Email is not configured on this server, so the invitation was not sent by email.");
  }
  return provider.send(message);
}

/** Escape user-supplied text before putting it into an HTML email. */
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
