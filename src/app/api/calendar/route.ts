import { z } from "zod";
import { authed } from "@/server/http";
import { listMyCalendar } from "@/server/services/calendar";

// GET /api/calendar?start=ISO&end=ISO — the caller's own calendar.
export const GET = authed(async (req, ctx) => {
  const { start, end } = z
    .object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) })
    .parse(Object.fromEntries(req.nextUrl.searchParams));
  return { events: await listMyCalendar(ctx, new Date(start), new Date(end)) };
});
