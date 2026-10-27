import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { requireMember } from "../auth/permissions";
import type { AuthContext } from "../auth/session";
import { decryptJson, encryptJson } from "../crypto";
import { geocode } from "../providers/geocode";
import {
  authorizeUrl, cancelRide, createRide, exchangeCode, getFareEstimate, getPriceEstimates, getProducts, getRide, getTimeEstimates,
  readUberConfig, refreshTokens, requireUberConfig, revokeToken, RIDE_FINAL, RIDE_LABEL, SANDBOX_STAGES, setSandboxRideStatus,
  type LatLng, type UberConfig, type UberRide,
} from "../providers/uber";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole"> & { user: { timezone: string } };
type Stored = { accessToken: string; refreshToken: string | null };

export const UBER_STATE_COOKIE = "mm_uber_state";
export const UBER_TEST_NOTE = "Uber test mode — no real car comes and nothing is charged.";
const noteFor = (c: UberConfig) => (c.env === "sandbox" ? UBER_TEST_NOTE : "This books a REAL Uber ride, charged to your Uber account.");
const providerName = (c: UberConfig) => (c.env === "sandbox" ? "uber-sandbox" : "uber");
const place = z.string().trim().min(3, "Give a fuller address").max(200);

// ─── Connection ──────────────────────────────────────────────────────────
const findConnection = (ctx: Ctx) =>
  db.integrationConnection.findUnique({ where: { organizationId_provider_userId: { organizationId: ctx.organizationId, provider: "UBER", userId: ctx.userId } } });

export async function getUberStatus(ctx: Ctx) {
  const c = readUberConfig();
  const conn = c ? await findConnection(ctx) : null;
  return {
    configured: !!c,
    env: c?.env ?? null,
    connected: conn?.status === "ACTIVE",
    needsReconnect: conn?.status === "ERROR",
    connectedAt: conn?.status === "ACTIVE" ? conn.updatedAt : null,
  };
}

/** Starts "Connect Uber": the state is kept in a short-lived cookie and checked on the way back. */
export function startUberConnect(ctx: Ctx) {
  requireMember(ctx);
  const c = requireUberConfig();
  const state = randomBytes(24).toString("base64url");
  return { url: authorizeUrl(c, state), state };
}

export async function finishUberConnect(ctx: Ctx, code: string) {
  requireMember(ctx);
  const c = requireUberConfig();
  const t = await exchangeCode(c, code);
  const data = {
    status: "ACTIVE" as const,
    encryptedCredentials: encryptJson({ accessToken: t.accessToken, refreshToken: t.refreshToken } satisfies Stored),
    scopes: t.scopes,
    expiresAt: t.expiresAt,
    config: { env: c.env },
  };
  await db.integrationConnection.upsert({
    where: { organizationId_provider_userId: { organizationId: ctx.organizationId, provider: "UBER", userId: ctx.userId } },
    create: { organizationId: ctx.organizationId, userId: ctx.userId, provider: "UBER", ...data },
    update: data,
  });
  await audit({ action: "integration.uber_connect", actorUserId: ctx.userId, organizationId: ctx.organizationId, metadata: { env: c.env, scopes: t.scopes } });
  return { connected: true, scopes: t.scopes };
}

export async function disconnectUber(ctx: Ctx) {
  const conn = await findConnection(ctx);
  if (!conn) return { connected: false };
  const c = readUberConfig();
  if (c && conn.encryptedCredentials) {
    try {
      await revokeToken(c, decryptJson<Stored>(conn.encryptedCredentials).accessToken);
    } catch {
      /* the stored token is unreadable: deleting it is enough */
    }
  }
  await db.integrationConnection.delete({ where: { id: conn.id } });
  await audit({ action: "integration.uber_disconnect", actorUserId: ctx.userId, organizationId: ctx.organizationId });
  return { connected: false };
}

/** A valid access token for the user, refreshed when it's about to expire. */
async function accessToken(ctx: Ctx): Promise<{ c: UberConfig; token: string }> {
  const c = requireUberConfig();
  const conn = await findConnection(ctx);
  if (!conn || conn.status === "DISABLED" || !conn.encryptedCredentials) throw new AppError("VALIDATION", "Uber isn't connected. Connect it in Settings → Profile.", { reason: "UBER_NOT_CONNECTED" });
  if (conn.status === "ERROR") throw new AppError("VALIDATION", "The Uber login has expired. Reconnect Uber in Settings → Profile.", { reason: "UBER_NOT_CONNECTED" });
  const stored = decryptJson<Stored>(conn.encryptedCredentials);
  if (!conn.expiresAt || conn.expiresAt.getTime() > Date.now() + 60_000) return { c, token: stored.accessToken };
  if (!stored.refreshToken) {
    await db.integrationConnection.update({ where: { id: conn.id }, data: { status: "ERROR" } });
    throw new AppError("VALIDATION", "The Uber login has expired. Reconnect Uber in Settings → Profile.", { reason: "UBER_NOT_CONNECTED" });
  }
  try {
    const t = await refreshTokens(c, stored.refreshToken);
    await db.integrationConnection.update({
      where: { id: conn.id },
      data: { encryptedCredentials: encryptJson({ accessToken: t.accessToken, refreshToken: t.refreshToken } satisfies Stored), expiresAt: t.expiresAt, ...(t.scopes.length ? { scopes: t.scopes } : {}) },
    });
    return { c, token: t.accessToken };
  } catch (err) {
    if (err instanceof AppError && err.code === "PROVIDER_UNAVAILABLE") throw err; // Uber unreachable: keep the login
    await db.integrationConnection.update({ where: { id: conn.id }, data: { status: "ERROR" } });
    throw new AppError("VALIDATION", "The Uber login has expired. Reconnect Uber in Settings → Profile.", { reason: "UBER_NOT_CONNECTED" });
  }
}

export async function isUberConnected(ctx: Ctx) {
  return !!readUberConfig() && (await findConnection(ctx))?.status === "ACTIVE";
}

// ─── Fares ───────────────────────────────────────────────────────────────
async function locate(label: string, value: string): Promise<LatLng> {
  const g = await geocode(place.parse(value));
  if (!g) throw new AppError("VALIDATION", `Couldn't find the ${label} “${value}” on the map. Ask the user for a fuller address (area and city).`);
  return { lat: g.lat, lng: g.lng };
}
const route = async (pickup: string, drop: string) => {
  const start = await locate("pickup point", pickup);
  const end = await locate("drop-off point", drop);
  return { start, end };
};

export async function uberOptions(ctx: Ctx, pickup: string, drop: string) {
  requireMember(ctx);
  const { c, token } = await accessToken(ctx);
  const { start, end } = await route(pickup, drop);
  const [products, prices, times] = await Promise.all([
    getProducts(c, token, start),
    getPriceEstimates(c, token, start, end),
    getTimeEstimates(c, token, start).catch(() => []),
  ]);
  const options = products.map((p) => {
    const price = prices.find((x) => x.product_id === p.product_id);
    const eta = times.find((x) => x.product_id === p.product_id);
    return {
      product_id: p.product_id,
      name: p.display_name,
      seats: p.capacity ?? null,
      fare: price?.estimate ?? null,
      surge: price?.surge_multiplier && price.surge_multiplier > 1 ? price.surge_multiplier : null,
      pickupEtaMin: eta ? Math.round(eta.estimate / 60) : null,
      tripMin: price?.duration ? Math.round(price.duration / 60) : null,
      distanceKm: price?.distance ? Math.round(price.distance * 1.609 * 10) / 10 : null,
    };
  });
  return { env: c.env, note: noteFor(c), options };
}

/** Fares shown in a confirmation, so booking can't silently cost more than what the user agreed to. */
const quotes = new Map<string, { value: number; display: string; at: number }>();
const QUOTE_TTL_MS = 15 * 60_000;
const quoteKey = (ctx: Ctx, productId: string, pickup: string, drop: string) => [ctx.userId, productId, pickup.trim().toLowerCase(), drop.trim().toLowerCase()].join("|");

export const uberRideSchema = z.object({ pickup: place, drop: place, productId: z.string().min(1).max(100) });

export async function quoteUberRide(ctx: Ctx, raw: unknown) {
  requireMember(ctx);
  const input = uberRideSchema.parse(raw);
  const { c, token } = await accessToken(ctx);
  const { start, end } = await route(input.pickup, input.drop);
  const [est, products] = await Promise.all([getFareEstimate(c, token, input.productId, start, end), getProducts(c, token, start)]);
  const product = products.find((p) => p.product_id === input.productId);
  if (!product) throw new AppError("VALIDATION", "That Uber option isn't available at this pickup. Use get_uber_options for the current ones.");
  const fare = est.fare?.display ?? est.estimate?.display ?? "fare shown in Uber";
  if (est.fare) {
    const k = quoteKey(ctx, input.productId, input.pickup, input.drop);
    if (quotes.size > 5000) quotes.clear();
    quotes.set(k, { value: est.fare.value, display: est.fare.display, at: Date.now() });
  }
  return { c, token, input, start, end, product, est, fare };
}

export function describeUberRide(q: Awaited<ReturnType<typeof quoteUberRide>>) {
  const eta = q.est.pickup_estimate ? `, driver ~${q.est.pickup_estimate} min away` : "";
  const trip = q.est.trip?.duration_estimate ? `, ~${Math.round(q.est.trip.duration_estimate / 60)} min trip` : "";
  return `Book an Uber ${q.product.display_name} from “${q.input.pickup}” to “${q.input.drop}”, pickup now${eta}${trip}. Fare ${q.fare}. ${noteFor(q.c)}`;
}

export async function bookUberRide(ctx: Ctx, raw: unknown, meetingId?: string | null) {
  const input = uberRideSchema.parse(raw);
  const agreed = quotes.get(quoteKey(ctx, input.productId, input.pickup, input.drop));
  if (!agreed || Date.now() - agreed.at > QUOTE_TTL_MS) throw new AppError("CONFLICT", "That fare has expired. Ask to book the ride again to see the current fare.");
  // Fares (and their fare_id) expire after a couple of minutes: get a fresh one and hold it to what was agreed.
  const q = await quoteUberRide(ctx, input);
  if (q.est.fare && q.est.fare.value > agreed.value * 1.1 + 1)
    throw new AppError("CONFLICT", `The Uber fare went up from ${agreed.display} to ${q.est.fare.display}. Ask the user whether to book at the new fare.`);
  const ride = await createRide(q.c, q.token, input.productId, q.est.fare?.fare_id, q.start, q.end);
  quotes.delete(quoteKey(ctx, input.productId, input.pickup, input.drop));
  const b = await db.booking.create({
    data: {
      organizationId: ctx.organizationId, userId: ctx.userId, kind: "CAB", provider: providerName(q.c), reference: ride.request_id,
      title: `Uber ${q.product.display_name} to ${input.drop}`, totalPaise: q.est.fare && q.est.fare.currency_code === "INR" ? Math.round(q.est.fare.value * 100) : null,
      scheduledFor: new Date(), meetingId: meetingId ?? null,
      details: {
        uber: true, env: q.c.env, productId: input.productId, product: q.product.display_name, pickup: input.pickup, drop: input.drop,
        start: q.start, end: q.end, fare: q.fare, rideStatus: ride.status ?? "processing", sandbox: q.c.env === "sandbox",
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await audit({ action: "booking.cab", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Booking", targetId: b.id, metadata: { provider: b.provider, fare: q.fare } });
  return { booking: b, ride: rideView(ride), note: noteFor(q.c) };
}

// ─── Ride status ─────────────────────────────────────────────────────────
type RideDetails = { uber?: boolean; env?: string; rideStatus?: string; driver?: unknown; vehicle?: unknown; etaMin?: number | null } & Record<string, unknown>;

export const isUberBooking = (b: { provider: string }) => b.provider === "uber" || b.provider === "uber-sandbox";

function rideView(r: UberRide) {
  return {
    status: r.status,
    label: RIDE_LABEL[r.status] ?? r.status,
    driver: r.driver?.name ? `${r.driver.name}${r.driver.rating ? ` (★ ${r.driver.rating})` : ""}` : null,
    vehicle: r.vehicle ? [r.vehicle.make, r.vehicle.model, r.vehicle.license_plate].filter(Boolean).join(" ") || null : null,
    etaMin: r.pickup?.eta ?? r.eta ?? null,
    final: RIDE_FINAL.has(r.status),
  };
}

async function ownUberBooking(ctx: Ctx, id: string) {
  const b = await db.booking.findFirst({ where: { id, userId: ctx.userId } });
  if (!b || !isUberBooking(b)) throw new AppError("NOT_FOUND", "No Uber ride with that id.");
  return b;
}

async function saveRide(id: string, details: RideDetails, v: ReturnType<typeof rideView>) {
  const next = { ...details, rideStatus: v.status, driver: v.driver, vehicle: v.vehicle, etaMin: v.etaMin };
  const canceled = v.status === "rider_canceled" || v.status === "driver_canceled" || v.status === "no_drivers_available";
  await db.booking.update({
    where: { id },
    data: { details: next as unknown as Prisma.InputJsonValue, ...(canceled ? { status: "CANCELED", canceledAt: new Date() } : {}) },
  });
}

export async function getRideStatus(ctx: Ctx, bookingId: string) {
  requireMember(ctx);
  const b = await ownUberBooking(ctx, bookingId);
  const details = b.details as RideDetails;
  if (details.rideStatus && RIDE_FINAL.has(details.rideStatus)) {
    return { title: b.title, status: details.rideStatus, label: RIDE_LABEL[details.rideStatus] ?? details.rideStatus, driver: details.driver ?? null, vehicle: details.vehicle ?? null, etaMin: null, final: true };
  }
  const { c, token } = await accessToken(ctx);
  const v = rideView(await getRide(c, token, b.reference));
  await saveRide(b.id, details, v);
  return { title: b.title, ...v };
}

/** Test mode only: move the ride to its next stage (Uber's sandbox never does it by itself). */
export async function advanceTestRide(ctx: Ctx, bookingId: string) {
  requireMember(ctx);
  const b = await ownUberBooking(ctx, bookingId);
  if (b.provider !== "uber-sandbox") throw new AppError("FORBIDDEN", "Only Uber test-mode rides can be moved along by hand.");
  const { c, token } = await accessToken(ctx);
  const current = (await getRide(c, token, b.reference)).status;
  const i = SANDBOX_STAGES.indexOf(current as (typeof SANDBOX_STAGES)[number]);
  if (i < 0 || i === SANDBOX_STAGES.length - 1) throw new AppError("VALIDATION", `The ride is ${RIDE_LABEL[current] ?? current}: there's no next stage.`);
  await setSandboxRideStatus(c, token, b.reference, SANDBOX_STAGES[i + 1]);
  const v = rideView(await getRide(c, token, b.reference));
  await saveRide(b.id, b.details as RideDetails, v);
  return { title: b.title, ...v };
}

/** Called by cancelBooking for Uber rides: cancels with Uber first. */
export async function cancelUberRide(ctx: Ctx, b: { id: string; reference: string; details: Prisma.JsonValue }) {
  const details = b.details as RideDetails;
  if (details.rideStatus && RIDE_FINAL.has(details.rideStatus)) throw new AppError("VALIDATION", `That ride is already ${RIDE_LABEL[details.rideStatus]?.toLowerCase() ?? "over"}.`);
  if (details.rideStatus === "in_progress") throw new AppError("VALIDATION", "That ride is already under way. It can only be ended in the Uber app.");
  const { c, token } = await accessToken(ctx);
  await cancelRide(c, token, b.reference);
  await db.booking.update({ where: { id: b.id }, data: { details: { ...details, rideStatus: "rider_canceled" } as unknown as Prisma.InputJsonValue } });
}

/** Tests only. */
export const resetUberQuotes = () => quotes.clear();
