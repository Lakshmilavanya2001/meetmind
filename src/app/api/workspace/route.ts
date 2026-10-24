import { authed, readJson } from "@/server/http";
import { getWorkspace, updateWorkspaceSettings } from "@/server/services/organization";

export const GET = authed(async (_req, ctx) => ({ workspace: await getWorkspace(ctx) }));
export const PATCH = authed(async (req, ctx) => ({
  workspace: await updateWorkspaceSettings(ctx, await readJson(req)),
}));
