import { authed, readJson } from "@/server/http";
import { changeMemberRole, removeMember } from "@/server/services/organization";

type P = { userId: string };

export const PATCH = authed<P>(async (req, ctx, { userId }) => {
  await changeMemberRole(ctx, userId, await readJson(req));
  return { ok: true };
});

export const DELETE = authed<P>(async (_req, ctx, { userId }) => {
  await removeMember(ctx, userId);
  return { ok: true };
});
