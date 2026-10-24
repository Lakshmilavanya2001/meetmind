import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getRingStates, ringAgain } from "@/server/services/calls";

type P = { ref: string };

export const GET = authed<P>(async (_req, ctx, { ref }) => ({ rings: await getRingStates(ctx, ref) }));

// POST — { userIds[] } ring participants again.
export const POST = authed<P>(async (req, ctx, { ref }) => {
  rateLimit(`ring:${ctx.userId}`, 30, 10 * 60_000);
  const { userIds } = z.object({ userIds: z.array(z.string()).min(1).max(20) }).parse(await readJson(req));
  return ringAgain(ctx, ref, userIds);
});
