import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { respondToRing } from "@/server/services/calls";
import { switchWorkspace } from "@/server/services/invitations";

// POST — { response: "accept" | "decline" }
export const POST = authed<{ id: string }>(async (req, ctx, { id }) => {
  const { response } = z.object({ response: z.enum(["accept", "decline"]) }).parse(await readJson(req));
  const res = await respondToRing(ctx, id, response);
  // Calls can come from another workspace the user belongs to; answering switches to it.
  if (response === "accept" && res.organizationId !== ctx.organizationId) await switchWorkspace(ctx, res.organizationId);
  return { joinCode: res.joinCode };
});
