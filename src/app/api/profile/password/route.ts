import { authed, readJson } from "@/server/http";
import { changePassword } from "@/server/services/auth";

export const POST = authed(async (req, ctx) => {
  await changePassword(ctx, await readJson(req));
  return { ok: true };
});
