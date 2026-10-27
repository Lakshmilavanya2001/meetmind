import { authed } from "@/server/http";
import { advanceTestRide } from "@/server/services/uber";

// Uber test mode only: move your ride to its next stage (for demos).
export const POST = authed<{ id: string }>(async (_req, ctx, { id }) => advanceTestRide(ctx, id));
