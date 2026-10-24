import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { createInstantMeeting, listMyMeetings } from "@/server/services/meetings";
import { rateLimit } from "@/server/rate-limit";

export const GET = authed(async (req, ctx) => {
  const { scope, limit, q } = z
    .object({
      scope: z.enum(["upcoming", "recent", "canceled"]).default("upcoming"),
      limit: z.coerce.number().int().min(1).max(50).default(10),
      q: z.string().trim().max(100).optional(),
    })
    .parse(Object.fromEntries(req.nextUrl.searchParams));
  return { meetings: await listMyMeetings(ctx, { scope, limit, q: q || undefined }) };
});

// POST /api/meetings — start an instant meeting. Use /api/meetings/schedule for future meetings.
export const POST = authed(async (req, ctx) => {
  rateLimit(`meeting:create:${ctx.userId}`, 120, 60 * 60 * 1000);
  const body = z.object({ title: z.string().trim().max(120).optional() }).parse(await readJson(req).catch(() => ({})));
  return { meeting: await createInstantMeeting(ctx, body) };
});
