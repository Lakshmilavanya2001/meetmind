import "server-only";
import { createIndicSttProvider, readIndicConfig } from "./indic";
import { AppError } from "../errors";

export type SttWord = { word: string; startMs: number; endMs: number; speaker: number | null };
export type SttResult = { text: string; words?: SttWord[]; language?: string };

/** Speech-to-text provider interface. Implementations must never invent text for silent audio. */
export interface SttProvider {
  readonly model: string;
  /** Languages it can recognise (ISO 639-1); others fall back to English recognition. */
  readonly languages: string[];
  transcribe(audio: Buffer, opts: { mimeType: string; fileName?: string; language?: string; diarize?: boolean }): Promise<SttResult>;
}

type Config = { baseUrl: string; model: string; apiKey?: string; language?: string };

export function readSttConfig(env: Record<string, string | undefined> = process.env): Config | null {
  if (!env.STT_BASE_URL || !env.STT_MODEL) return null;
  return { baseUrl: env.STT_BASE_URL.replace(/\/$/, ""), model: env.STT_MODEL, apiKey: env.STT_API_KEY, language: env.STT_LANGUAGE || undefined };
}

export class TransientSttError extends Error {}

/** OpenAI-compatible /audio/transcriptions client (vLLM, OpenAI, faster-whisper servers…). */
export function createOpenAiSttProvider(config: Config, fetchImpl: typeof fetch = fetch): SttProvider {
  return {
    model: config.model,
    languages: ["en", "fr", "de", "es", "pt", "ja"],
    async transcribe(audio, opts) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: opts.mimeType }), opts.fileName ?? "audio.wav");
      form.append("model", config.model);
      form.append("response_format", "json");
      form.append("temperature", "0");
      const language = opts.language ? opts.language.split("-")[0] : config.language;
      if (language) form.append("language", language);
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw new TransientSttError(`Speech-to-text service unreachable: ${(err as Error).message}`);
      }
      if (res.status === 429 || res.status >= 500) throw new TransientSttError(`Speech-to-text service error ${res.status}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AppError("PROVIDER_UNAVAILABLE", `Speech-to-text rejected the audio (${res.status}): ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { text?: string };
      return { text: (data.text ?? "").trim() };
    },
  };
}

// ─── NVIDIA Riva (nemotron-asr-streaming) over its OpenAI-Realtime-style WebSocket ───

export type RivaConfig = { url: string; model: string; apiKey?: string };

export function readRivaConfig(env: Record<string, string | undefined> = process.env): RivaConfig | null {
  if (!env.RIVA_REALTIME_URL) return null;
  return { url: env.RIVA_REALTIME_URL, model: env.RIVA_ASR_MODEL || "cache-aware-parakeet-rnnt-multi-asr-streaming-sortformer", apiKey: env.RIVA_API_KEY };
}

export const RIVA_LANG: Record<string, string> = { en: "en-US", hi: "hi-IN", es: "es-ES" };

/** Extract 16 kHz mono 16-bit PCM from a WAV file (the format the browser uploads). */
export function wavToPcm16(wav: Buffer): Buffer {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new AppError("VALIDATION", "Expected WAV audio.");
  let off = 12;
  let fmt: { channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { channels: wav.readUInt16LE(off + 10), rate: wav.readUInt32LE(off + 12), bits: wav.readUInt16LE(off + 22) };
    if (id === "data") {
      if (!fmt || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) throw new AppError("VALIDATION", "Expected 16 kHz mono 16-bit WAV.");
      return wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
    }
    off += 8 + size + (size % 2);
  }
  throw new AppError("VALIDATION", "WAV file has no audio data.");
}

export function createRivaSttProvider(config: RivaConfig): SttProvider {
  return {
    model: `riva:${config.model}`,
    languages: Object.keys(RIVA_LANG),
    transcribe(audio, opts) {
      const pcm = wavToPcm16(audio);
      const audioMs = pcm.length / 32; // 16 kHz × 16-bit mono
      const language = RIVA_LANG[(opts.language ?? "en").split("-")[0]] ?? "en-US";
      return new Promise<SttResult>((resolve, reject) => {
        let ws: WebSocket;
        try {
          ws = new WebSocket(config.url, config.apiKey ? { headers: { Authorization: `Bearer ${config.apiKey}` } } as never : undefined);
        } catch (err) {
          return reject(new TransientSttError(`Riva unreachable: ${(err as Error).message}`));
        }
        const texts: string[] = [];
        const words: SttWord[] = [];
        let idle: ReturnType<typeof setTimeout> | null = null;
        let done = false;
        const finish = (err?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(hard);
          if (idle) clearTimeout(idle);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          if (err) reject(err);
          else resolve({ text: texts.join(" ").replace(/\s+/g, " ").trim(), words, language: language.slice(0, 2) });
        };
        // Riva never flags the final result: finish once results stop arriving after the commit.
        const armIdle = (ms: number) => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => finish(), ms);
        };
        const hard = setTimeout(() => finish(new TransientSttError("Riva timed out")), 30_000 + pcm.length / 32);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: "transcription_session.update",
            session: {
              input_audio_transcription: { language, model: config.model },
              speaker_diarization: { enable_speaker_diarization: !!opts.diarize, max_speaker_count: 8 },
              recognition_config: { enable_automatic_punctuation: true, max_alternatives: 1, enable_word_time_offsets: true },
            },
          }));
          for (let i = 0; i < pcm.length; i += 32000) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(i, i + 32000).toString("base64") }));
          // Trailing silence lets the streaming model close the final utterance.
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(32000).toString("base64") }));
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          armIdle(4000); // nothing back at all → silence
        };
        ws.onmessage = (m) => {
          let e: { type: string; transcript?: string; error?: { message?: string; code?: string }; words_info?: { words?: { word: string; start_time: number; end_time: number; speaker_tag?: number }[] } };
          try {
            e = JSON.parse(String(m.data));
          } catch {
            return;
          }
          if (e.type === "error") {
            const msg = e.error?.message ?? "Riva error";
            return finish(/INVALID_ARGUMENT/.test(e.error?.code ?? "") ? new AppError("PROVIDER_UNAVAILABLE", msg) : new TransientSttError(msg));
          }
          if (e.type.endsWith("input_audio_transcription.completed")) {
            if (e.transcript?.trim()) texts.push(e.transcript.trim());
            for (const w of e.words_info?.words ?? []) words.push({ word: w.word, startMs: w.start_time, endMs: w.end_time, speaker: opts.diarize && typeof w.speaker_tag === "number" ? w.speaker_tag : null });
            // Results arrive one utterance at a time (sometimes 1.5 s apart). If the words so far end well
            // before the end of the audio, more is coming: wait longer. Otherwise finish quickly (live captions).
            const lastEnd = words.at(-1)?.endMs ?? 0;
            armIdle(audioMs - lastEnd > 1200 ? 3000 : 700);
          }
        };
        ws.onerror = () => finish(new TransientSttError("Riva connection failed"));
        ws.onclose = () => {
          if (!done) finish();
        };
      });
    },
  };
}

let override: SttProvider | null = null;
let instance: SttProvider | null | undefined;

export function getSttProvider(): SttProvider {
  if (override) return override;
  if (instance === undefined) {
    // Prefer Riva (streaming model: punctuation, Hindi, diarization) and fall back to the OpenAI-compatible one.
    const riva = readRivaConfig();
    const c = readSttConfig();
    const primary = riva ? createRivaSttProvider(riva) : null;
    const fallback = c ? createOpenAiSttProvider(c) : null;
    const general = primary && fallback ? withFallback(primary, fallback) : (primary ?? fallback);
    // Indic languages go to IndicConformer when it's configured (better for Hindi and 21 more languages).
    const indic = readIndicConfig().asr;
    instance = indic && general ? byLanguage(createIndicSttProvider(indic), general) : general;
  }
  if (!instance) throw new AppError("NOT_CONFIGURED", "Transcription is not configured (STT_BASE_URL / STT_MODEL).");
  return instance;
}

export const isSttConfigured = () => !!override || readSttConfig() !== null || readRivaConfig() !== null;

/** Route by spoken language: `indic` for its languages (falling back on errors), `general` otherwise. */
function byLanguage(indic: SttProvider, general: SttProvider): SttProvider {
  return {
    model: `${indic.model}+${general.model}`,
    languages: [...new Set([...general.languages, ...indic.languages])],
    async transcribe(audio, opts) {
      const lang = (opts.language ?? "").split("-")[0];
      if (!indic.languages.includes(lang)) return general.transcribe(audio, opts);
      try {
        return await indic.transcribe(audio, opts);
      } catch (err) {
        console.warn("[stt] Indic ASR failed, using the general model:", (err as Error).message);
        return general.transcribe(audio, opts);
      }
    },
  };
}

/** Use `primary`, but if it is unreachable (transient failure) try `fallback` once. */
function withFallback(primary: SttProvider, fallback: SttProvider): SttProvider {
  return {
    model: primary.model,
    languages: primary.languages,
    async transcribe(audio, opts) {
      try {
        return await primary.transcribe(audio, opts);
      } catch (err) {
        if (!(err instanceof TransientSttError)) throw err;
        console.warn("[stt] primary failed, using fallback:", (err as Error).message);
        return fallback.transcribe(audio, opts);
      }
    },
  };
}

export function setSttProviderForTests(p: SttProvider | null) {
  override = p;
}
