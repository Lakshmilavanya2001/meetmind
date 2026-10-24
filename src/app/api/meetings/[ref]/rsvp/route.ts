import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { respondToInvitation } from "@/server/services/invitations";

export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => {
  const { response } = z.object({ response: z.enum(["accept", "decline"]) }).parse(await readJson(req));
  return respondToInvitation(ctx, ref, response);
});
