import { authed } from "@/server/http";
import { listIncomingCalls } from "@/server/services/calls";

// Polled every few seconds by every open page.
export const GET = authed(async (_req, ctx) => ({ calls: await listIncomingCalls(ctx) }));
