import { NextResponse } from "next/server";
import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { readAudioUpload } from "@/server/multipart";
import { enqueueLiveChunk, MAX_CHUNK_BYTES } from "@/server/services/transcripts";

// POST multipart: audio (WAV) + clientChunkId, capturedAt, durationMs. Idempotent per clientChunkId.
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => {
  rateLimit(`chunks:${ctx.userId}`, 120, 60_000);
  const { audio, fields } = await readAudioUpload(req, MAX_CHUNK_BYTES);
  const res = await enqueueLiveChunk(ctx, ref, fields, audio);
  return NextResponse.json(res, { status: res.duplicate ? 200 : 202 });
});
