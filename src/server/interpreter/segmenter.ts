/**
 * Splits a live 16 kHz audio stream into utterances with a simple energy-based voice detector.
 * The noise floor adapts, so a noisy room doesn't count as speech. An utterance ends after a short
 * pause (or at a hard maximum), which is when the interpreter asks the recogniser to finalise it.
 */
/**
 * phraseMs (0 = off): in long speech without a pause, end the utterance at the next short dip between words once
 * it's this long, so translation can start before the speaker stops.
 */
export type SegmenterOptions = { endSilenceMs: number; minSpeechMs: number; maxUtteranceMs: number; minLevel: number; phraseMs?: number };
export type SegmentEvent = { type: "start" } | { type: "end"; speechMs: number; forced: boolean };

// 600 ms: measured 2026-10-25, 0.2 s faster than 800 ms and still one line per sentence (500 ms saves 0.1 s more
// but splits more often at hesitations, and half-sentences translate worse). Tune with INTERPRETER_PAUSE_MS.
export const DEFAULT_SEGMENTER: SegmenterOptions = { endSilenceMs: 600, minSpeechMs: 250, maxUtteranceMs: 15_000, minLevel: 0.012 };
// For someone listening for "Hey Mind": a shorter pause cuts "Hey Mind, … ?" into pieces, and the pieces can reach
// the other callers before the assistant's verdict (measured 2026-10-25). Their speech keeps the longer pause.
export const WAKE_PAUSE_MS = 800;
export const segmenterOptions = (env: Record<string, string | undefined> = process.env): SegmenterOptions => ({
  ...DEFAULT_SEGMENTER,
  endSilenceMs: Math.min(2000, Math.max(300, Number(env.INTERPRETER_PAUSE_MS) || DEFAULT_SEGMENTER.endSilenceMs)),
});

/**
 * Phrase-by-phrase interpretation (default since 2026-10-25; INTERPRETER_MODE=sentence turns it off): a phrase
 * ends at a short breath (250 ms) or, in run-on speech, at the next dip between words after 3.5 s, so the
 * translation starts while the speaker is still talking. Measured: every word still recognised at 250 ms breaths;
 * text for a phrase arrives ~0.1 s after it ends (0.6 s for a whole sentence).
 */
export const PHRASE_PAUSE_MS = 250;
export const PHRASE_MAX_MS = 3500;
export const phraseMode = (env: Record<string, string | undefined> = process.env) => (env.INTERPRETER_MODE ?? "phrase") !== "sentence";
const DIP_MS = 40; // quiet this long between words is a safe place to cut

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
  private dipMs = 0;
  /** Wall-clock time of the last voiced frame: when the speaker actually stopped talking. */
  lastVoiceAt = 0;

  constructor(private opts: SegmenterOptions = DEFAULT_SEGMENTER) {}

  /** Change how much silence ends an utterance (takes effect from the next frame). */
  setEndSilence(ms: number) {
    this.opts = { ...this.opts, endSilenceMs: ms };
  }

  /** Long-speech cut (0 = off); see SegmenterOptions.phraseMs. */
  setPhraseMs(ms: number) {
    this.opts = { ...this.opts, phraseMs: ms };
  }

  get endSilenceMs() {
    return this.opts.endSilenceMs;
  }

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

    // A dip: quieter than speech, even if not silent (the gap between two words).
    this.dipMs = level < Math.max(this.opts.minLevel * 1.5, noise * 4) ? this.dipMs + ms : 0;
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
    const phraseCut = !!this.opts.phraseMs && this.utteranceMs >= this.opts.phraseMs && this.dipMs >= DIP_MS;
    const forced = this.utteranceMs >= this.opts.maxUtteranceMs || phraseCut;
    if (ended || forced) {
      const speechMs = this.speechMs;
      this.inSpeech = false;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.utteranceMs = 0;
      this.dipMs = 0;
      // A cough or click isn't an utterance.
      if (speechMs < this.opts.minSpeechMs) return null;
      return { type: "end", speechMs, forced: forced && !ended };
    }
    return null;
  }
}
