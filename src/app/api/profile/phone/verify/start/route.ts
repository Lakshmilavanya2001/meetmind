import { authed } from "@/server/http";
import { startPhoneVerification } from "@/server/services/sms";

// Texts a 6-digit code to the number saved in your profile (3 per 10 minutes).
export const POST = authed(async (_req, ctx) => startPhoneVerification(ctx));
