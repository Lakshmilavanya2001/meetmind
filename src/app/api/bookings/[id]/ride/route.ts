import { authed } from "@/server/http";
import { getRideStatus } from "@/server/services/uber";

// The live status of your own Uber ride (refreshed from Uber).
export const GET = authed<{ id: string }>(async (_req, ctx, { id }) => getRideStatus(ctx, id));
