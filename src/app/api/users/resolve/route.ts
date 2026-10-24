import { z } from "zod";
import { authed } from "@/server/http";
import { resolveUser } from "@/server/services/directory";
import { rateLimit } from "@/server/rate-limit";
import { requireMember } from "@/server/auth/permissions";

// GET /api/users/resolve?name=Rahul — resolve a name to exactly one member, or report ambiguity.
export const GET = authed(async (req, ctx) => {
  requireMember(ctx);
  rateLimit(`dir:${ctx.userId}`, 120, 60_000);
  const name = z.string().trim().min(1).max(100).parse(req.nextUrl.searchParams.get("name") ?? "");
  return resolveUser(ctx, name);
});
