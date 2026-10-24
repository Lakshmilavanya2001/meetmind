import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { requireMember } from "@/server/auth/permissions";
import { findFreeSlots } from "@/server/services/calendar";

export const POST = authed(async (req, ctx) => {
  requireMember(ctx);
  const input = z
    .object({
      userIds: z.array(z.string()).max(50).default([]),
      rangeStart: z.iso.datetime({ offset: true }),
      rangeEnd: z.iso.datetime({ offset: true }),
      durationMinutes: z.number().int().min(5).max(480),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .parse(await readJson(req));
  return findFreeSlots(ctx, { ...input, rangeStart: new Date(input.rangeStart), rangeEnd: new Date(input.rangeEnd) });
});
