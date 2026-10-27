/**
 * Load test of the interpreter's path for one utterance, from the moment the speaker's pause ends: offline speech
 * recognition → translation (streamed, until the first spoken piece) → Magpie (until the first audio, then the rest
 * of it, as a call plays it). N simulated speakers run utterances back to back; it prints the median and 95th
 * percentile of each stage and of the total, per number of speakers.
 *
 *   npx tsx --conditions=react-server scripts/bench-interpreter.ts en hi 1,2,4,8,16
 *   npx tsx --conditions=react-server scripts/bench-interpreter.ts hi en 1,4,8 a.wav b.wav   (16 kHz mono WAVs)
 *
 * It uses the interpreter's own settings (.env) and code: the offline recogniser (INTERPRETER_OFFLINE_ASR_URL, or
 * else STT_*), the LLM with the interpreter prompt (LLM_*), and Magpie (MAGPIE_TTS_URL). Without WAV files it first
 * voices ten meeting sentences in the source language with Magpie. The phrase pause before all this (0.25 s) and the
 * network to the listener come on top. Results from 2026-10-26: docs/ARCHITECTURE.md. The LLM and Magpie are shared
 * servers: keep runs short.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getLlmProvider } from "@/server/ai/llm";
import { createMagpieTtsProvider, readMagpieConfig, streamMagpieSpeech } from "@/server/providers/magpie";
import { createOpenAiSttProvider, createRivaOfflineSttProvider, readSttConfig } from "@/server/providers/stt";
import { interpreterPrompt, splitSpokenPieces } from "@/server/services/translation";
import { parseWav, resampleInt16, toMono } from "@/server/interpreter/audio";
import { pcmToWav } from "@/server/interpreter/offline-asr";

const SENTENCES: Record<string, string[]> = {
  en: [
    "Yes, the meeting tomorrow is at ten.",
    "Okay, I'll send the report by this evening.",
    "Can you hear me clearly?",
    "We need two more people for this project.",
    "No, I'm on leave on Friday.",
    "The budget approval should come next week.",
    "Priya, can you look at the database plan?",
    "Alright, let's talk on Monday then.",
    "The server went down twice last night, but everything is running fine now.",
    "I think the client is happy with this design, so we can move ahead with the launch.",
  ],
  hi: [
    "हाँ, कल की मीटिंग दस बजे है।",
    "ठीक है, मैं रिपोर्ट शाम तक भेज दूँगी।",
    "क्या आप मेरी आवाज़ सुन पा रहे हैं?",
    "हमें इस प्रोजेक्ट के लिए दो और लोगों की ज़रूरत है।",
    "नहीं, शुक्रवार को मैं छुट्टी पर हूँ।",
    "बजट की मंज़ूरी अगले हफ्ते तक आ जाएगी।",
    "प्रिया, क्या आप डेटाबेस का प्लान देख सकती हैं?",
    "अच्छा, फिर हम सोमवार को बात करते हैं।",
    "सर्वर कल रात दो बार बंद हुआ था, लेकिन अब सब ठीक चल रहा है।",
    "जी, मुझे लगता है कि क्लाइंट इस बार के डिज़ाइन से खुश है और हम आगे बढ़ सकते हैं।",
  ],
};

const [from = "en", to = "hi", levelsArg = "1,2,4,6,8,12,16", ...files] = process.argv.slice(2);
const levels = levelsArg.split(",").map(Number);

const sttConfig = readSttConfig();
const stt = process.env.INTERPRETER_OFFLINE_ASR_URL
  ? createRivaOfflineSttProvider(process.env.INTERPRETER_OFFLINE_ASR_URL)
  : sttConfig
    ? createOpenAiSttProvider(sttConfig)
    : null;
const magpie = readMagpieConfig();
if (!stt || !magpie || !SENTENCES[from]) {
  console.error("Needs INTERPRETER_OFFLINE_ASR_URL (or STT_*), LLM_* and MAGPIE_TTS_URL in .env, and a source language of en or hi.");
  process.exit(1);
}
const llm = getLlmProvider();

/** The utterances: the given WAVs, or the built-in sentences voiced by Magpie and resampled to 16 kHz mono. */
async function clips(): Promise<Buffer[]> {
  if (files.length) return files.map((f) => readFileSync(f));
  const tts = createMagpieTtsProvider(magpie!);
  return Promise.all(
    SENTENCES[from].map(async (sentence) => {
      const out = await tts.synthesize(sentence, { language: from });
      const wav = parseWav(out!.audio);
      const pcm = resampleInt16(toMono(wav.samples, wav.channels), wav.sampleRate, 16_000);
      return pcmToWav(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }),
  );
}

/** One utterance through the interpreter's path: [recognition, translation to the first piece, voice to first audio, total] in ms. */
async function one(wav: Buffer): Promise<number[]> {
  const t0 = performance.now();
  const { text } = await stt!.transcribe(wav, { mimeType: "audio/wav", fileName: "utterance.wav", language: from });
  const t1 = performance.now();
  let buffer = "";
  let piece: string | null = null;
  let t2 = 0;
  const res = await llm.complete({
    temperature: 0,
    maxTokens: 100 + text.length * 3,
    messages: [
      { role: "system", content: interpreterPrompt(to) },
      { role: "user", content: text },
    ],
    onDelta: (d) => {
      buffer += d;
      if (piece !== null) return;
      const { pieces } = splitSpokenPieces(buffer.replace(/^["“\s]+/, ""), false);
      if (pieces.length) {
        piece = pieces[0];
        t2 = performance.now();
      }
    },
  });
  if (piece === null) {
    piece = splitSpokenPieces((buffer || res.content).replace(/^["“\s]+/, ""), true).pieces[0] ?? res.content.trim();
    t2 = performance.now();
  }
  const stream = await streamMagpieSpeech(piece, to, { sampleRate: 48_000 }); // resolves with the first audio
  const t3 = performance.now();
  if (stream) {
    const reader = stream.getReader();
    while (!(await reader.read()).done); // the rest of the audio, as a call plays it
  }
  return [t1 - t0, t2 - t1, t3 - t2, t3 - t0];
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const cell = (xs: number[]) => `${pct(xs, 0.5).toFixed(0).padStart(5)} ${pct(xs, 0.95).toFixed(0).padStart(5)}`;

async function main() {
  const utterances = await clips();
  await one(utterances[0]); // warm the connections
  console.log(`${from}→${to}, ${utterances.length} utterances; ms from the end of the pause, p50 and p95:`);
  console.log(`speakers |   recognition |   translation |         voice |         total | utt/s`);
  for (const speakers of levels) {
    const n = Math.max(16, 4 * speakers);
    const results: number[][] = [];
    let next = 0;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: speakers }, async () => {
        for (let i = next++; i < n; i = next++) results.push(await one(utterances[i % utterances.length]));
      }),
    );
    const perSecond = n / ((performance.now() - start) / 1000);
    const col = (k: number) => cell(results.map((r) => r[k]));
    console.log(`${String(speakers).padStart(8)} | ${col(0)}   | ${col(1)}   | ${col(2)}   | ${col(3)}   | ${perSecond.toFixed(1).padStart(5)}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
