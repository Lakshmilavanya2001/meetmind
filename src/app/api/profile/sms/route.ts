import { authed } from "@/server/http";
import { listMySms } from "@/server/services/sms";

// Text messages sent to you (in development, the outbox instead of a phone).
export const GET = authed(async (_req, ctx) => listMySms(ctx));
