import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { inviteByEmail, inviteUsers } from "@/server/services/invitations";
import { rateLimit } from "@/server/rate-limit";

const body = z.union([
  z.object({ userIds: z.array(z.string().min(1)).min(1).max(50) }),
  z.object({ email: z.string().max(254) }),
]);

// POST — invite workspace members ({ userIds }) or someone by email ({ email }).
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => {
  rateLimit(`meeting:invite:${ctx.userId}`, 60, 60 * 60 * 1000);
  const input = body.parse(await readJson(req));
  return "userIds" in input ? inviteUsers(ctx, ref, input.userIds) : inviteByEmail(ctx, ref, input.email);
});
