import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { removeParticipant, setParticipantRole } from "@/server/services/meetings";

type P = { ref: string; userId: string };

export const PATCH = authed<P>(async (req, ctx, { ref, userId }) => {
  const { role } = z.object({ role: z.enum(["COHOST", "ATTENDEE"]) }).parse(await readJson(req));
  await setParticipantRole(ctx, ref, userId, role);
  return { ok: true };
});

export const DELETE = authed<P>(async (_req, ctx, { ref, userId }) => {
  await removeParticipant(ctx, ref, userId);
  return { ok: true };
});
