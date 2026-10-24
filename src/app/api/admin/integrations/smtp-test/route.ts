import { authed } from "@/server/http";
import { testEmailLogin } from "@/server/services/integrations";

export const POST = authed(async (_req, ctx) => testEmailLogin(ctx));
