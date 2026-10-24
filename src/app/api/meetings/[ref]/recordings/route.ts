import { authed, readJson } from "@/server/http";
import { startRecordingUpload } from "@/server/services/transcripts";

// POST — { fileName, durationMs, consentConfirmed: true } → { recordingId }
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => startRecordingUpload(ctx, ref, await readJson(req)));
