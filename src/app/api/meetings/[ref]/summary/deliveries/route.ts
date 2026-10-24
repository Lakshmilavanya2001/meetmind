import { authed } from "@/server/http";
import { getDeliveries } from "@/server/services/summary-delivery";

// GET — who received the latest summary, by which channel, and when.
export const GET = authed<{ ref: string }>(async (_req, ctx, { ref }) => getDeliveries(ctx, ref));
