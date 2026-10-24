/**
 * Splits a live 16 kHz audio stream into utterances with a simple energy-based voice detector.
 * The noise floor adapts, so a noisy room doesn't count as speech. An utterance ends after a short
 * pause (or at a hard maximum), which is when the interpreter asks the recogniser to finalise it.
 */
export type SegmenterOptions = { endSilenceMs: number; minSpeechMs: number; maxUtteranceMs: number; minLevel: number };
export type SegmentEvent = { type: "start" } | { type: "end"; speechMs: number; forced: boolean };

// 800 ms keeps sentences whole (comma pauses don't split them) while staying quick; tune with INTERPRETER_PAUSE_MS.
export const DEFAULT_SEGMENTER: SegmenterOptions = { endSilenceMs: 800, minSpeechMs: 250, maxUtteranceMs: 15_000, minLevel: 0.012 };
export const segmenterOptions = (env: Record<string, string | undefined> = process.env): SegmenterOptions => ({
  ...DEFAULT_SEGMENTER,
  endSilenceMs: Math.min(2000, Math.max(300, Number(env.INTERPRETER_PAUSE_MS) || DEFAULT_SEGMENTER.endSilenceMs)),
});

const BLOCK_MS = 200;
const BLOCKS = 25; // 5 s of history for the noise floor
const MAX_NOISE = 0.03; // never treat more than a loud fan as "background", so fast talkers aren't cut off

export class UtteranceSegmenter {
  // Noise floor = the quietest 200 ms block of the last 5 s (capped). Steady noise (a fan switching on) becomes
  // the floor within 5 s, while speech always has quieter gaps between words that keep it low.
  private blocks: number[] = [];
  private blockSum = 0;
  private blockMs = 0;
  private inSpeech = false;
  private speechMs = 0;
  private silenceMs = 0;
  private utteranceMs = 0;
  /** Wall-clock time of the last voiced frame: when the speaker actually stopped talking. */
  lastVoiceAt = 0;

  constructor(private opts: SegmenterOptions = DEFAULT_SEGMENTER) {}

  static level(samples: Int16Array) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += (samples[i] / 32768) ** 2;
    return Math.sqrt(sum / Math.max(1, samples.length));
  }

  /** Feed one frame (any length, 16 kHz mono). Returns an event when an utterance starts or ends. */
  push(samples: Int16Array, now = Date.now()): SegmentEvent | null {
    const ms = (samples.length / 16000) * 1000;
    const level = UtteranceSegmenter.level(samples);
    this.blockSum += level * ms;
    this.blockMs += ms;
    if (this.blockMs >= BLOCK_MS) {
      this.blocks.push(this.blockSum / this.blockMs);
      if (this.blocks.length > BLOCKS) this.blocks.shift();
      this.blockSum = 0;
      this.blockMs = 0;
    }
    const noise = this.blocks.length ? Math.min(MAX_NOISE, ...this.blocks) : 0;
    const voiced = level > Math.max(this.opts.minLevel, noise * 3);

    if (voiced) {
      this.lastVoiceAt = now;
      this.silenceMs = 0;
      this.speechMs += ms;
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.utteranceMs = 0;
        this.utteranceMs += ms;
        return { type: "start" };
      }
    } else if (this.inSpeech) {
      this.silenceMs += ms;
    }
    if (!this.inSpeech) return null;
    this.utteranceMs += ms;

    const ended = this.silenceMs >= this.opts.endSilenceMs;
    const forced = this.utteranceMs >= this.opts.maxUtteranceMs;
    if (ended || forced) {
      const speechMs = this.speechMs;
      this.inSpeech = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.utteranceMs = 0;
      // A cough or click isn't an utterance.
      if (speechMs < this.opts.minSpeechMs) return null;
      return { type: "end", speechMs, forced: forced && !ended };
    }
    return null;
  }
}
