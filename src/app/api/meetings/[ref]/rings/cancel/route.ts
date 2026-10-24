import { authed } from "@/server/http";
import { cancelRings } from "@/server/services/calls";

export const POST = authed<{ ref: string }>(async (_req, ctx, { ref }) => cancelRings(ctx, ref));
