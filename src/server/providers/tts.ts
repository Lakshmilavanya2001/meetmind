import "server-only";
import { createIndicTtsProvider, readIndicConfig } from "./indic";
import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { getObject, putObject } from "../storage";

/** Text-to-speech provider. `synthesize` returns null when the language isn't supported (the browser's voice is used instead). */
export interface TtsProvider {
  readonly languages: string[];
  synthesize(text: string, opts: { language: string }): Promise<{ audio: Buffer; mimeType: string } | null>;
}

type Config = { baseUrl: string; model: string; apiKey?: string; voiceDescription: string };

export function readTtsConfig(env: Record<string, string | undefined> = process.env): Config | null {
  if (!env.TTS_BASE_URL || !env.TTS_MODEL) return null;
  return {
    baseUrl: env.TTS_BASE_URL.replace(/\/$/, ""),
    model: env.TTS_MODEL,
    apiKey: env.TTS_API_KEY,
    voiceDescription: env.TTS_VOICE_DESCRIPTION || "A warm, clear, friendly female assistant voice with a neutral accent, speaking at a moderate pace",
  };
}

// Qwen3-TTS languages (by name). Hindi has no named mode, but "Auto" speaks it intelligibly
// (verified by transcribing the output back with Riva's Hindi model). Others → browser speech.
const QWEN_LANG: Record<string, string> = { hi: "Auto", en: "English", zh: "Chinese", ja: "Japanese", ko: "Korean", de: "German", fr: "French", ru: "Russian", pt: "Portuguese", es: "Spanish", it: "Italian" };
const REFERENCE_TEXT = "Hello! I'm your meeting assistant. I can schedule meetings, invite people and take notes during your calls.";

/**
 * Qwen3-TTS: the assistant's voice is *designed* once from a text description (VoiceDesign),
 * stored, and then used as the cloning reference (Base) so every reply sounds like the same voice.
 * No real person's voice is used.
 */
export function createQwenTtsProvider(config: Config, fetchImpl: typeof fetch = fetch): TtsProvider {
  let reference: Promise<string> | null = null;
  const voiceKey = `tts/voice-${createHash("sha256").update(config.voiceDescription).digest("hex").slice(0, 16)}.wav`;

  async function call(body: Record<string, unknown>) {
    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, response_format: "wav", ...body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AppError("PROVIDER_UNAVAILABLE", `Speech synthesis unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new AppError("PROVIDER_UNAVAILABLE", `Speech synthesis failed (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  function referenceVoice() {
    reference ??= (async () => {
      try {
        return (await getObject(voiceKey)).toString("base64");
      } catch {
        const wav = await call({ task_type: "VoiceDesign", input: REFERENCE_TEXT, instructions: config.voiceDescription, language: "English" });
        await putObject(voiceKey, wav);
        return wav.toString("base64");
      }
    })().catch((err) => {
      reference = null; // retry next time
      throw err;
    });
    return reference;
  }

  return {
    languages: Object.keys(QWEN_LANG),
    async synthesize(text, { language }) {
      const lang = QWEN_LANG[language.split("-")[0]];
      if (!lang) return null;
      const clean = text.trim().slice(0, 600);
      if (!clean) return null;
      const ref = await referenceVoice();
      const audio = await call({ task_type: "Base", input: clean, language: lang, ref_audio: `data:audio/wav;base64,${ref}`, ref_text: REFERENCE_TEXT });
      return { audio, mimeType: "audio/wav" };
    },
  };
}

let override: TtsProvider | null = null;
let instance: TtsProvider | null | undefined;

export function getTtsProvider(): TtsProvider | null {
  if (override) return override;
  if (instance === undefined) {
    const c = readTtsConfig();
    const qwen = c ? createQwenTtsProvider(c) : null;
    const indicBase = readIndicConfig().tts;
    // Indic Speak covers English and 22 Indic languages with studio voices; Qwen handles the rest.
    instance = indicBase ? byLanguage(createIndicTtsProvider(indicBase), qwen) : qwen;
  }
  return instance;
}

function byLanguage(indic: TtsProvider, other: TtsProvider | null): TtsProvider {
  return {
    languages: [...new Set([...indic.languages, ...(other?.languages ?? [])])],
    async synthesize(text, opts) {
      const lang = opts.language.split("-")[0];
      if (indic.languages.includes(lang)) {
        try {
          const r = await indic.synthesize(text, opts);
          if (r) return r;
        } catch (err) {
          console.warn("[tts] Indic TTS failed:", (err as Error).message);
        }
      }
      return other ? other.synthesize(text, opts) : null;
    },
  };
}

export function setTtsProviderForTests(p: TtsProvider | null) {
  override = p;
}

/** Turn an assistant reply into something sensible to say out loud: no markdown, links, emails or codes. */
export function toSpeech(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [label](url) → label
    .replace(/\s*\(([\w.+-]+@[\w.-]+)\)/g, "") // " (name@example.com)"
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "") // bare emails
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/[*_#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s*\[\d+\]/g, "") // citation markers
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}
