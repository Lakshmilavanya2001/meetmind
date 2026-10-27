import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import { db } from "@/server/db";
import { SESSION_COOKIE } from "@/server/auth/session";
import { resetGeocodeCache } from "@/server/providers/geocode";
import {
  advanceTestRide, bookUberRide, describeUberRide, disconnectUber, finishUberConnect, getRideStatus, getUberStatus, quoteUberRide,
  resetUberQuotes, startUberConnect, UBER_STATE_COOKIE, uberOptions,
} from "@/server/services/uber";
import { cancelBooking, listBookings } from "@/server/services/bookings";
import { TOOL_BY_NAME } from "@/server/ai/tools";
import { GET as callback } from "@/app/api/integrations/uber/callback/route";
import { GET as connect } from "@/app/api/integrations/uber/connect/route";
import { createOrg, createUser, loginAs, resetDb } from "../helpers";
import { uber, useFakeUber } from "../fake-uber";

beforeEach(async () => {
  await resetDb();
  resetGeocodeCache();
  resetUberQuotes();
  useFakeUber();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => vi.unstubAllGlobals());

async function setup() {
  const org = await createOrg();
  const mk = async (name: string) => {
    const u = await createUser(org.id, name, { timezone: "Asia/Kolkata" });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, email: u.email, displayName: name, timezone: "Asia/Kolkata" } };
  };
  return { org, aisha: await mk("Aisha Khan"), priya: await mk("Priya Patel") };
}
const ROUTE = { pickup: "Indiranagar, Bengaluru", drop: "Kempegowda Airport" };

describe("Connect Uber", () => {
  it("not configured: says so, and the assistant falls back to the sandbox", async () => {
    vi.stubEnv("UBER_CLIENT_ID", "");
    const { aisha } = await setup();
    expect(await getUberStatus(aisha)).toMatchObject({ configured: false, connected: false });
    expect(() => startUberConnect(aisha)).toThrow(/isn't set up/);
    const out = await TOOL_BY_NAME.get("get_uber_options")!.run({ auth: aisha } as never, ROUTE);
    expect(out.data).toMatchObject({ connected: false });
    expect(JSON.stringify(out.data)).toMatch(/get_cab_options/);
  });

  it("connects through Uber sign-in: state must match the same user's cookie; tokens are stored encrypted", async () => {
    const { org, aisha, priya } = await setup();
    const { token } = await loginAs(aisha.userId, org.id);
    const res = await connect(new NextRequest("https://meet.test/api/integrations/uber/connect", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), { params: Promise.resolve({}) });
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://auth.uber.test/oauth/v2/authorize");
    expect(to.searchParams.get("scope")).toBe("ride_request.estimate ride_request.ride_booking");
    expect(to.searchParams.get("redirect_uri")).toBe("https://meet.test/api/integrations/uber/callback");
    const state = to.searchParams.get("state")!;
    const cookie = (res as NextResponse).cookies.get(UBER_STATE_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax" });

    const back = (q: string, stateCookie = cookie.value, session = token) =>
      callback(new NextRequest(`https://meet.test/api/integrations/uber/callback?${q}`, { headers: { cookie: `${SESSION_COOKIE}=${session}; ${UBER_STATE_COOKIE}=${stateCookie}` } }), { params: Promise.resolve({}) });
    // A different state (e.g. a link from another site) or another user's session is refused.
    expect((await back(`code=good-code&state=forged`)).headers.get("location")).toMatch(/uber=expired/);
    const other = await loginAs(priya.userId, org.id);
    expect((await back(`code=good-code&state=${state}`, cookie.value, other.token)).headers.get("location")).toMatch(/uber=expired/);
    expect((await back(`error=access_denied&state=${state}`)).headers.get("location")).toMatch(/uber=denied/);
    expect(await getUberStatus(aisha)).toMatchObject({ connected: false });

    expect((await back(`code=good-code&state=${state}`)).headers.get("location")).toBe("https://meet.test/settings/profile?uber=connected");
    expect(await getUberStatus(aisha)).toMatchObject({ configured: true, env: "sandbox", connected: true });
    const row = await db.integrationConnection.findFirstOrThrow({ where: { userId: aisha.userId, provider: "UBER" } });
    expect(row.encryptedCredentials).not.toContain("A1");
    expect(row.encryptedCredentials).not.toContain("R1");
    expect(row.scopes).toEqual(["ride_request.estimate", "ride_request.ride_booking"]);
    expect(await getUberStatus(priya)).toMatchObject({ connected: false });
  });

  it("refreshes an expiring login; a refused refresh asks the user to reconnect; disconnect revokes and deletes", async () => {
    const { aisha } = await setup();
    uber.expiresIn = 30; // expires within a minute
    await finishUberConnect(aisha, "good-code");
    await uberOptions(aisha, ROUTE.pickup, ROUTE.drop);
    expect(uber.refreshed).toBe(1);
    expect(uber.tokens.at(-1)).toBe("Bearer A2");

    await db.integrationConnection.updateMany({ data: { expiresAt: new Date() } });
    uber.failToken = true;
    await expect(uberOptions(aisha, ROUTE.pickup, ROUTE.drop)).rejects.toThrow(/Reconnect Uber/);
    expect(await getUberStatus(aisha)).toMatchObject({ connected: false, needsReconnect: true });

    await disconnectUber(aisha);
    expect(uber.revoked).toBe(1);
    expect(await db.integrationConnection.count()).toBe(0);
  });
});

describe("Uber rides (test mode)", () => {
  it("real options and fares for the route", async () => {
    const { aisha } = await setup();
    await expect(uberOptions(aisha, ROUTE.pickup, ROUTE.drop)).rejects.toThrow(/isn't connected/);
    await finishUberConnect(aisha, "good-code");
    const r = await uberOptions(aisha, ROUTE.pickup, ROUTE.drop);
    expect(r.env).toBe("sandbox");
    expect(r.note).toMatch(/test mode/);
    expect(r.options[0]).toEqual({ product_id: "go", name: "UberGo", seats: 4, fare: "₹240-290", surge: null, pickupEtaMin: 4, tripMin: 40, distanceKm: 34.4 });
    await expect(uberOptions(aisha, "Nowhere land", ROUTE.drop)).rejects.toThrow(/Couldn't find the pickup point/);
  });

  it("books only after a quote, holds the fare, then follows the ride stage by stage and lists it", async () => {
    const { aisha } = await setup();
    await finishUberConnect(aisha, "good-code");
    const args = { ...ROUTE, productId: "go" };
    await expect(bookUberRide(aisha, args)).rejects.toThrow(/fare has expired/);

    const q = await quoteUberRide(aisha, args);
    expect(describeUberRide(q)).toBe("Book an Uber UberGo from “Indiranagar, Bengaluru” to “Kempegowda Airport”, pickup now, driver ~4 min away, ~40 min trip. Fare ₹250. Uber test mode — no real car comes and nothing is charged.");
    uber.fare = 400; // went up while the user was deciding
    await expect(bookUberRide(aisha, args)).rejects.toThrow(/went up from ₹250 to ₹400/);
    uber.fare = 260; // within 10%
    await quoteUberRide(aisha, { ...args, productId: "go" }).then(() => (uber.fare = 265));
    const { booking, ride } = await bookUberRide(aisha, args);
    expect(booking).toMatchObject({ provider: "uber-sandbox", kind: "CAB", title: "Uber UberGo to Kempegowda Airport", totalPaise: 26500 });
    expect(ride).toMatchObject({ status: "processing", label: "Finding a driver" });

    expect(await getRideStatus(aisha, booking.id)).toMatchObject({ label: "Finding a driver", driver: null });
    expect(await advanceTestRide(aisha, booking.id)).toMatchObject({ status: "accepted", label: "Driver on the way", driver: "Ravi (★ 4.9)", vehicle: "Maruti Dzire KA01AB1234", etaMin: 3 });
    expect(await advanceTestRide(aisha, booking.id)).toMatchObject({ status: "arriving" });

    const [listed] = await listBookings(aisha);
    expect(listed).toMatchObject({ uber: true, uberTest: true, sandbox: false, total: "₹265", ride: { status: "arriving", label: "Driver arriving", driver: "Ravi (★ 4.9)" } });

    await advanceTestRide(aisha, booking.id);
    await expect(cancelBooking(aisha, booking.id)).rejects.toThrow(/already under way/);
    await advanceTestRide(aisha, booking.id);
    await expect(advanceTestRide(aisha, booking.id)).rejects.toThrow(/no next stage/);
    expect(await getRideStatus(aisha, booking.id)).toMatchObject({ status: "completed", final: true });
  });

  it("cancels with Uber; other users can't see or touch the ride", async () => {
    const { aisha, priya } = await setup();
    await finishUberConnect(aisha, "good-code");
    await quoteUberRide(aisha, { ...ROUTE, productId: "go" });
    const { booking } = await bookUberRide(aisha, { ...ROUTE, productId: "go" });
    await expect(getRideStatus(priya, booking.id)).rejects.toThrow(/No Uber ride/);
    await expect(advanceTestRide(priya, booking.id)).rejects.toThrow(/No Uber ride/);
    await expect(cancelBooking(priya, booking.id)).rejects.toThrow(/No booking/);

    await cancelBooking(aisha, booking.id);
    expect(uber.rides.get(booking.reference)!.status).toBe("rider_canceled");
    const b = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.status).toBe("CANCELED");
    expect(b.details).toMatchObject({ rideStatus: "rider_canceled" });
    await expect(cancelBooking(aisha, booking.id)).rejects.toThrow(/already cancelled/);
  });

  it("moving a ride along by hand is refused outside test mode", async () => {
    const { aisha } = await setup();
    await finishUberConnect(aisha, "good-code");
    await quoteUberRide(aisha, { ...ROUTE, productId: "go" });
    const { booking } = await bookUberRide(aisha, { ...ROUTE, productId: "go" });
    await db.booking.update({ where: { id: booking.id }, data: { provider: "uber" } });
    await expect(advanceTestRide(aisha, booking.id)).rejects.toThrow(/Only Uber test-mode rides/);
  });
});
