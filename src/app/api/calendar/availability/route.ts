import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { requireMember } from "@/server/auth/permissions";
import { getAvailability } from "@/server/services/calendar";

export const POST = authed(async (req, ctx) => {
  requireMember(ctx);
  const { userIds, start, end } = z
    .object({ userIds: z.array(z.string()).min(1).max(50), start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) })
    .parse(await readJson(req));
  return getAvailability(ctx, userIds, new Date(start), new Date(end));
});
