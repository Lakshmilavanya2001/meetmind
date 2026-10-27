import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { requireOrgRole } from "../auth/permissions";
import type { AuthContext } from "../auth/session";
import { rateLimit } from "../rate-limit";
import { getEmailProvider, readSmtpConfig } from "../providers/email";
import { readUberConfig } from "../providers/uber";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole">;
export type CheckStatus = "ok" | "error" | "not_configured";
export type Check = { id: string; name: string; status: CheckStatus; detail: string; required: boolean };

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

async function probeModels(name: string, id: string, baseUrl: string | undefined, model: string | undefined, apiKey: string | undefined, required: boolean): Promise<Check> {
  if (!baseUrl || !model) return { id, name, status: "not_configured", detail: "Not configured.", required };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined, signal: withTimeout(5000) });
    if (!res.ok) return { id, name, status: "error", detail: `Endpoint returned HTTP ${res.status}.`, required };
    const data = (await res.json()) as { data?: { id: string }[] };
    const listed = data.data?.some((m) => m.id === model);
    return listed
      ? { id, name, status: "ok", detail: `Model ${model} is available.`, required }
      : { id, name, status: "error", detail: `Endpoint is up but doesn't list model ${model}.`, required };
  } catch (err) {
    return { id, name, status: "error", detail: `Unreachable: ${(err as Error).message}`, required };
  }
}

/** Live status of every external dependency (workspace admins only). Never returns secrets. */
export async function getIntegrationStatus(ctx: Ctx): Promise<Check[]> {
  requireOrgRole(ctx, "ADMIN");
  const env = process.env;
  const checks: Promise<Check>[] = [
    db.$queryRaw`SELECT 1`.then(
      (): Check => ({ id: "database", name: "PostgreSQL", status: "ok", detail: "Connected.", required: true }),
      (e): Check => ({ id: "database", name: "PostgreSQL", status: "error", detail: (e as Error).message, required: true }),
    ),
    (async (): Promise<Check> => {
      const url = env.LIVEKIT_URL;
      if (!url || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return { id: "livekit", name: "LiveKit (calls)", status: "not_configured", detail: "Not configured.", required: true };
      try {
        const res = await fetch(url.replace(/^ws/, "http"), { signal: withTimeout(5000) });
        return res.ok ? { id: "livekit", name: "LiveKit (calls)", status: "ok", detail: "Server reachable.", required: true } : { id: "livekit", name: "LiveKit (calls)", status: "error", detail: `HTTP ${res.status}`, required: true };
      } catch (err) {
        return { id: "livekit", name: "LiveKit (calls)", status: "error", detail: `Unreachable: ${(err as Error).message}`, required: true };
      }
    })(),
    probeModels("AI assistant (LLM)", "llm", env.LLM_BASE_URL, env.LLM_MODEL, env.LLM_API_KEY, false),
    probeModels("Transcript search (embeddings)", "embeddings", env.EMBEDDING_BASE_URL, env.EMBEDDING_MODEL, env.EMBEDDING_API_KEY, false),
    probeModels("Transcription (speech-to-text)", "stt", env.STT_BASE_URL, env.STT_MODEL, env.STT_API_KEY, false),
    Promise.resolve((): Check => {
      const smtp = readSmtpConfig();
      if (!smtp) return { id: "email", name: "Email (SMTP)", status: "not_configured", detail: "Not configured — invitations are delivered in-app only.", required: false };
      const paused = getEmailProvider()?.pausedUntil;
      return paused
        ? { id: "email", name: "Email (SMTP)", status: "error", detail: `The mail server rejected the credentials; sending is paused until ${paused.toISOString()}. Fix SMTP_USER/SMTP_PASSWORD.`, required: false }
        : { id: "email", name: "Email (SMTP)", status: "ok", detail: `Configured for ${smtp.user} via ${smtp.host}:${smtp.port} (login not tested automatically).`, required: false };
    }).then((f) => f()),
    Promise.resolve<Check>(((): Check => {
      const u = readUberConfig();
      if (!u) return { id: "uber", name: "Uber rides", status: "not_configured", detail: "Optional. Not configured — cab bookings use the sandbox. Set UBER_CLIENT_ID and UBER_CLIENT_SECRET.", required: false };
      return { id: "uber", name: "Uber rides", status: "ok", detail: `${u.env === "sandbox" ? "Test mode (no real cars)" : "PRODUCTION: real rides"}. Each user connects their own Uber account in their profile. Sign-in returns to ${u.redirectUri}.`, required: false };
    })()),
    Promise.resolve<Check>({
      id: "teams",
      name: "Microsoft Teams connector",
      status: "not_configured",
      detail: env.MS_CLIENT_ID
        ? "Azure credentials are present, but the Teams connector is not implemented yet — see docs/TEAMS_CONNECTOR.md."
        : "Optional. Disabled — see docs/TEAMS_CONNECTOR.md for the Azure app registration it needs.",
      required: false,
    }),
  ];
  return Promise.all(checks);
}

/** Admin-triggered SMTP login test (not automatic: repeated failures can lock a mailbox). */
export async function testEmailLogin(ctx: Ctx) {
  requireOrgRole(ctx, "ADMIN");
  rateLimit(`smtp-test:${ctx.organizationId}`, 3, 60 * 60 * 1000);
  const provider = getEmailProvider();
  if (!provider) throw new AppError("NOT_CONFIGURED", "SMTP is not configured.");
  try {
    await provider.verify();
    await audit({ action: "integration.smtp_test", actorUserId: ctx.userId, organizationId: ctx.organizationId, metadata: { ok: true } });
    return { ok: true, message: "SMTP login succeeded." };
  } catch (err) {
    await audit({ action: "integration.smtp_test", actorUserId: ctx.userId, organizationId: ctx.organizationId, metadata: { ok: false } });
    const e = err as { code?: string; responseCode?: number };
    return { ok: false, message: e.code === "EAUTH" || e.responseCode === 535 ? "The mail server rejected the username/password." : `SMTP login failed (${e.code ?? "error"}).` };
  }
}
