import { authed } from "@/server/http";

export const GET = authed(async (_req, ctx) => ({
  user: ctx.user,
  organizationId: ctx.organizationId,
  orgRole: ctx.orgRole,
}));
