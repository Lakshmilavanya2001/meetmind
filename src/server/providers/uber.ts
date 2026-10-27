import "server-only";
import { AppError } from "../errors";

/**
 * Uber Riders API (v1.2) client. https://developer.uber.com/docs/riders/references/api
 *
 * - Each user connects their own Uber account (OAuth 2.0 authorization code). While the Uber app is in development,
 *   only its owner and up to 5 listed developers can connect; that's enough for a demo.
 * - UBER_ENV=sandbox (the default) sends ride requests to sandbox-api.uber.com: no real car comes and nothing is
 *   charged, but fares and products are real. Sandbox rides don't move on their own: setSandboxRideStatus does it.
 * - UBER_ENV=production books real rides. It needs Uber's approval of the app and an explicit setting.
 */
export const UBER_SCOPES = ["ride_request.estimate", "ride_request.ride_booking"];
export type UberEnv = "sandbox" | "production";

export type UberConfig = {
  clientId: string;
  clientSecret: string;
  env: UberEnv;
  apiBase: string;
  authBase: string;
  redirectUri: string;
};

export function readUberConfig(env: Record<string, string | undefined> = process.env): UberConfig | null {
  const clientId = env.UBER_CLIENT_ID?.trim();
  const clientSecret = env.UBER_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const mode: UberEnv = env.UBER_ENV?.trim() === "production" ? "production" : "sandbox";
  const app = (env.APP_URL ?? "").replace(/\/$/, "");
  return {
    clientId,
    clientSecret,
    env: mode,
    apiBase: (env.UBER_API_URL?.trim() || (mode === "production" ? "https://api.uber.com" : "https://sandbox-api.uber.com")).replace(/\/$/, ""),
    authBase: (env.UBER_AUTH_URL?.trim() || "https://auth.uber.com").replace(/\/$/, ""),
    redirectUri: env.UBER_REDIRECT_URI?.trim() || `${app}/api/integrations/uber/callback`,
  };
}

export function requireUberConfig() {
  const c = readUberConfig();
  if (!c) throw new AppError("NOT_CONFIGURED", "Uber isn't set up on this server (UBER_CLIENT_ID and UBER_CLIENT_SECRET).");
  return c;
}

export type UberTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date; scopes: string[] };

const TIMEOUT_MS = 10_000;

/** Uber's error body → a message safe to show (never tokens or raw internals). */
async function uberError(res: Response, what: string): Promise<AppError> {
  let code = "";
  let message = "";
  try {
    const b = (await res.json()) as { code?: string; message?: string; error?: string; errors?: { code?: string; title?: string }[] };
    code = b.code ?? b.errors?.[0]?.code ?? b.error ?? "";
    message = b.message ?? b.errors?.[0]?.title ?? "";
  } catch {
    /* not JSON */
  }
  const detail = message ? `: ${message.slice(0, 200)}` : "";
  if (res.status === 401) return new AppError("FORBIDDEN", `Uber didn't accept this account's login (${what}). Reconnect Uber in Settings → Profile.`, { reason: "UBER_AUTH" });
  if (res.status === 403) return new AppError("FORBIDDEN", `Uber refused ${what}${detail}. The Uber app may lack the ride permissions, or this account isn't one of its developers.`, { reason: "UBER_FORBIDDEN" });
  if (res.status === 404) return new AppError("NOT_FOUND", `Uber has no such ride or product (${what}).`);
  if (res.status === 409 && /surge/i.test(code + message)) return new AppError("CONFLICT", `Uber has surge pricing right now${detail}. Surge rides must be confirmed in the Uber app.`, { reason: "UBER_SURGE" });
  if (res.status === 409 || res.status === 422) return new AppError("CONFLICT", `Uber couldn't do ${what}${detail}.`, { reason: code || "UBER_CONFLICT" });
  if (res.status === 429) return new AppError("RATE_LIMITED", "Uber is limiting requests right now. Try again in a minute.");
  return new AppError("PROVIDER_UNAVAILABLE", `Uber didn't answer properly (${what}, HTTP ${res.status}).`);
}

async function call<T>(c: UberConfig, token: string, method: string, path: string, body?: object, what = "the request"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Accept-Language": "en_US", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppError("PROVIDER_UNAVAILABLE", `Couldn't reach Uber (${what}).`);
  }
  if (!res.ok) throw await uberError(res, what);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── OAuth ───────────────────────────────────────────────────────────────
export function authorizeUrl(c: UberConfig, state: string) {
  const q = new URLSearchParams({ client_id: c.clientId, response_type: "code", scope: UBER_SCOPES.join(" "), redirect_uri: c.redirectUri, state });
  return `${c.authBase}/oauth/v2/authorize?${q}`;
}

async function tokenRequest(c: UberConfig, params: Record<string, string>): Promise<UberTokens> {
  let res: Response;
  try {
    res = await fetch(`${c.authBase}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppError("PROVIDER_UNAVAILABLE", "Couldn't reach Uber's sign-in server.");
  }
  // invalid_grant / invalid_client: the code or refresh token was refused, so the user must sign in again.
  if (res.status === 400 || res.status === 401) throw new AppError("FORBIDDEN", "Uber refused the sign-in. Connect Uber again in Settings → Profile.", { reason: "UBER_AUTH" });
  if (!res.ok) throw await uberError(res, "signing in");
  const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!t.access_token) throw new AppError("PROVIDER_UNAVAILABLE", "Uber's sign-in server returned no access token.");
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? params.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
    scopes: (t.scope ?? "").split(/[\s,]+/).filter(Boolean),
  };
}

export const exchangeCode = (c: UberConfig, code: string) => tokenRequest(c, { grant_type: "authorization_code", redirect_uri: c.redirectUri, code });
export const refreshTokens = (c: UberConfig, refreshToken: string) => tokenRequest(c, { grant_type: "refresh_token", refresh_token: refreshToken });

export async function revokeToken(c: UberConfig, token: string) {
  await fetch(`${c.authBase}/oauth/v2/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});
}

// ─── Rides ───────────────────────────────────────────────────────────────
export type LatLng = { lat: number; lng: number };
export type UberProduct = { product_id: string; display_name: string; capacity?: number; description?: string; upfront_fare_enabled?: boolean };
export type UberPriceEstimate = { product_id: string; display_name: string; estimate?: string; low_estimate?: number | null; high_estimate?: number | null; currency_code?: string | null; duration?: number; distance?: number; surge_multiplier?: number };
export type UberTimeEstimate = { product_id: string; estimate: number };
export type UberFareEstimate = {
  fare?: { fare_id: string; value: number; display: string; currency_code: string; expires_at?: number };
  estimate?: { display?: string; surge_multiplier?: number; surge_confirmation_href?: string };
  trip?: { distance_estimate?: number; distance_unit?: string; duration_estimate?: number };
  pickup_estimate?: number | null;
};
export type UberRide = {
  request_id: string;
  status: string;
  product_id?: string;
  eta?: number | null;
  surge_multiplier?: number;
  driver?: { name?: string; phone_number?: string; rating?: number } | null;
  vehicle?: { make?: string; model?: string; license_plate?: string } | null;
  pickup?: { eta?: number | null } | null;
  destination?: { eta?: number | null } | null;
};

const coords = (start: LatLng, end?: LatLng) => {
  const q = new URLSearchParams({ start_latitude: String(start.lat), start_longitude: String(start.lng) });
  if (end) q.set("end_latitude", String(end.lat)), q.set("end_longitude", String(end.lng));
  return q;
};

export async function getProducts(c: UberConfig, token: string, at: LatLng) {
  const r = await call<{ products?: UberProduct[] }>(c, token, "GET", `/v1.2/products?${new URLSearchParams({ latitude: String(at.lat), longitude: String(at.lng) })}`, undefined, "listing ride options");
  return r.products ?? [];
}
export async function getPriceEstimates(c: UberConfig, token: string, start: LatLng, end: LatLng) {
  return (await call<{ prices?: UberPriceEstimate[] }>(c, token, "GET", `/v1.2/estimates/price?${coords(start, end)}`, undefined, "estimating fares")).prices ?? [];
}
export async function getTimeEstimates(c: UberConfig, token: string, start: LatLng) {
  return (await call<{ times?: UberTimeEstimate[] }>(c, token, "GET", `/v1.2/estimates/time?${coords(start)}`, undefined, "estimating pickup times")).times ?? [];
}
const rideBody = (productId: string, start: LatLng, end: LatLng) => ({ product_id: productId, start_latitude: start.lat, start_longitude: start.lng, end_latitude: end.lat, end_longitude: end.lng });

/** The upfront fare for one product (fare_id is needed to book, and expires after a couple of minutes). */
export const getFareEstimate = (c: UberConfig, token: string, productId: string, start: LatLng, end: LatLng) =>
  call<UberFareEstimate>(c, token, "POST", "/v1.2/requests/estimate", rideBody(productId, start, end), "getting the fare");
export const createRide = (c: UberConfig, token: string, productId: string, fareId: string | undefined, start: LatLng, end: LatLng) =>
  call<UberRide>(c, token, "POST", "/v1.2/requests", { ...rideBody(productId, start, end), ...(fareId ? { fare_id: fareId } : {}) }, "booking the ride");
export const getRide = (c: UberConfig, token: string, requestId: string) => call<UberRide>(c, token, "GET", `/v1.2/requests/${encodeURIComponent(requestId)}`, undefined, "checking the ride");
export const cancelRide = (c: UberConfig, token: string, requestId: string) => call<void>(c, token, "DELETE", `/v1.2/requests/${encodeURIComponent(requestId)}`, undefined, "cancelling the ride");

/** Sandbox ride stages, in the order Uber requires (driver_canceled may be set at any time). */
export const SANDBOX_STAGES = ["processing", "accepted", "arriving", "in_progress", "completed"] as const;
export async function setSandboxRideStatus(c: UberConfig, token: string, requestId: string, status: string) {
  if (c.env !== "sandbox") throw new AppError("FORBIDDEN", "Rides can only be moved along by hand in Uber test mode.");
  await call<void>(c, token, "PUT", `/v1/sandbox/requests/${encodeURIComponent(requestId)}`, { status }, "moving the test ride along");
}

/** Statuses after which a ride is over. */
export const RIDE_FINAL = new Set(["completed", "rider_canceled", "driver_canceled", "no_drivers_available"]);
export const RIDE_LABEL: Record<string, string> = {
  processing: "Finding a driver",
  no_drivers_available: "No drivers available",
  accepted: "Driver on the way",
  arriving: "Driver arriving",
  in_progress: "On the trip",
  driver_canceled: "Cancelled by the driver",
  rider_canceled: "Cancelled",
  completed: "Completed",
};
