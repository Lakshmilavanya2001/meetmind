import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { switchWorkspace } from "@/server/services/invitations";

export const POST = authed(async (req, ctx) => {
  const { organizationId } = z.object({ organizationId: z.string().min(1) }).parse(await readJson(req));
  await switchWorkspace(ctx, organizationId);
  return { ok: true };
});
