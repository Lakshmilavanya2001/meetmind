import { authed, readJson } from "@/server/http";
import { setMyCallLanguage, stopInterpretingMe } from "@/server/services/interpretation";

// PUT { language } — the language you speak and want to hear. In a live call this also opts your voice
// in and switches the interpreter on for the call.
export const PUT = authed<{ ref: string }>(async (req, ctx, { ref }) => setMyCallLanguage(ctx, ref, await readJson(req)));
// DELETE — stop sending your voice to the interpreter (you still hear others in your language).
export const DELETE = authed<{ ref: string }>(async (_req, ctx, { ref }) => stopInterpretingMe(ctx, ref));
