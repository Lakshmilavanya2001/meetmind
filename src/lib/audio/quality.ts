/**
 * Objective speech-quality measures for the noise-cancellation demo (pure functions, no browser APIs).
 *  - SI-SDR (scale-invariant signal-to-distortion ratio, dB) against the clean reference: the standard
 *    speech-enhancement metric; its improvement over the noisy input is what a model adds.
 *  - Background reduction (dB): how much quieter the stretches without speech became.
 */
const FRAME = 960; // 20 ms at 48 kHz

/** Delay (in samples, 0…maxLag) that best aligns `x` to `ref` — models add a few ms of latency. */
export function bestLag(ref: Float32Array, x: Float32Array, maxLag = 4800) {
  // Correlate on the loudest 2 s of the reference to keep it fast.
  const win = Math.min(ref.length - maxLag, 96_000);
  if (win <= 0) return 0;
  let start = 0;
  let best = -1;
  for (let s = 0; s + win < ref.length - maxLag; s += 24_000) {
    let e = 0;
    for (let i = s; i < s + win; i += 8) e += ref[i] * ref[i];
    if (e > best) {
      best = e;
      start = s;
    }
  }
  let lag = 0;
  let bestC = -Infinity;
  for (let l = 0; l <= maxLag; l += 2) {
    let c = 0;
    for (let i = start; i < start + win; i += 4) c += ref[i] * (x[i + l] ?? 0);
    if (c > bestC) {
      bestC = c;
      lag = l;
    }
  }
  return lag;
}

export function siSdr(ref: Float32Array, est: Float32Array, lag = 0) {
  const n = Math.min(ref.length, est.length - lag);
  let dot = 0;
  let rr = 0;
  for (let i = 0; i < n; i++) {
    dot += ref[i] * est[i + lag];
    rr += ref[i] * ref[i];
  }
  const a = dot / (rr || 1);
  let sig = 0;
  let err = 0;
  for (let i = 0; i < n; i++) {
    const t = a * ref[i];
    sig += t * t;
    const e = est[i + lag] - t;
    err += e * e;
  }
  return 10 * Math.log10((sig || 1e-12) / (err || 1e-12));
}

const frameEnergies = (x: Float32Array, lag = 0) => {
  const out: number[] = [];
  for (let s = 0; s + FRAME <= x.length - lag; s += FRAME) {
    let e = 0;
    for (let i = s; i < s + FRAME; i++) e += x[i + lag] * x[i + lag];
    out.push(e / FRAME);
  }
  return out;
};

/**
 * Background reduction in dB over frames without speech. With a clean reference, "no speech" means the
 * reference is quiet there; without one, the quietest 20% of the input's frames are used.
 */
export function backgroundReductionDb(input: Float32Array, output: Float32Array, opts: { ref?: Float32Array; lag?: number } = {}) {
  const lag = opts.lag ?? 0;
  const ein = frameEnergies(input);
  const eout = frameEnergies(output, lag);
  let idx: number[];
  if (opts.ref) {
    const er = frameEnergies(opts.ref);
    const peak = Math.max(...er);
    idx = er.flatMap((e, i) => (e < peak * 1e-4 ? [i] : []));
  } else {
    const sorted = ein.map((e, i) => [e, i] as const).sort((a, b) => a[0] - b[0]);
    idx = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.2))).map(([, i]) => i);
  }
  idx = idx.filter((i) => i < eout.length);
  if (!idx.length) return 0;
  const a = idx.reduce((s, i) => s + ein[i], 0);
  const b = idx.reduce((s, i) => s + eout[i], 0);
  return 10 * Math.log10((a || 1e-12) / (b || 1e-12));
}
