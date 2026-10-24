import { authed, readJson } from "@/server/http";
import { importTranscript } from "@/server/services/transcripts";

// POST — { content, fileName?, replace? } (VTT, SRT or "Speaker: text" lines)
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => importTranscript(ctx, ref, await readJson(req)));
