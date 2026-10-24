import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getCaptions } from "@/server/services/translation";

type P = { ref: string };

// GET ?lang=hi|original — the last few lines said in the meeting, translated for the viewer. Polled every ~1.5 s.
export const GET = authed<P>(async (req, ctx, { ref }) => {
  rateLimit(`captions:${ctx.userId}`, 120, 60_000);
  return getCaptions(ctx, ref, Object.fromEntries(req.nextUrl.searchParams));
});
