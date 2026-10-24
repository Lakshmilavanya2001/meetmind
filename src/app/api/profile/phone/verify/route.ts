import { authed, readJson } from "@/server/http";
import { confirmPhoneVerification } from "@/server/services/sms";

// POST { code }
export const POST = authed(async (req, ctx) => confirmPhoneVerification(ctx, await readJson(req)));
