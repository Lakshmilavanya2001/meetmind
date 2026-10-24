import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getTtsProvider } from "@/server/providers/tts";
import { STREAM_TTS_RATE, streamIndicSpeech } from "@/server/providers/indic";
import { AppError } from "@/server/errors";

// POST { text, language, stream? } → speech for an assistant reply.
// With stream: true, languages indic-speak covers (English + 22 Indian languages) come back as raw 16-bit PCM
// ("audio/L16; rate=24000") while it's being generated, so playback starts in about 0.4 s. Otherwise, or if
// streaming fails before any audio, the whole reply comes back as one WAV.
// Replies are spoken a sentence at a time, so the limit allows several requests per answer.
export const POST = authed(async (req, ctx) => {
  rateLimit(`speak:${ctx.userId}`, 150, 60_000);
  const { text, language, stream } = z
    .object({ text: z.string().trim().min(1).max(800), language: z.string().regex(/^[a-z]{2,3}$/).default("en"), stream: z.boolean().optional() })
    .parse(await readJson(req));
  if (stream) {
    const live = await streamIndicSpeech(text, language, req.signal).catch((err) => {
      console.warn("[voice] streamed speech failed, using the whole-file voice:", (err as Error).message);
      return null;
    });
    if (live) return new Response(live, { headers: { "content-type": `audio/L16; rate=${STREAM_TTS_RATE}; channels=1`, "cache-control": "no-store", "x-accel-buffering": "no" } });
  }
  const tts = getTtsProvider();
  const out = tts ? await tts.synthesize(text, { language }).catch(() => null) : null;
  if (!out) throw new AppError("NOT_CONFIGURED", "No voice is available for that language.");
  return new Response(new Uint8Array(out.audio), { headers: { "content-type": out.mimeType, "cache-control": "no-store" } });
});
