import { authed } from "@/server/http";
import { cancelBooking } from "@/server/services/bookings";

export const POST = authed<{ id: string }>(async (_req, ctx, { id }) => cancelBooking(ctx, id));
