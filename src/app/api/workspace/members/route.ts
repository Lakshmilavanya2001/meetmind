import { authed } from "@/server/http";
import { searchDirectory } from "@/server/services/directory";
import { requireMember } from "@/server/auth/permissions";

export const GET = authed(async (_req, ctx) => {
  requireMember(ctx);
  return { members: await searchDirectory(ctx, "", 50, { includeGuests: ctx.orgRole !== "MEMBER" }) };
});
