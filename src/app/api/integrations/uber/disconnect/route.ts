import { authed } from "@/server/http";
import { disconnectUber } from "@/server/services/uber";

export const POST = authed(async (_req, ctx) => disconnectUber(ctx));
