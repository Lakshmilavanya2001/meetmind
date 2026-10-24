import { authed } from "@/server/http";
import { listBookings } from "@/server/services/bookings";

// Bookings are made through the assistant (with confirmation); this lists your own.
export const GET = authed(async (_req, ctx) => ({ bookings: await listBookings(ctx) }));
