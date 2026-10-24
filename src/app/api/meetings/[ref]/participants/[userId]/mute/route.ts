import { authed } from "@/server/http";
import { muteParticipant } from "@/server/services/meetings";

export const POST = authed<{ ref: string; userId: string }>(async (_req, ctx, { ref, userId }) =>
  muteParticipant(ctx, ref, userId),
);
