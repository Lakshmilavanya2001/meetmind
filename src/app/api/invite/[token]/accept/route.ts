import { authed } from "@/server/http";
import { acceptExternalInvitation, switchWorkspace } from "@/server/services/invitations";

// Accept an emailed invitation with the signed-in account (must match the invited email).
export const POST = authed<{ token: string }>(async (_req, ctx, { token }) => {
  const res = await acceptExternalInvitation(ctx, token);
  await switchWorkspace(ctx, res.organizationId);
  return res;
});
