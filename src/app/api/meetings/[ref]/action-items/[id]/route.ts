import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { setActionItemStatus } from "@/server/services/summaries";

export const PATCH = authed<{ ref: string; id: string }>(async (req, ctx, { ref, id }) => {
  const { status } = z.object({ status: z.enum(["OPEN", "DONE"]) }).parse(await readJson(req));
  await setActionItemStatus(ctx, ref, id, status);
  return { ok: true };
});
