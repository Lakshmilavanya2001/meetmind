import { authed, readJson } from "@/server/http";
import { previewCallVoice } from "@/server/services/interpretation";

// A short sample of a voice in my call language (audio/wav), to hear before choosing it.
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => {
  const wav = await previewCallVoice(ctx, ref, await readJson(req));
  return new Response(new Uint8Array(wav), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
});
