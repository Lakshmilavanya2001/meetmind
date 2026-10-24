import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { decideAction } from "@/server/ai/agent";

// POST — { decision: "confirm" | "reject" } for a pending sensitive action proposed by the assistant.
export const POST = authed<{ id: string }>(async (req, ctx, { id }) => {
  const { decision } = z.object({ decision: z.enum(["confirm", "reject"]) }).parse(await readJson(req));
  return decideAction(ctx, id, decision);
});
