import { authed } from "@/server/http";
import { getMeetingDetails } from "@/server/services/meetings";

export const GET = authed<{ ref: string }>(async (_req, ctx, { ref }) => getMeetingDetails(ctx, ref));
