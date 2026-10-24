import { authed, readJson } from "@/server/http";
import { getProfile, updateProfile } from "@/server/services/profile";

export const GET = authed(async (_req, ctx) => ({ profile: await getProfile(ctx) }));
export const PATCH = authed(async (req, ctx) => ({ profile: await updateProfile(ctx, await readJson(req)) }));
