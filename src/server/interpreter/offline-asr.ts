import type { SttProvider } from "../providers/stt";

/**
 * Offline speech recognition for the interpreter, for the languages in INTERPRETER_OFFLINE_ASR_LANGUAGES: Parakeet
 * on a Riva ASR NIM in offline mode (INTERPRETER_OFFLINE_ASR_URL; deploy/gpu-host), or else the OpenAI-compatible
 * STT_* server (Granite, English only). The interpreter's own voice detector finds the end of each utterance and
 * the whole utterance goes in one request, so its text is back in ~50–150 ms (Granite: 0.15–0.3 s). The streaming
 * Parakeet server needs 0.8–1.1 s after each pause to finish a sentence (measured 2026-10-26).
 *
 * Audio is kept for the last ~30 s with the wall-clock time it arrived, so an utterance is cut out by time:
 * from a little before the detector heard speech start to a little after the last voiced frame.
 */
const BYTES_PER_MS = 32; // 16 kHz 16-bit mono
const PRE_ROLL_MS = 300; // the detector fires once speech is loud enough: keep the soft start of the first word
const TAIL_MS = 200; // and the fading end of the last one
const KEEP_MS = 32_000; // > the segmenter's 15 s cap plus the pause
const MAX_UTTERANCE_MS = 29_000;

export type OfflineUtterance = { text: string; language: string; speechStartAt: number; speechEndAt: number; resultAt: number };

/** Languages to recognise offline (INTERPRETER_OFFLINE_ASR_LANGUAGES=en), when the STT server covers them. */
export const offlineAsrLanguages = (stt: SttProvider | null, env: Record<string, string | undefined> = process.env) =>
  new Set((env.INTERPRETER_OFFLINE_ASR_LANGUAGES ?? "").split(",").map((l) => l.trim()).filter((l) => l && stt?.languages.includes(l)));

/** 16 kHz mono 16-bit PCM → WAV. */
export function pcmToWav(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(16000 * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

export class OfflineAsr {
  /** Recent audio, oldest first; `at` is the wall time the chunk's last sample arrived. */
  private chunks: { at: number; pcm: Buffer }[] = [];
  /** Requests run one after another so lines keep their order. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private stt: SttProvider,
    private language: string,
    private onUtterance: (u: OfflineUtterance) => void,
    private onError: (message: string) => void = () => {},
  ) {}

  get languageCode() {
    return this.language;
  }

  append(pcm16k: Buffer, now = Date.now()) {
    this.chunks.push({ at: now, pcm: Buffer.from(pcm16k) }); // copy: frame buffers may be reused
    while (this.chunks.length && now - this.chunks[0].at > KEEP_MS) this.chunks.shift();
  }

  /** The audio between two wall-clock times, from what's been kept. */
  audioBetween(from: number, to: number): Buffer {
    const parts: Buffer[] = [];
    for (const c of this.chunks) {
      const start = c.at - c.pcm.length / BYTES_PER_MS;
      if (c.at <= from || start >= to) continue;
      const a = Math.max(0, Math.round((from - start) * BYTES_PER_MS) & ~1);
      const b = Math.min(c.pcm.length, Math.round((to - start) * BYTES_PER_MS) & ~1);
      if (b > a) parts.push(c.pcm.subarray(a, b));
    }
    return Buffer.concat(parts);
  }

  /** The speaker paused: transcribe what they said between these times. */
  commit(speechStartAt: number, speechEndAt: number) {
    const from = Math.max(speechStartAt - PRE_ROLL_MS, speechEndAt - MAX_UTTERANCE_MS);
    const pcm = this.audioBetween(from, speechEndAt + TAIL_MS);
    if (pcm.length < 200 * BYTES_PER_MS) return; // under 0.2 s: a click, not speech
    this.chain = this.chain.then(() => this.transcribe(pcm, speechStartAt, speechEndAt));
  }

  private async transcribe(pcm: Buffer, speechStartAt: number, speechEndAt: number) {
    if (this.closed) return;
    try {
      const { text } = await this.stt.transcribe(pcmToWav(pcm), { mimeType: "audio/wav", fileName: "utterance.wav", language: this.language });
      if (text.trim() && !this.closed) this.onUtterance({ text: text.trim(), language: this.language, speechStartAt, speechEndAt, resultAt: Date.now() });
    } catch (err) {
      this.onError(`offline recognition failed: ${(err as Error).message}`);
    }
  }

  close() {
    this.closed = true;
    this.chunks = [];
  }
}
