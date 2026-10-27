import { authed } from "@/server/http";
import { getUberStatus } from "@/server/services/uber";

export const GET = authed(async (_req, ctx) => getUberStatus(ctx));
