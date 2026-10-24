import { authed } from "@/server/http";
import { endMeeting } from "@/server/services/meetings";

export const POST = authed<{ ref: string }>(async (_req, ctx, { ref }) => {
  await endMeeting(ctx, ref);
  return { ok: true };
});
