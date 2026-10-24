import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { createSampleCall } from "@/server/services/meetings";

// POST — creates an ended sample call to transcribe the bundled recording into.
export const POST = authed(async (_req, ctx) => {
  rateLimit(`sample-call:${ctx.userId}`, 10, 3600_000);
  const m = await createSampleCall(ctx);
  return { joinCode: m.joinCode };
});
