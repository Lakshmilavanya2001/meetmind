/**
 * Speed speech up without changing its pitch (WSOLA: waveform-similarity overlap-add).
 *
 * The interpreter uses it to catch up: when a translated sentence had to wait for the previous one to finish,
 * it's played a little faster, the way a human interpreter speeds up when behind. Magpie ignores SSML speaking
 * rates, so this is done on the audio itself.
 *
 * How it works: the output is built from overlapping windows. Each next window is taken from the input
 * `rate` times further along, then nudged (within ±`seek`) to the spot whose waveform best continues what's
 * already been written, so no clicks or pitch shifts appear at the joins.
 */
export function timeStretch(input: Int16Array, rate: number, sampleRate: number): Int16Array {
  if (rate <= 1.001 || input.length < sampleRate / 10) return input;
  const win = Math.round(sampleRate * 0.03); // 30 ms windows
  const hop = win >> 1; // 50 % overlap on the output side
  const seek = Math.round(sampleRate * 0.01); // ±10 ms search for the best join
  const corr = Math.round(win / 4); // compare this many samples when searching
  const outLen = Math.floor(input.length / rate);
  const out = new Float32Array(outLen + win);
  const norm = new Float32Array(outLen + win);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));

  let prevEnd = 0; // where, in the input, the previous window's natural continuation starts
  for (let outPos = 0; outPos < outLen; outPos += hop) {
    const nominal = Math.round(outPos * rate);
    let best = nominal;
    if (outPos > 0) {
      // Find the input position near `nominal` whose start best matches the continuation of the last window.
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - seek);
      const hi = Math.min(input.length - win, nominal + seek);
      for (let cand = lo; cand <= hi; cand++) {
        let score = 0;
        for (let k = 0; k < corr; k += 2) score += input[cand + k] * input[Math.min(input.length - 1, prevEnd + k)];
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    if (best + win > input.length) best = Math.max(0, input.length - win);
    for (let i = 0; i < win && outPos + i < out.length; i++) {
      out[outPos + i] += input[best + i] * hann[i];
      norm[outPos + i] += hann[i];
    }
    prevEnd = best + hop;
  }
  const result = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
    result[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return result;
}

/** How much faster to speak, given how long this sentence waited for the previous one to finish. */
export function catchUpRate(waitedMs: number): number {
  if (waitedMs > 2500) return 1.3;
  if (waitedMs > 1000) return 1.2;
  return 1;
}
