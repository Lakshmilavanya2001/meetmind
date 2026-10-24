import "server-only";

export type SmsSendResult = { status: "SENT" | "OUTBOX"; providerId?: string };

export interface SmsProvider {
  /** "twilio" sends real texts; "outbox" only records them (development). */
  readonly name: "twilio" | "outbox";
  send(to: string, body: string): Promise<SmsSendResult>;
}

type TwilioConfig = { accountSid: string; authToken: string; from: string };

export function readTwilioConfig(env: Record<string, string | undefined> = process.env): TwilioConfig | null {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) return null;
  return { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, from: TWILIO_FROM };
}

export class SmsError extends Error {}

/** Twilio Programmable Messaging via its REST API (no SDK needed). TWILIO_FROM is a number or a Messaging Service SID. */
export function createTwilioProvider(config: TwilioConfig, fetchImpl: typeof fetch = fetch): SmsProvider {
  return {
    name: "twilio",
    async send(to, body) {
      const form = new URLSearchParams({ To: to, Body: body });
      if (config.from.startsWith("MG")) form.set("MessagingServiceSid", config.from);
      else form.set("From", config.from);
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
      if (!res.ok) throw new SmsError(`Twilio ${res.status}${data.code ? ` (${data.code})` : ""}: ${data.message ?? "send failed"}`);
      return { status: "SENT", providerId: data.sid };
    },
  };
}

/**
 * Development only: nothing leaves the server; messages (including verification codes) appear in
 * Settings → Text messages. Enabled only by SMS_DEV_OUTBOX=true, because showing a code to the person
 * who requested it means they can "verify" any number.
 */
export const outboxProvider: SmsProvider = { name: "outbox", send: async () => ({ status: "OUTBOX" }) };

let override: SmsProvider | null = null;
/** Twilio when configured; the dev outbox only when explicitly enabled; otherwise SMS is off (null). */
export function getSmsProvider(env: Record<string, string | undefined> = process.env): SmsProvider | null {
  if (override) return override;
  const c = readTwilioConfig(env);
  if (c) return createTwilioProvider(c);
  return env.SMS_DEV_OUTBOX === "true" ? outboxProvider : null;
}

/** Destinations we will text, as E.164 prefixes (SMS_ALLOWED_PREFIXES, default India only). "*" allows all. */
export function smsDestinationAllowed(to: string, env: Record<string, string | undefined> = process.env) {
  const list = (env.SMS_ALLOWED_PREFIXES ?? "+91").split(",").map((x) => x.trim()).filter(Boolean);
  return list.includes("*") || list.some((p) => to.startsWith(p));
}
export function setSmsProviderForTests(p: SmsProvider | null) {
  override = p;
}
