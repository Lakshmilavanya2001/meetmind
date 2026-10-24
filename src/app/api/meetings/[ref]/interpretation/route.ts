import { authed, readJson } from "@/server/http";
import { getInterpretationState, setInterpretation } from "@/server/services/interpretation";

type P = { ref: string };
export const GET = authed<P>(async (_req, ctx, { ref }) => getInterpretationState(ctx, ref));
// POST { enabled } — host or co-host.
export const POST = authed<P>(async (req, ctx, { ref }) => setInterpretation(ctx, ref, await readJson(req)));
