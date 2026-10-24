import { authed } from "@/server/http";
import { regenerateJoinCode } from "@/server/services/organization";

export const POST = authed(async (_req, ctx) => ({ joinCode: await regenerateJoinCode(ctx) }));
