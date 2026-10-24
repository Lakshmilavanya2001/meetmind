import "server-only";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { requireMember } from "../auth/permissions";
import type { AuthContext } from "../auth/session";
import { sandboxCommerce } from "../providers/commerce/sandbox";
import { CINEMA_TZ, categoryOf, CATEGORIES, isSeat, parseShowId, priceSeats, ROWS, SEATS_PER_ROW, suggestSeats, takenSeats } from "../providers/commerce/movies";

import type { CabOption, CommerceProvider, FoodQuote } from "../providers/commerce/types";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole"> & { user: { timezone: string } };

let override: CommerceProvider | null = null;
export const getCommerce = () => override ?? sandboxCommerce;
export const setCommerceForTests = (p: CommerceProvider | null) => void (override = p);

export const SANDBOX_NOTE = "Sandbox — no real order is placed and nothing is charged.";
export const rupees = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
const MAX_ORDER_PAISE = 20_000_00;
const FOOD_CANCEL_WINDOW_MS = 5 * 60_000;

const place = z.string().trim().min(3, "Give a fuller address").max(200);
export const foodOrderSchema = z.object({
  restaurantId: z.string().min(1),
  items: z.array(z.object({ itemId: z.string().min(1), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
  address: place,
  notes: z.string().trim().max(200).optional(),
});
export const cabSchema = z.object({ pickup: place, drop: place, type: z.enum(["AUTO", "MINI", "SEDAN", "SUV"]), pickupAt: z.coerce.date().optional() });
export const tableSchema = z.object({ restaurantId: z.string().min(1), start: z.coerce.date(), partySize: z.number().int().min(1).max(12) });

const local = (d: Date, tz: string) => formatInTimeZone(d, tz, "EEE d MMM, HH:mm");

// ─── Food ────────────────────────────────────────────────────────────────
export async function quoteFoodOrder(ctx: Ctx, raw: unknown) {
  requireMember(ctx);
  const input = foodOrderSchema.parse(raw);
  const quote = await getCommerce().quoteFood(input.restaurantId, input.items);
  if (quote.totalPaise > MAX_ORDER_PAISE) throw new AppError("VALIDATION", `That order comes to ${rupees(quote.totalPaise)}, above the ${rupees(MAX_ORDER_PAISE)} limit.`);
  return { input, quote };
}

export function describeFoodQuote(q: FoodQuote, address: string) {
  const items = q.lines.map((l) => `${l.quantity}× ${l.name} (${rupees(l.totalPaise)})`).join(", ");
  return `Order from ${q.restaurant.name}: ${items}. Delivery ${rupees(q.deliveryFeePaise)}, taxes ${rupees(q.taxesPaise)}, total ${rupees(q.totalPaise)}, to “${address}”, in about ${q.etaMinutes} min. ${SANDBOX_NOTE}`;
}

export async function orderFood(ctx: Ctx, raw: unknown, meetingId?: string | null) {
  const { input, quote } = await quoteFoodOrder(ctx, raw);
  const placed = await getCommerce().placeFoodOrder(quote, input.address);
  const b = await db.booking.create({
    data: {
      organizationId: ctx.organizationId, userId: ctx.userId, kind: "FOOD", provider: getCommerce().name, reference: placed.reference,
      title: `Order from ${quote.restaurant.name}`, totalPaise: quote.totalPaise, scheduledFor: new Date(Date.now() + placed.etaMinutes * 60_000), meetingId: meetingId ?? null,
      details: { ...quote, address: input.address, notes: input.notes ?? null, sandbox: getCommerce().sandbox } as unknown as Prisma.InputJsonValue,
    },
  });
  await audit({ action: "booking.food", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Booking", targetId: b.id, metadata: { totalPaise: quote.totalPaise, provider: b.provider } });
  return { booking: view(b, ctx.user.timezone), etaMinutes: placed.etaMinutes };
}

// ─── Cabs ────────────────────────────────────────────────────────────────
export async function cabOptions(ctx: Ctx, pickup: string, drop: string) {
  requireMember(ctx);
  return getCommerce().quoteCab(place.parse(pickup), place.parse(drop));
}

function pickupTime(at: Date | undefined) {
  const now = Date.now();
  const t = at ?? new Date(now);
  if (t.getTime() < now - 2 * 60_000) throw new AppError("VALIDATION", "That pickup time has already passed.");
  if (t.getTime() > now + 7 * 86400_000) throw new AppError("VALIDATION", "Cabs can be booked up to 7 days ahead.");
  return t;
}

export async function quoteCab(ctx: Ctx, raw: unknown): Promise<{ input: z.infer<typeof cabSchema>; option: CabOption; pickupAt: Date }> {
  requireMember(ctx);
  const input = cabSchema.parse(raw);
  const pickupAt = pickupTime(input.pickupAt);
  const option = (await getCommerce().quoteCab(input.pickup, input.drop)).find((o) => o.type === input.type)!;
  return { input, option, pickupAt };
}

export function describeCab(o: CabOption, pickup: string, drop: string, pickupAt: Date, tz: string) {
  const when = pickupAt.getTime() - Date.now() < 5 * 60_000 ? `now (driver ~${o.pickupEtaMinutes} min away)` : local(pickupAt, tz);
  return `Book a ${o.label} from “${pickup}” to “${drop}”, pickup ${when}. About ${o.distanceKm} km, ~${o.tripMinutes} min, fare ${rupees(o.farePaise)}. ${SANDBOX_NOTE}`;
}

export async function bookCab(ctx: Ctx, raw: unknown, meetingId?: string | null) {
  const { input, option, pickupAt } = await quoteCab(ctx, raw);
  const r = await getCommerce().bookCab(option, input.pickup, input.drop, pickupAt);
  const b = await db.booking.create({
    data: {
      organizationId: ctx.organizationId, userId: ctx.userId, kind: "CAB", provider: getCommerce().name, reference: r.reference,
      title: `${option.label} to ${input.drop}`, totalPaise: option.farePaise, scheduledFor: pickupAt, meetingId: meetingId ?? null,
      details: { ...option, pickup: input.pickup, drop: input.drop, driver: r.driver, vehicle: r.vehicle, sandbox: getCommerce().sandbox } as unknown as Prisma.InputJsonValue,
    },
  });
  await audit({ action: "booking.cab", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Booking", targetId: b.id, metadata: { farePaise: option.farePaise } });
  return { booking: view(b, ctx.user.timezone), driver: r.driver, vehicle: r.vehicle };
}

// ─── Tables ──────────────────────────────────────────────────────────────
const takenFor = async (restaurantId: string, day: Date, tx: Prisma.TransactionClient = db) => {
  const rows = await tx.booking.findMany({
    where: { kind: "TABLE", status: "CONFIRMED", scheduledFor: { gte: new Date(day.getTime() - 86400_000), lte: new Date(day.getTime() + 2 * 86400_000) }, details: { path: ["restaurantId"], equals: restaurantId } },
    select: { scheduledFor: true },
  });
  return (start: Date) => rows.filter((r) => r.scheduledFor?.getTime() === start.getTime()).length;
};

export async function findTableSlots(ctx: Ctx, restaurantId: string, date: string, partySize: number) {
  requireMember(ctx);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("VALIDATION", "Date must be YYYY-MM-DD.");
  const commerce = getCommerce();
  const taken = await takenFor(restaurantId, new Date(`${date}T00:00:00Z`));
  const slots = await commerce.tableSlots(restaurantId, date, partySize, taken);
  const now = Date.now();
  return slots.filter((s) => s.start.getTime() > now + 30 * 60_000).map((s) => ({ start: s.start.toISOString(), local: local(s.start, commerce.timezone), available: s.available }));
}

export async function quoteTable(ctx: Ctx, raw: unknown, tx: Prisma.TransactionClient = db) {
  requireMember(ctx);
  const input = tableSchema.parse(raw);
  const commerce = getCommerce();
  const r = await commerce.getRestaurant(input.restaurantId);
  if (!r) throw new AppError("NOT_FOUND", "Unknown restaurant. Use search_restaurants to find one.");
  const date = formatInTimeZone(input.start, commerce.timezone, "yyyy-MM-dd");
  const slots = await commerce.tableSlots(r.id, date, input.partySize, await takenFor(r.id, input.start, tx));
  const slot = slots.find((s) => s.start.getTime() === input.start.getTime());
  if (!slot) throw new AppError("VALIDATION", `${r.name} has no seating at that time. Use find_table_slots to see the times.`);
  if (!slot.available) throw new AppError("CONFLICT", `${r.name} is full at ${local(input.start, commerce.timezone)}. Offer the user another slot from find_table_slots.`);
  if (input.start.getTime() < Date.now() + 30 * 60_000) throw new AppError("VALIDATION", "Tables must be booked at least 30 minutes ahead.");
  return { input, restaurant: r };
}

/** Restaurant-local time; the zone is named when it differs from the user's, so plans never look inconsistent. */
export const describeTable = (name: string, area: string, start: Date, party: number, tz: string, userTz?: string) =>
  `Reserve a table for ${party} at ${name} (${area}) on ${local(start, tz)}${userTz && userTz !== tz ? ` (${tz} time; ${formatInTimeZone(start, userTz, "HH:mm")} in ${userTz})` : ""}. ${SANDBOX_NOTE}`;

export async function reserveTable(ctx: Ctx, raw: unknown, meetingId?: string | null) {
  // Serialise reservations for the same restaurant and slot, then re-check capacity inside the lock.
  return db.$transaction(async (tx) => {
    const parsed = tableSchema.parse(raw);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`table:${parsed.restaurantId}:${parsed.start.toISOString()}`}))`;
    return reserveTableLocked(ctx, raw, meetingId, tx);
  });
}

async function reserveTableLocked(ctx: Ctx, raw: unknown, meetingId: string | null | undefined, tx: Prisma.TransactionClient) {
  const { input, restaurant } = await quoteTable(ctx, raw, tx);
  const r = await getCommerce().reserveTable(restaurant.id, input.start, input.partySize);
  const b = await tx.booking.create({
    data: {
      organizationId: ctx.organizationId, userId: ctx.userId, kind: "TABLE", provider: getCommerce().name, reference: r.reference,
      title: `Table for ${input.partySize} at ${restaurant.name}`, scheduledFor: input.start, meetingId: meetingId ?? null,
      details: { restaurantId: restaurant.id, restaurant: restaurant.name, area: restaurant.area, partySize: input.partySize, sandbox: getCommerce().sandbox } as unknown as Prisma.InputJsonValue,
    },
  });
  await audit({ action: "booking.table", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Booking", targetId: b.id });
  return { booking: view(b, getCommerce().timezone) };
}

// ─── Listing and cancelling ──────────────────────────────────────────────
type BookingRow = { id: string; kind: string; title: string; reference: string; status: string; provider: string; totalPaise: number | null; scheduledFor: Date | null; createdAt: Date; details: Prisma.JsonValue };
function view(b: BookingRow, tz: string) {
  return {
    id: b.id, kind: b.kind, title: b.title, reference: b.reference, status: b.status, provider: b.provider,
    sandbox: b.provider === "sandbox", total: b.totalPaise !== null ? rupees(b.totalPaise) : null,
    when: b.scheduledFor ? local(b.scheduledFor, tz) : null, scheduledFor: b.scheduledFor, createdAt: b.createdAt, details: b.details,
  };
}

export async function listBookings(ctx: Ctx) {
  const rows = await db.booking.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((b) => view(b, ctx.user.timezone));
}

export async function getOwnBooking(ctx: Ctx, id: string) {
  const b = await db.booking.findFirst({ where: { id, userId: ctx.userId } });
  if (!b) throw new AppError("NOT_FOUND", "No booking with that id.");
  return b;
}

export async function assertCancellable(ctx: Ctx, id: string) {
  const b = await getOwnBooking(ctx, id);
  if (b.status !== "CONFIRMED") throw new AppError("VALIDATION", "That booking is already cancelled.");
  const now = Date.now();
  if (b.kind === "FOOD" && now - b.createdAt.getTime() > FOOD_CANCEL_WINDOW_MS) throw new AppError("VALIDATION", "Food orders can only be cancelled within 5 minutes of ordering.");
  if (b.kind !== "FOOD" && b.scheduledFor && b.scheduledFor.getTime() < now) throw new AppError("VALIDATION", "That booking time has already passed.");
  return b;
}

export async function cancelBooking(ctx: Ctx, id: string) {
  const b = await assertCancellable(ctx, id);
  const r = await db.booking.updateMany({ where: { id: b.id, status: "CONFIRMED" }, data: { status: "CANCELED", canceledAt: new Date() } });
  if (!r.count) throw new AppError("VALIDATION", "That booking is already cancelled.");
  await audit({ action: "booking.cancel", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Booking", targetId: b.id });
  return { canceled: true, title: b.title, reference: b.reference };
}

// ─── Movies (sandbox cinemas) ────────────────────────────────────────────

export const movieSchema = z.object({ showId: z.string().min(10).max(80), seats: z.array(z.string().trim().toUpperCase()).min(1).max(10) });

async function bookedSeats(showId: string, tx: Prisma.TransactionClient = db) {
  const rows = await tx.booking.findMany({ where: { kind: "MOVIE", status: "CONFIRMED", details: { path: ["showId"], equals: showId } }, select: { details: true } });
  return rows.flatMap((r) => ((r.details as { seats?: string[] }).seats ?? []));
}

/** Free seats for a show, grouped by category with prices, plus a suggested block. */
export async function movieSeatMap(ctx: Ctx, showId: string, count = 2) {
  requireMember(ctx);
  const show = parseShowId(showId);
  const taken = takenSeats(show.id, await bookedSeats(show.id));
  const categories = CATEGORIES.map((c) => ({
    name: c.name,
    price: rupees(c.pricePaise),
    rows: c.rows.split("").map((r) => ({ row: r, free: Array.from({ length: SEATS_PER_ROW }, (_, i) => `${r}${i + 1}`).filter((s) => !taken.has(s)) })),
  }));
  return {
    show: { id: show.id, film: show.movie.title, cinema: show.cinema.name, area: show.cinema.area, when: local(show.start, CINEMA_TZ), screenAt: "row A" },
    freeSeats: ROWS.length * SEATS_PER_ROW - taken.size,
    categories,
    suggestion: suggestSeats(taken, Math.min(10, Math.max(1, count))),
    taken: [...taken],
  };
}

export async function quoteMovie(ctx: Ctx, raw: unknown, tx: Prisma.TransactionClient = db) {
  requireMember(ctx);
  const input = movieSchema.parse(raw);
  const show = parseShowId(input.showId);
  if (show.start.getTime() < Date.now() + 15 * 60_000) throw new AppError("VALIDATION", "Booking for this show has closed.");
  const seats = [...new Set(input.seats)];
  const bad = seats.filter((s) => !isSeat(s));
  if (bad.length) throw new AppError("VALIDATION", `${bad.join(", ")} isn't a seat (rows A–J, seats 1–${SEATS_PER_ROW}).`);
  const taken = takenSeats(show.id, await bookedSeats(show.id, tx));
  const gone = seats.filter((s) => taken.has(s));
  if (gone.length) throw new AppError("CONFLICT", `${gone.join(", ")} ${gone.length > 1 ? "are" : "is"} already taken. Use get_seat_map to pick free seats.`);
  return { show, seats, price: priceSeats(seats) };
}

export function describeMovie(q: Awaited<ReturnType<typeof quoteMovie>>) {
  const cats = [...new Set(q.seats.map((s) => categoryOf(s).name))].join(" + ");
  return `Book ${q.seats.length} ticket${q.seats.length > 1 ? "s" : ""} for ${q.show.movie.title} (${q.show.movie.language}, ${q.show.movie.certificate}) at ${q.show.cinema.name}, ${q.show.cinema.area}, ${local(q.show.start, CINEMA_TZ)} — seats ${q.seats.join(", ")} (${cats}): tickets ${rupees(q.price.ticketsPaise)} + fees ${rupees(q.price.feePaise)} = ${rupees(q.price.totalPaise)}. ${SANDBOX_NOTE}`;
}

export async function bookMovie(ctx: Ctx, raw: unknown, meetingId?: string | null) {
  return db.$transaction(async (tx) => {
    const parsed = movieSchema.parse(raw);
    // One sale at a time per show, so two people can't buy the same seat.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`movie:${parsed.showId}`}))`;
    const q = await quoteMovie(ctx, raw, tx);
    const reference = `MV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const b = await tx.booking.create({
      data: {
        organizationId: ctx.organizationId, userId: ctx.userId, kind: "MOVIE", provider: "sandbox", reference,
        title: `${q.seats.length} × ${q.show.movie.title} at ${q.show.cinema.name}`, totalPaise: q.price.totalPaise, scheduledFor: q.show.start, meetingId: meetingId ?? null,
        details: { showId: q.show.id, film: q.show.movie.title, cinema: q.show.cinema.name, area: q.show.cinema.area, seats: q.seats, ticketsPaise: q.price.ticketsPaise, feePaise: q.price.feePaise, sandbox: true } as unknown as Prisma.InputJsonValue,
      },
    });
    await audit({ action: "booking.movie", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Booking", targetId: b.id, metadata: { seats: q.seats.length } });
    return { booking: view(b, CINEMA_TZ), seats: q.seats };
  });
}
