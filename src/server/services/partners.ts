import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "../db";
import { AppError } from "../errors";
import type { AuthContext } from "../auth/session";
import { SANDBOX_RESTAURANTS } from "../providers/commerce/sandbox";
import { CINEMA_TZ, CINEMAS, MOVIES, parseShowId, ROWS, SEATS_PER_ROW, takenSeats } from "../providers/commerce/movies";
import { rupees } from "./bookings";

/**
 * Sandbox partner portals: what the restaurant and the cinema "see" when the agent submits an order.
 * They show only the signed-in user's own orders (it's a demo of the hand-off, not a real merchant
 * system), and the order lifecycle runs on an accelerated clock so a demo shows every stage.
 */
type Ctx = Pick<AuthContext, "userId" | "organizationId">;
export type Stage = { name: string; at: string | null; done: boolean };

const FOOD_STAGES: [string, number][] = [["Order received", 0], ["Accepted by the restaurant", 15], ["Being prepared", 45], ["Out for delivery", 120], ["Delivered", 240]];

export function foodStages(createdAt: Date, canceledAt: Date | null, now = Date.now()): Stage[] {
  const stages = FOOD_STAGES.map(([name, s]) => {
    const t = createdAt.getTime() + s * 1000;
    const done = t <= now && (!canceledAt || t <= canceledAt.getTime());
    return { name, at: done ? new Date(t).toISOString() : null, done };
  });
  if (canceledAt) stages.push({ name: "Cancelled by the customer", at: canceledAt.toISOString(), done: true });
  return stages;
}

export function movieStages(createdAt: Date, show: Date, minutes: number, canceledAt: Date | null, now = Date.now()): Stage[] {
  const at = (t: number, ok = true) => ({ at: ok && t <= now ? new Date(t).toISOString() : null, done: ok && t <= now });
  const end = show.getTime() + minutes * 60_000;
  const stages = [
    { name: "Booking received", ...at(createdAt.getTime()) },
    { name: "Seats blocked and tickets issued", ...at(createdAt.getTime() + 5000, !canceledAt) },
    { name: "Showtime", ...at(show.getTime(), !canceledAt) },
    { name: "Show finished", ...at(end, !canceledAt) },
  ];
  if (canceledAt) stages.push({ name: "Cancelled, seats released", at: canceledAt.toISOString(), done: true });
  return stages;
}

export async function foodPortal(ctx: Ctx, restaurantId: string) {
  const r = SANDBOX_RESTAURANTS.find((x) => x.id === restaurantId);
  if (!r) throw new AppError("NOT_FOUND", "Unknown restaurant.");
  const orders = await db.booking.findMany({
    where: { userId: ctx.userId, organizationId: ctx.organizationId, kind: "FOOD", details: { path: ["restaurant", "id"], equals: r.id } },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return {
    restaurant: { id: r.id, name: r.name, area: r.area },
    orders: orders.map((o) => {
      const d = o.details as { lines: { name: string; quantity: number; totalPaise: number }[]; address: string; notes: string | null; subtotalPaise: number; deliveryFeePaise: number; taxesPaise: number };
      return {
        id: o.id, reference: o.reference, receivedAt: o.createdAt, status: o.status,
        items: d.lines.map((l) => ({ name: l.name, quantity: l.quantity, total: rupees(l.totalPaise) })),
        address: d.address, notes: d.notes, subtotal: rupees(d.subtotalPaise), delivery: rupees(d.deliveryFeePaise), taxes: rupees(d.taxesPaise), total: rupees(o.totalPaise ?? 0),
        stages: foodStages(o.createdAt, o.canceledAt),
      };
    }),
  };
}

export async function cinemaPortal(ctx: Ctx, cinemaId: string) {
  const c = CINEMAS.find((x) => x.id === cinemaId);
  if (!c) throw new AppError("NOT_FOUND", "Unknown cinema.");
  const rows = await db.booking.findMany({ where: { userId: ctx.userId, organizationId: ctx.organizationId, kind: "MOVIE" }, orderBy: { createdAt: "desc" }, take: 60 });
  const mine = rows.filter((b) => (b.details as { showId: string }).showId.startsWith(`${c.id}~`)).slice(0, 20);
  return {
    cinema: c,
    bookings: mine.map((b) => {
      const d = b.details as { showId: string; seats: string[]; ticketsPaise: number; feePaise: number };
      const show = parseShowId(d.showId);
      const taken = takenSeats(d.showId, []);
      return {
        id: b.id, reference: b.reference, receivedAt: b.createdAt, status: b.status,
        film: show.movie.title, language: show.movie.language, certificate: show.movie.certificate,
        when: formatInTimeZone(show.start, CINEMA_TZ, "EEE d MMM, HH:mm"), seats: d.seats,
        tickets: rupees(d.ticketsPaise), fees: rupees(d.feePaise), total: rupees(b.totalPaise ?? 0),
        // Hall layout for the portal: this booking's seats vs. seats sold to others.
        hall: ROWS.map((r) => Array.from({ length: SEATS_PER_ROW }, (_, i) => `${r}${i + 1}`).map((s) => (d.seats.includes(s) ? "mine" : taken.has(s) ? "sold" : "free"))),
        stages: movieStages(b.createdAt, show.start, show.movie.minutes, b.canceledAt),
      };
    }),
  };
}

export const partnerDirectory = () => ({
  restaurants: SANDBOX_RESTAURANTS.filter((r) => r.delivery).map((r) => ({ id: r.id, name: r.name, area: r.area, cuisine: r.cuisine.join(", ") })),
  cinemas: CINEMAS.map((c) => ({ ...c, films: MOVIES.length })),
});
