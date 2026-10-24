import { z } from "zod";
import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { readAudioUpload } from "@/server/multipart";
import { getSttProvider } from "@/server/providers/stt";
import { AppError } from "@/server/errors";

// POST multipart: audio (16 kHz WAV, ≤ ~60 s) + language — speech to text for typing by voice.
export const POST = authed(async (req, ctx) => {
  rateLimit(`dictate:${ctx.userId}`, 30, 60_000);
  const { audio, fields } = await readAudioUpload(req, 2_000_000);
  const { language } = z.object({ language: z.string().regex(/^[a-z]{2,3}$/).default("en") }).parse(fields);
  const r = await getSttProvider().transcribe(audio.data, { mimeType: audio.mimeType, language }).catch((err) => {
    throw new AppError("PROVIDER_UNAVAILABLE", `Speech recognition failed: ${(err as Error).message.slice(0, 120)}`);
  });
  return { text: r.text.replace(/[\u0000-\u001F]/g, " ").trim(), language: r.language ?? language };
});
