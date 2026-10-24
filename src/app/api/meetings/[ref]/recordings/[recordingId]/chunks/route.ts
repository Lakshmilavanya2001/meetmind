import { NextResponse } from "next/server";
import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { readAudioUpload } from "@/server/multipart";
import { enqueueRecordingChunk, MAX_CHUNK_BYTES } from "@/server/services/transcripts";

// POST multipart: audio (WAV) + index, startMs, durationMs. Idempotent per (recording, index).
export const POST = authed<{ ref: string; recordingId: string }>(async (req, ctx, { ref, recordingId }) => {
  rateLimit(`rec-chunks:${ctx.userId}`, 180, 60_000);
  const { audio, fields } = await readAudioUpload(req, MAX_CHUNK_BYTES);
  const res = await enqueueRecordingChunk(ctx, ref, recordingId, fields, audio);
  return NextResponse.json(res, { status: res.duplicate ? 200 : 202 });
});
