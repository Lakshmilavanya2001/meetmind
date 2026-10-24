import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { AppError, isAppError } from "./errors";
import { resolveSession, SESSION_COOKIE, type AuthContext } from "./auth/session";

/**
 * Client IP for rate limiting and audit logs. X-Forwarded-For is client-controlled, so it is only
 * trusted when TRUST_PROXY=true, and then only the right-most entry (the one our own proxy appended).
 */
export function clientIp(req: NextRequest) {
  if (process.env.TRUST_PROXY !== "true") return null;
  const hops = req.headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  return hops.at(-1) ?? req.headers.get("x-real-ip");
}

export const isHttps = (req: NextRequest) =>
  (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "")) === "https";

/**
 * WebSocket URL browsers should use for LiveKit. Behind the HTTPS proxy we use the same
 * origin (the proxy routes /rtc to LiveKit); otherwise LIVEKIT_PUBLIC_URL or LIVEKIT_URL.
 */
export function livekitPublicUrl(req: NextRequest) {
  if (process.env.LIVEKIT_PUBLIC_URL) return process.env.LIVEKIT_PUBLIC_URL;
  if (isHttps(req)) return `wss://${req.headers.get("x-forwarded-host") ?? req.headers.get("host")}`;
  return process.env.LIVEKIT_URL ?? "ws://localhost:7880";
}

export function errorResponse(err: unknown) {
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION",
          message: err.issues[0]?.message ?? "Invalid input",
          fields: Object.fromEntries(err.issues.map((i) => [i.path.join("."), i.message])),
        },
      },
      { status: 400 },
    );
  }
  if (isAppError(err)) {
    // `details` is only ever data we constructed ourselves (e.g. scheduling conflicts), never raw internals.
    return NextResponse.json(
      { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
      { status: err.status },
    );
  }
  // Never leak internals (stack traces, SQL, secrets) to the client.
  console.error("[api] unhandled error", err);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong. Please try again." } },
    { status: 500 },
  );
}

/** Reject cross-site state-changing requests (defence in depth on top of SameSite=Lax cookies). */
function assertSameOrigin(req: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (new URL(origin).host !== host) throw new AppError("FORBIDDEN", "Cross-origin request rejected.");
}

/** Read the request body as a stream, aborting once it exceeds `maxBytes` (Content-Length can't be trusted). */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new AppError("VALIDATION", "Request is too large.");
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AppError("VALIDATION", "Request is too large.");
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

const MAX_JSON_BYTES = 1_100_000; // transcript imports are the largest JSON bodies (1 MB)

export async function readJson(req: NextRequest): Promise<unknown> {
  const body = await readBodyLimited(req, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new AppError("VALIDATION", "Request body must be valid JSON.");
  }
}

type Handler<P> = (req: NextRequest, ctx: AuthContext, params: P) => Promise<Response | object | void>;
type PublicHandler<P> = (req: NextRequest, params: P) => Promise<Response | object | void>;

const toResponse = (result: Response | object | void) =>
  result instanceof Response ? result : NextResponse.json(result ?? { ok: true });

/** Wrap an authenticated route handler. */
export function authed<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }) => {
    try {
      assertSameOrigin(req);
      const ctx = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
      if (!ctx) throw new AppError("UNAUTHENTICATED", "Please sign in.");
      return toResponse(await handler(req, ctx, await routeCtx.params));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Wrap a route handler that does not require a session (login, signup, health). */
export function open<P = Record<string, never>>(handler: PublicHandler<P>) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }) => {
    try {
      assertSameOrigin(req);
      return toResponse(await handler(req, await routeCtx.params));
    } catch (err) {
      return errorResponse(err);
    }
  };
}
