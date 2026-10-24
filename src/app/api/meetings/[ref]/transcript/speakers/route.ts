import { authed, readJson } from "@/server/http";
import { renameSpeaker } from "@/server/services/transcripts";

// POST { from: "Speaker 1", to: "Priya Patel", userId? } — host or co-host.
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => renameSpeaker(ctx, ref, await readJson(req)));
