import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getLatestSummary, summarizeMeeting } from "@/server/services/summaries";

type P = { ref: string };

export const GET = authed<P>(async (_req, ctx, { ref }) => ({ summary: await getLatestSummary(ctx, ref) }));

export const POST = authed<P>(async (_req, ctx, { ref }) => {
  rateLimit(`summary:${ctx.userId}`, 10, 60_000);
  rateLimit(`summary-hourly:${ctx.userId}`, 30, 60 * 60_000);
  return { summary: await summarizeMeeting(ctx, ref) };
});
