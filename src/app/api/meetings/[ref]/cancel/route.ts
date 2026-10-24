import { authed } from "@/server/http";
import { cancelMeeting } from "@/server/services/scheduling";

export const POST = authed<{ ref: string }>(async (_req, ctx, { ref }) => cancelMeeting(ctx, ref));
