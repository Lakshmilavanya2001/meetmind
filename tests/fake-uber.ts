import { vi } from "vitest";

// A stand-in for Uber (auth + Riders API sandbox) and the geocoder, answering as they do.
type Ride = { status: string };
export const uber = {
  fare: 250,
  rides: new Map<string, Ride>(),
  tokens: [] as string[], // Authorization headers seen
  refreshed: 0,
  revoked: 0,
  expiresIn: 3600,
  failToken: false,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(input: string | URL | Request, init?: RequestInit, passThrough?: typeof fetch): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  const auth = new Headers(init?.headers).get("authorization");
  if (url.host === "geo.test") {
    const q = url.searchParams.get("q") ?? "";
    if (/nowhere/i.test(q)) return json([]);
    return json([{ lat: q.includes("Airport") ? "13.1986" : "12.9733", lon: q.includes("Airport") ? "77.7066" : "77.6405", display_name: q }]);
  }
  if (url.host === "auth.uber.test") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (url.pathname === "/oauth/v2/revoke") return uber.revoked++, json({});
    if (body.get("client_secret") !== "s3cret") return json({ error: "invalid_client" }, 401);
    if (body.get("grant_type") === "authorization_code") {
      if (body.get("code") !== "good-code" || body.get("redirect_uri") !== "https://meet.test/api/integrations/uber/callback") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "A1", refresh_token: "R1", expires_in: uber.expiresIn, scope: "ride_request.estimate ride_request.ride_booking" });
    }
    if (body.get("grant_type") === "refresh_token") {
      if (uber.failToken) return json({ error: "invalid_grant" }, 400);
      uber.refreshed++;
      return json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 });
    }
  }
  if (url.host === "api.uber.test") {
    uber.tokens.push(auth ?? "");
    if (!auth?.startsWith("Bearer A")) return json({ message: "Invalid OAuth 2.0 credentials" }, 401);
    const p = url.pathname;
    if (p === "/v1.2/products") return json({ products: [{ product_id: "go", display_name: "UberGo", capacity: 4 }, { product_id: "premier", display_name: "Premier", capacity: 4 }] });
    if (p === "/v1.2/estimates/price") return json({ prices: [{ product_id: "go", display_name: "UberGo", estimate: "₹240-290", duration: 2400, distance: 21.4 }, { product_id: "premier", display_name: "Premier", estimate: "₹380-450", duration: 2400, distance: 21.4 }] });
    if (p === "/v1.2/estimates/time") return json({ times: [{ product_id: "go", estimate: 240 }] });
    if (p === "/v1.2/requests/estimate") return json({ fare: { fare_id: `fare-${uber.fare}`, value: uber.fare, display: `₹${uber.fare}`, currency_code: "INR" }, trip: { duration_estimate: 2400 }, pickup_estimate: 4 });
    if (p === "/v1.2/requests" && method === "POST") {
      const id = `req-${uber.rides.size + 1}-abcdef`;
      uber.rides.set(id, { status: "processing" });
      return json({ request_id: id, status: "processing" }, 202);
    }
    const ride = /^\/v1\.2\/requests\/([^/]+)$/.exec(p);
    if (ride) {
      const r = uber.rides.get(ride[1]);
      if (!r) return json({ message: "not found" }, 404);
      if (method === "DELETE") return (r.status = "rider_canceled"), new Response(null, { status: 204 });
      const assigned = !["processing", "no_drivers_available", "rider_canceled"].includes(r.status);
      return json({ request_id: ride[1], status: r.status, driver: assigned ? { name: "Ravi", rating: 4.9 } : null, vehicle: assigned ? { make: "Maruti", model: "Dzire", license_plate: "KA01AB1234" } : null, pickup: { eta: assigned ? 3 : null } });
    }
    const sb = /^\/v1\/sandbox\/requests\/([^/]+)$/.exec(p);
    if (sb && method === "PUT") {
      uber.rides.get(sb[1])!.status = JSON.parse(String(init?.body)).status;
      return new Response(null, { status: 204 });
    }
  }
  if (passThrough) return passThrough(input, init);
  return json({ message: `unexpected ${method} ${url}` }, 500);
}

/** Point the Uber client and the geocoder at the fake. Other hosts (e.g. a real LLM) pass through when `passThrough` is set. */
export function useFakeUber(opts: { passThrough?: boolean } = {}) {
  Object.assign(uber, { fare: 250, rides: new Map(), tokens: [], refreshed: 0, revoked: 0, expiresIn: 3600, failToken: false });
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (i: string | URL | Request, init?: RequestInit) => fakeFetch(i, init, opts.passThrough ? real : undefined));
  vi.stubEnv("UBER_CLIENT_ID", "cid");
  vi.stubEnv("UBER_CLIENT_SECRET", "s3cret");
  vi.stubEnv("UBER_ENV", "sandbox");
  vi.stubEnv("UBER_API_URL", "https://api.uber.test");
  vi.stubEnv("UBER_AUTH_URL", "https://auth.uber.test");
  vi.stubEnv("GEOCODER_URL", "https://geo.test");
}

