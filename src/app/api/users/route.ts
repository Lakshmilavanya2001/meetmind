import { authed } from "@/server/http";
import { searchDirectory } from "@/server/services/directory";
import { rateLimit } from "@/server/rate-limit";
import { requireMember } from "@/server/auth/permissions";
import { directorySearchSchema } from "@/lib/validation";

// GET /api/users?q=rahul&limit=20 — search the caller's workspace directory.
export const GET = authed(async (req, ctx) => {
  requireMember(ctx);
  rateLimit(`dir:${ctx.userId}`, 120, 60_000);
  const { q, limit } = directorySearchSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return { users: await searchDirectory(ctx, q, limit) };
});
