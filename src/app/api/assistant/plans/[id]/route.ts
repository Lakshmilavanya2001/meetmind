import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { decidePlan } from "@/server/ai/agent";

// POST { decision: "approve" | "reject" } — only the user who asked; once; within 15 minutes.
export const POST = authed<{ id: string }>(async (req, ctx, { id }) => {
  rateLimit(`assistant:${ctx.userId}`, 20, 60_000);
  const { decision } = z.object({ decision: z.enum(["approve", "reject"]) }).parse(await readJson(req));
  return decidePlan(ctx, id, decision);
});
