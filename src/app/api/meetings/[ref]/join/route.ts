import { authed, livekitPublicUrl } from "@/server/http";
import { joinMeeting } from "@/server/services/meetings";
import { rateLimit } from "@/server/rate-limit";

// POST /api/meetings/:ref/join — returns a short-lived LiveKit token for the caller.
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => {
  rateLimit(`meeting:join:${ctx.userId}`, 60, 60_000);
  return joinMeeting(ctx, ref, { publicUrl: livekitPublicUrl(req) });
});
