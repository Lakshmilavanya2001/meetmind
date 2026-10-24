import { authed } from "@/server/http";
import { listMyPendingInvitations } from "@/server/services/invitations";

export const GET = authed(async (_req, ctx) => ({ invitations: await listMyPendingInvitations(ctx) }));
