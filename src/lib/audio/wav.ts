// Browser-side audio helpers: resample to 16 kHz mono and encode 16-bit PCM WAV.
export const TARGET_RATE = 16_000;

/** Linear-interpolation resampler — adequate for speech recognition. */
export function resample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0);
  }
  return out;
}

export function rms(samples: Float32Array) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export function encodeWav(samples: Float32Array, sampleRate = TARGET_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const concat = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export type SpeechChunk = { samples: Float32Array; startedAt: number; durationMs: number };

/**
 * Voice-activity chunker over 100 ms frames (already at 16 kHz). Emits utterance-sized chunks:
 * closed after ≥ minMs once there's a pause, or at maxMs. Pure silence is never emitted.
 */
export class SpeechChunker {
  private frames: Float32Array[] = [];
  private startedAt = 0;
  private speechFrames = 0;
  private trailingSilence = 0;
  private noiseFloor = 0.005;
  private preroll: { f: Float32Array; t: number }[] = [];

  constructor(
    private emit: (c: SpeechChunk) => void,
    private opts = { minMs: 3000, maxMs: 20_000, pauseMs: 800, frameMs: 100 },
    /** onStart: someone started speaking; onDrop: what they said was too short to emit (a click, a cough). */
    private hooks: { onStart?: () => void; onDrop?: () => void } = {},
  ) {}

  push(frame: Float32Array, at: number) {
    const level = rms(frame);
    const speech = level > Math.max(0.012, this.noiseFloor * 3);
    // Track background noise: drop immediately to quieter levels, rise slowly — and only during
    // non-speech, so continuous talking is never re-learned as "background".
    if (level < this.noiseFloor) this.noiseFloor = level;
    else if (!speech) this.noiseFloor += (level - this.noiseFloor) * 0.02;

    if (this.frames.length === 0) {
      this.preroll.push({ f: frame, t: at });
      if (this.preroll.length > 3) this.preroll.shift();
      if (!speech) return;
      this.frames = this.preroll.map((p) => p.f);
      this.startedAt = this.preroll[0].t;
      this.preroll = [];
      this.speechFrames = 1;
      this.trailingSilence = 0;
      this.hooks.onStart?.();
      return;
    }
    this.frames.push(frame);
    if (speech) {
      this.speechFrames++;
      this.trailingSilence = 0;
    } else this.trailingSilence += this.opts.frameMs;
    const dur = this.frames.length * this.opts.frameMs;
    if ((dur >= this.opts.minMs && this.trailingSilence >= this.opts.pauseMs) || dur >= this.opts.maxMs) this.flush();
  }

  /** Emit whatever is buffered (on mute, leave, or consent withdrawal). */
  flush() {
    const frames = this.frames;
    this.frames = [];
    if (frames.length && this.speechFrames >= 3) {
      this.emit({ samples: concat(frames), startedAt: this.startedAt, durationMs: frames.length * this.opts.frameMs });
    } else if (frames.length) this.hooks.onDrop?.();
    this.speechFrames = 0;
    this.trailingSilence = 0;
  }
}

/** Decode any browser-supported audio file and return 16 kHz mono samples. */
export async function decodeTo16kMono(file: Blob): Promise<{ samples: Float32Array; durationMs: number }> {
  const bytes = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination); // the offline context downmixes and resamples
    src.start();
    const rendered = await offline.startRendering();
    return { samples: rendered.getChannelData(0), durationMs: Math.round(decoded.duration * 1000) };
  } finally {
    ctx.close();
  }
}

/** Split long audio into ≤ maxMs pieces, cutting at the quietest point near each boundary. */
export function splitForTranscription(samples: Float32Array, maxMs = 20_000, rate = TARGET_RATE) {
  const max = Math.floor((maxMs / 1000) * rate);
  const search = rate * 3;
  const win = rate / 10;
  const out: { start: number; samples: Float32Array }[] = [];
  let start = 0;
  while (start < samples.length) {
    let end = Math.min(start + max, samples.length);
    if (end < samples.length) {
      let best = end;
      let bestLevel = Infinity;
      for (let p = end - search; p < end - win; p += win) {
        const l = rms(samples.subarray(p, p + win));
        if (l < bestLevel) {
          bestLevel = l;
          best = p + win / 2;
        }
      }
      end = Math.floor(best);
    }
    out.push({ start, samples: samples.subarray(start, end) });
    start = end;
  }
  return out;
}
