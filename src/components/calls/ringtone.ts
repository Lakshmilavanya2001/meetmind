"use client";

/** A gentle two-tone ringtone generated with Web Audio (no audio files). Browsers may block sound until the user has interacted with the page. */
export function startRingtone(): () => void {
  let ctx: AudioContext | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    ctx = new AudioContext();
  } catch {
    return () => {};
  }
  const ring = () => {
    if (stopped || !ctx) return;
    const t = ctx.currentTime;
    for (const [freq, at] of [[880, 0], [660, 0.18], [880, 0.6], [660, 0.78]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + at);
      gain.gain.linearRampToValueAtTime(0.12, t + at + 0.02);
      gain.gain.linearRampToValueAtTime(0, t + at + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.18);
    }
    timer = setTimeout(ring, 2500);
  };
  ctx.resume().then(ring, ring);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ctx?.close().catch(() => {});
  };
}
