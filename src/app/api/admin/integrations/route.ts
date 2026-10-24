import { authed } from "@/server/http";
import { getIntegrationStatus } from "@/server/services/integrations";

export const GET = authed(async (_req, ctx) => ({ checks: await getIntegrationStatus(ctx) }));
