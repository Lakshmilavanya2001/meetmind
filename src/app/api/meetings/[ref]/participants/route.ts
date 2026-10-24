import { authed } from "@/server/http";
import { listLiveParticipants } from "@/server/services/meetings";

export const GET = authed<{ ref: string }>(async (_req, ctx, { ref }) => ({
  participants: await listLiveParticipants(ctx, ref),
}));
