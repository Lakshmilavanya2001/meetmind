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

// One consistent default voice per language. "Louise" exists in every locale except Arabic.
const DEFAULT_VOICE: Record<string, string> = { ar: "Sofia" };
export const defaultMagpieVoice = (lang: string) => DEFAULT_VOICE[lang] ?? process.env.MAGPIE_VOICE ?? "Louise";
/** A voice id is the speaker, optionally with a tone: "Sofia" or "Sofia.Calm". */
export const VOICE_ID = /^[A-Za-z]{2,20}(\.[A-Za-z]{2,24})?$/;
const voiceFor = (lang: string, voice?: string | null) =>
  `Magpie-Multilingual.${MAGPIE_LOCALE[lang].toUpperCase()}.${voice && VOICE_ID.test(voice) ? voice : defaultMagpieVoice(lang)}`;

export type MagpieVoice = { id: string; speaker: string; tone: string | null };
const CATALOG_TTL_MS = 10 * 60_000;
let catalog: { at: number; byLang: Map<string, MagpieVoice[]> } | null = null;
let loading: Promise<Map<string, MagpieVoice[]>> | null = null;

/**
 * The voices (and tones) the Magpie server offers for each app language, from GET /audio/list_voices, cached for
 * 10 minutes. Names look like "Magpie-Multilingual.EN-US.Sofia.Calm". Empty when Magpie isn't set up or is down.
 */
export async function listMagpieVoices(fetchImpl: typeof fetch = fetch): Promise<Map<string, MagpieVoice[]>> {
  const config = readMagpieConfig();
  if (!config) return new Map();
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.byLang;
  loading ??= (async () => {
    try {
      const res = await fetchImpl(`${config.baseUrl}/audio/list_voices`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, { voices?: string[] }>;
      const toLang = new Map(Object.entries(MAGPIE_LOCALE).map(([lang, locale]) => [locale.toUpperCase(), lang]));
      const byLang = new Map<string, MagpieVoice[]>();
      for (const group of Object.values(body)) {
        for (const name of group.voices ?? []) {
          const [, locale, speaker, tone] = /^Magpie-Multilingual\.([A-Z]{2}-[A-Z]{2})\.([A-Za-z]+)(?:\.([A-Za-z]+))?$/.exec(name) ?? [];
          const lang = locale && toLang.get(locale);
          if (!lang || !speaker) continue;
          const list = byLang.get(lang) ?? [];
          const id = tone ? `${speaker}.${tone}` : speaker;
          if (!list.some((v) => v.id === id)) list.push({ id, speaker, tone: tone ?? null });
          byLang.set(lang, list);
        }
      }
      catalog = { at: Date.now(), byLang };
      return byLang;
    } catch (err) {
      console.warn("[magpie] couldn't list voices:", (err as Error).message);
      return catalog?.byLang ?? new Map<string, MagpieVoice[]>();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Every voice (and tone) on offer in any language, each once: what a speaker can choose to be heard in. */
export function allVoices(byLang: Map<string, MagpieVoice[]>, first?: string) {
  const out = new Map<string, MagpieVoice>();
  const langs = [...(first && byLang.has(first) ? [first] : []), ...[...byLang.keys()].filter((l) => l !== first)];
  for (const lang of langs) for (const v of byLang.get(lang) ?? []) if (!out.has(v.id)) out.set(v.id, v);
  return [...out.values()];
}

/**
 * The voice listeners in `lang` hear a speaker in, given the voice the speaker chose: that voice and tone if the
 * language has it, else the same voice without the tone, else null (the language's default voice).
 */
export function voiceIn(byLang: Map<string, MagpieVoice[]>, lang: string, voice: string | null | undefined): string | null {
  if (!voice) return null;
  const list = byLang.get(lang) ?? [];
  if (list.some((v) => v.id === voice)) return voice;
  const speaker = voice.split(".")[0];
  return list.some((v) => v.id === speaker) ? speaker : null;
}

/** Is `voice` one the server offers in any language? */
export async function magpieHasVoice(voice: string) {
  return allVoices(await listMagpieVoices()).some((v) => v.id === voice);
}

/** Tests only. */
export const resetMagpieVoices = () => void ((catalog = null), (loading = null));

export type MagpieConfig = { baseUrl: string };
export function readMagpieConfig(env: Record<string, string | undefined> = process.env): MagpieConfig | null {
  return env.MAGPIE_TTS_URL ? { baseUrl: env.MAGPIE_TTS_URL.replace(/\/$/, "") } : null;
}

export const magpieCovers = (language: string) => !!MAGPIE_LOCALE[language.split("-")[0]];

function form(text: string, lang: string, sampleRate: number, voice?: string | null) {
  const f = new FormData();
  f.append("language", MAGPIE_LOCALE[lang]);
  f.append("text", text);
  f.append("voice", voiceFor(lang, voice));
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
export async function streamMagpieSpeech(text: string, language: string, opts: { sampleRate?: number; signal?: AbortSignal; voice?: string | null } = {}): Promise<ReadableStream<Uint8Array> | null> {
  const config = readMagpieConfig();
  const lang = language.split("-")[0];
  if (!config || !magpieCovers(lang) || !text.trim()) return null;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  const res = await fetch(`${config.baseUrl}/audio/synthesize_online`, { method: "POST", body: form(text, lang, opts.sampleRate ?? MAGPIE_RATE, opts.voice), signal });
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

/** One short WAV in a given voice, for previewing it. */
export async function magpieSample(text: string, language: string, voice: string | null) {
  const config = readMagpieConfig();
  const lang = language.split("-")[0];
  if (!config || !magpieCovers(lang)) return null;
  const res = await fetch(`${config.baseUrl}/audio/synthesize`, { method: "POST", body: form(text, lang, MAGPIE_RATE, voice), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Magpie TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}
