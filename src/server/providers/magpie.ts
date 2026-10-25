import "server-only";
import type { TtsProvider } from "./tts";

/**
 * NVIDIA Magpie TTS Multilingual (NIM, HTTP API at MAGPIE_TTS_URL, e.g. http://host:9000/v1).
 *
 * - POST /audio/synthesize         multipart form → one WAV (fast: a 20 s reply takes about 1.3 s).
 * - POST /audio/synthesize_online  same form → raw 16-bit mono PCM, streamed while it's generated.
 *
 * Sample rates: 16000, 22050 (default), 44100 or 48000 Hz (24000 is rejected). A single response is
 * limited to about 4 MB of audio, so long text must be spoken a sentence at a time (callers do).
 * Text must be in the language's own script (Arabic voices reject Latin text, for example).
 */

/** App language → Magpie locale. These 12 are also the languages calls support (Parakeet covers them all). */
export const MAGPIE_LOCALE: Record<string, string> = {
  en: "en-US",
  hi: "hi-IN",
  es: "es-US",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  ar: "ar-XA",
  vi: "vi-VN",
};

// One consistent voice per language. "Louise" exists in every locale except Arabic.
const DEFAULT_VOICE: Record<string, string> = { ar: "Sofia" };
const voiceFor = (lang: string) => `Magpie-Multilingual.${MAGPIE_LOCALE[lang].toUpperCase()}.${DEFAULT_VOICE[lang] ?? process.env.MAGPIE_VOICE ?? "Louise"}`;

export type MagpieConfig = { baseUrl: string };
export function readMagpieConfig(env: Record<string, string | undefined> = process.env): MagpieConfig | null {
  return env.MAGPIE_TTS_URL ? { baseUrl: env.MAGPIE_TTS_URL.replace(/\/$/, "") } : null;
}

export const magpieCovers = (language: string) => !!MAGPIE_LOCALE[language.split("-")[0]];

function form(text: string, lang: string, sampleRate: number) {
  const f = new FormData();
  f.append("language", MAGPIE_LOCALE[lang]);
  f.append("text", text);
  f.append("voice", voiceFor(lang));
  f.append("sample_rate_hz", String(sampleRate));
  return f;
}

export const MAGPIE_RATE = 22_050;

export function createMagpieTtsProvider(config: MagpieConfig, fetchImpl: typeof fetch = fetch): TtsProvider {
  return {
    languages: Object.keys(MAGPIE_LOCALE),
    async synthesize(text, { language }) {
      const lang = language.split("-")[0];
      if (!magpieCovers(lang) || !text.trim()) return null;
      const res = await fetchImpl(`${config.baseUrl}/audio/synthesize`, { method: "POST", body: form(text, lang, MAGPIE_RATE), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Magpie TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { audio: Buffer.from(await res.arrayBuffer()), mimeType: "audio/wav" };
    },
  };
}

/**
 * Speech as it's generated: raw 16-bit mono PCM at `sampleRate`. Resolves once the first audio has
 * arrived, so the caller can still fall back if this fails before speaking. Null for languages Magpie
 * doesn't cover or when it isn't configured.
 */
export async function streamMagpieSpeech(text: string, language: string, opts: { sampleRate?: number; signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array> | null> {
  const config = readMagpieConfig();
  const lang = language.split("-")[0];
  if (!config || !magpieCovers(lang) || !text.trim()) return null;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  const res = await fetch(`${config.baseUrl}/audio/synthesize_online`, { method: "POST", body: form(text, lang, opts.sampleRate ?? MAGPIE_RATE), signal });
  if (!res.ok || !res.body || (res.headers.get("content-type") ?? "").includes("json")) throw new Error(`Magpie TTS stream ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  // Wait for the first audio bytes before handing the stream on.
  const reader = res.body.getReader();
  const first = await reader.read();
  if (first.done || !first.value?.length) throw new Error("Magpie TTS stream: no audio");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
