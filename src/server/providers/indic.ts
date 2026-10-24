import "server-only";
import type { SttProvider } from "./stt";
import type { TtsProvider } from "./tts";

/**
 * The Indic speech stack (self-hosted on the GPU host):
 *   ASR  ai4bharat/indic-conformer-600m-multilingual — 22 Indic languages, no English
 *   MT   bodhan-ai/indic-translate (Gemma-4-E4B)     — 22 Indic + English, any direction
 *   TTS  bodhan-ai/indic-speak (Llama-3.2-3B + Vocos) — 22 Indic + English, streamed audio
 * Built with indic-translate and indic-speak from Bodhan AI / AI4Bharat (Indic Open Model License v1.0).
 */
export const INDIC_LANGS = ["as", "bn", "brx", "doi", "gu", "hi", "kn", "kok", "ks", "mai", "ml", "mni", "mr", "ne", "or", "pa", "sa", "sat", "sd", "ta", "te", "ur"] as const;
export const INDIC_NAMES: Record<string, string> = {
  as: "অসমীয়া (Assamese)", bn: "বাংলা (Bengali)", brx: "बड़ो (Bodo)", doi: "डोगरी (Dogri)", gu: "ગુજરાતી (Gujarati)", hi: "हिन्दी (Hindi)",
  kn: "ಕನ್ನಡ (Kannada)", kok: "कोंकणी (Konkani)", ks: "کٲشُر (Kashmiri)", mai: "मैथिली (Maithili)", ml: "മലയാളം (Malayalam)", mni: "মৈতৈলোন্ (Manipuri)",
  mr: "मराठी (Marathi)", ne: "नेपाली (Nepali)", or: "ଓଡ଼ିଆ (Odia)", pa: "ਪੰਜਾਬੀ (Punjabi)", sa: "संस्कृतम् (Sanskrit)", sat: "ᱥᱟᱱᱛᱟᱲᱤ (Santali)",
  sd: "سنڌي (Sindhi)", ta: "தமிழ் (Tamil)", te: "తెలుగు (Telugu)", ur: "اردو (Urdu)",
};
const isIndic = (l: string) => (INDIC_LANGS as readonly string[]).includes(l);
/** Languages the translation and speech models cover (Indic + English). */
export const indicCovers = (l: string | null | undefined) => !!l && (l === "en" || isIndic(l));

export type IndicConfig = { asr: string | null; translate: string | null; tts: string | null };
export function readIndicConfig(env: Record<string, string | undefined> = process.env): IndicConfig {
  const base = (v?: string) => (v ? v.replace(/\/$/, "") : null);
  return { asr: base(env.INDIC_ASR_URL), translate: base(env.INDIC_TRANSLATE_URL), tts: base(env.INDIC_TTS_URL) };
}
export const wsUrl = (httpBase: string) => httpBase.replace(/^http/, "ws");
export const indicAsrSupports = (l: string) => !!readIndicConfig().asr && isIndic(l);

/** One sentence (or many, in one GPU batch). Throws on failure so callers can fall back. */
export async function indicTranslate(texts: string[], target: string): Promise<string[]> {
  const cfg = readIndicConfig();
  if (!cfg.translate) throw new Error("Indic translation is not configured");
  const res = await fetch(`${cfg.translate}/v1/translate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(texts.length === 1 ? { text: texts[0], tgt_lang: target } : { texts, tgt_lang: target }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Indic translate ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { translation?: string; finish_reason?: string; translations?: { translation: string; finish_reason?: string }[] };
  const list = texts.length === 1 ? [{ translation: data.translation ?? "", finish_reason: data.finish_reason }] : (data.translations ?? []);
  // A cut-off translation is worse than none: treat it as a failure for that line.
  return list.map((t) => (t.finish_reason === "length" ? "" : (t.translation ?? "").trim()));
}

/** File transcription (POST /v1/transcribe) for Indic languages. Output is unpunctuated, native script. */
export function createIndicSttProvider(base: string, fetchImpl: typeof fetch = fetch): SttProvider {
  return {
    model: "indic-conformer-600m",
    languages: [...INDIC_LANGS],
    async transcribe(audio, opts) {
      const language = (opts.language ?? "hi").split("-")[0];
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: opts.mimeType || "audio/wav" }), opts.fileName ?? "audio.wav");
      const res = await fetchImpl(`${base}/v1/transcribe?language=${encodeURIComponent(language)}&decoding=rnnt`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Indic ASR ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { text: string };
      return { text: (data.text ?? "").trim(), language };
    },
  };
}

/** Speech for the voice assistant (whole WAV). The live interpreter streams instead (see interpreter/indic-voice.ts). */
export function createIndicTtsProvider(base: string, fetchImpl: typeof fetch = fetch): TtsProvider {
  return {
    languages: ["en", ...INDIC_LANGS],
    async synthesize(text, { language }) {
      const lang = language.split("-")[0];
      if (!indicCovers(lang)) return null;
      const res = await fetchImpl(`${base}/v1/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, language: lang, format: "wav", sample_rate: 24000 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Indic TTS ${res.status}`);
      return { audio: Buffer.from(await res.arrayBuffer()), mimeType: "audio/wav" };
    },
  };
}

export const STREAM_TTS_RATE = 24_000;

/**
 * Speech as it's generated (WS /v1/stream on indic-speak): 16-bit mono PCM at STREAM_TTS_RATE.
 * Resolves once the first audio has arrived (≈ 0.4 s), so a caller can still fall back to another voice
 * if this one fails before speaking. Returns null for languages it doesn't cover or when it isn't configured.
 */
export async function streamIndicSpeech(text: string, language: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
  const base = readIndicConfig().tts;
  const lang = language.split("-")[0];
  if (!base || !indicCovers(lang) || !text.trim()) return null;
  const ws = new WebSocket(`${wsUrl(base)}/v1/stream`);
  ws.binaryType = "arraybuffer";
  const id = `s${Date.now().toString(36)}`;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const close = () => {
    if (finished) return;
    finished = true;
    try {
      controller.close();
    } catch {
      /* already closed */
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: () => close(), // the listener stopped it
  });
  signal?.addEventListener("abort", close);

  return new Promise((resolve, reject) => {
    let started = false;
    // Never hang: no first audio within 8 s, or no end within 60 s.
    const firstTimer = setTimeout(() => !started && (close(), reject(new Error("Indic TTS stream: no audio"))), 8_000);
    const endTimer = setTimeout(close, 60_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "synthesize", id, text, language: lang, sample_rate: STREAM_TTS_RATE, format: "pcm_s16le" }));
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") {
        if (finished) return;
        controller.enqueue(new Uint8Array(m.data as ArrayBuffer));
        if (!started) {
          started = true;
          clearTimeout(firstTimer);
          resolve(stream);
        }
        return;
      }
      let e: { type?: string; message?: string } = {};
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === "done" || e.type === "cancelled" || e.type === "error") {
        clearTimeout(endTimer);
        clearTimeout(firstTimer);
        close();
        if (!started) reject(new Error(`Indic TTS stream: ${e.message ?? e.type}`));
      }
    };
    ws.onerror = () => {
      clearTimeout(firstTimer);
      clearTimeout(endTimer);
      close();
      if (!started) reject(new Error("Indic TTS stream: connection failed"));
    };
    ws.onclose = () => {
      clearTimeout(firstTimer);
      clearTimeout(endTimer);
      close();
      if (!started) reject(new Error("Indic TTS stream: closed before audio"));
    };
  });
}
