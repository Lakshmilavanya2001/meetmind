import { authed, readJson } from "@/server/http";
import { setMyCallVoice } from "@/server/services/interpretation";

// The voice and tone I hear translations in ({ voice: "Sofia.Calm" } or { voice: null } for the default).
export const PUT = authed<{ ref: string }>(async (req, ctx, { ref }) => setMyCallVoice(ctx, ref, await readJson(req)));
