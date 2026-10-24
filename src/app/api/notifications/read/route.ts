import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { markNotificationsRead } from "@/server/services/notifications";

// POST — { ids?: string[] }; omit ids to mark all as read.
export const POST = authed(async (req, ctx) => {
  const { ids } = z.object({ ids: z.array(z.string()).max(100).optional() }).parse(await readJson(req).catch(() => ({})));
  await markNotificationsRead(ctx, ids);
  return { ok: true };
});
