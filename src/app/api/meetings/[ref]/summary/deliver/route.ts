import { authed } from "@/server/http";
import { sendSummaryNow } from "@/server/services/summary-delivery";

// POST — host or co-host sends (or resends) the latest summary to everyone in the call.
export const POST = authed<{ ref: string }>(async (_req, ctx, { ref }) => sendSummaryNow(ctx, ref));
