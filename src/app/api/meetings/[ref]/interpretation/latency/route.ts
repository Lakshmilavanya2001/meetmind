import { authed } from "@/server/http";
import { getLatencyReport } from "@/server/services/interpretation";

export const GET = authed<{ ref: string }>(async (_req, ctx, { ref }) => getLatencyReport(ctx, ref));
