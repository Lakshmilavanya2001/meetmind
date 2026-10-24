import { authed } from "@/server/http";
import { listMyWorkspaces } from "@/server/services/invitations";

export const GET = authed(async (_req, ctx) => ({ active: ctx.organizationId, workspaces: await listMyWorkspaces(ctx) }));
