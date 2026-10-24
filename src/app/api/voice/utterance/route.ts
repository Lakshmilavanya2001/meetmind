import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { readAudioUpload } from "@/server/multipart";
import { handleUtterance } from "@/server/services/voice";
import { AppError } from "@/server/errors";

// POST multipart: audio (16 kHz WAV) + meetingRef, mode (wake|ptt|confirm), conversationId?, actionId?
// With `Accept: application/x-ndjson` the answer streams as two lines: {type:"heard", heard, triggered} as soon
// as the speech is recognised (so the call's interpreter knows at once whether to translate it), then
// {type:"reply", ...} when the assistant has answered. Otherwise one JSON reply.
export const POST = authed(async (req, ctx) => {
  rateLimit(`voice:${ctx.userId}`, 40, 60_000);
  const { audio, fields } = await readAudioUpload(req, 700_000); // ≤ ~20 s of speech
  if (!req.headers.get("accept")?.includes("application/x-ndjson")) return handleUtterance(ctx, fields, audio);

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const line = (o: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
      try {
        const reply = await handleUtterance(ctx, fields, audio, (h) => line({ type: "heard", ...h }));
        line({ type: "reply", ...reply });
      } catch (err) {
        line({ type: "error", message: err instanceof AppError ? err.message : "The voice assistant couldn't process that." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
});
