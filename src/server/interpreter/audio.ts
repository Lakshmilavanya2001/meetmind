/** Minimal WAV parsing and resampling for the interpreter's speech output (PCM16 only). */
export function parseWav(buf: Buffer): { samples: Int16Array; sampleRate: number; channels: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`Unsupported WAV: ${bits}-bit`);
      // Some servers stream WAVs with a placeholder data size; read to the end in that case.
      const end = size === 0 || size === 0xffffffff || off + 8 + size > buf.length ? buf.length : off + 8 + size;
      const data = buf.subarray(off + 8, end - ((end - off - 8) % 2));
      const samples = new Int16Array(data.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
      return { samples, sampleRate, channels };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Mix to mono and resample (linear interpolation; fine for speech). */
export function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels === 1) return samples;
  const out = new Int16Array(Math.floor(samples.length / channels));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return out;
}

export function resampleInt16(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const n = Math.floor((samples.length * to) / from);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to;
    const j = Math.floor(x);
    const f = x - j;
    const a = samples[j] ?? 0;
    const b = samples[j + 1] ?? a;
    out[i] = Math.round(a * (1 - f) + b * f);
  }
  return out;
}
