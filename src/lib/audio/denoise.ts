"use client";

import { GtcrnWorkletNode, loadGtcrn, loadRnnoise, loadSpeex, RnnoiseWorkletNode, SpeexWorkletNode } from "@sapphi-red/web-noise-suppressor";

/** Noise-suppression models that run in the browser (AudioWorklet + WebAssembly), all at 48 kHz. */
export type Denoiser = "rnnoise" | "gtcrn" | "speex";
export const DENOISERS: { id: Denoiser; name: string; kind: string; note: string }[] = [
  { id: "rnnoise", name: "RNNoise", kind: "AI (recurrent neural network)", note: "Runs live in calls today (“Enhanced” noise cancellation). Very light: suitable for every device." },
  { id: "gtcrn", name: "GTCRN", kind: "AI (neural speech enhancement)", note: "Newer, stronger model; heavier. A candidate for a premium mode or server-side processing." },
  { id: "speex", name: "Speex", kind: "Classic signal processing", note: "Non-AI baseline: spectral noise suppression, similar to what phones did before AI." },
];

export const RATE = 48_000;
const wasm: Partial<Record<Denoiser, Promise<ArrayBuffer>>> = {};
const load = (d: Denoiser) =>
  (wasm[d] ??=
    d === "rnnoise" ? loadRnnoise({ url: "/noise/rnnoise.wasm", simdUrl: "/noise/rnnoise_simd.wasm" }) : d === "gtcrn" ? loadGtcrn({ url: "/noise/gtcrn.wasm" }) : loadSpeex({ url: "/noise/speex.wasm" }));

/** Decode any audio file / URL to mono 48 kHz samples. */
export async function decodeTo48k(data: ArrayBuffer): Promise<Float32Array> {
  const probe = new OfflineAudioContext(1, 1, RATE);
  const buf = await probe.decodeAudioData(data);
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * RATE), RATE);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination); // down-mixes to mono and resamples to 48 kHz
  src.start();
  return (await ctx.startRendering()).getChannelData(0).slice();
}

const energy = (x: Float32Array) => {
  let e = 0;
  for (let i = 0; i < x.length; i += 16) e += x[i] * x[i];
  return e;
};

/** Run a whole clip through a model offline (faster than real time). Returns the output and the time taken. */
export async function denoise(input: Float32Array, model: Denoiser): Promise<{ output: Float32Array; ms: number }> {
  // The models load their WebAssembly asynchronously inside the worklet, and offline rendering doesn't
  // wait for that: pause after the first block until it's ready. If the output is still silent, wait longer.
  for (const waitMs of [300, 1500]) {
    const r = await render(input, model, waitMs);
    if (energy(r.output) > energy(input) * 1e-4 || energy(input) === 0) return r;
  }
  throw new Error("the model produced no audio");
}

/** Resample by rendering through an OfflineAudioContext (the browser's high-quality resampler). */
async function resample(x: Float32Array, from: number, to: number) {
  if (from === to) return x;
  const ctx = new OfflineAudioContext(1, Math.ceil((x.length * to) / from), to);
  const b = ctx.createBuffer(1, x.length, from);
  b.copyToChannel(new Float32Array(x), 0);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.connect(ctx.destination);
  s.start();
  return (await ctx.startRendering()).getChannelData(0).slice();
}

// GTCRN is trained on 16 kHz speech: run it at its native rate. RNNoise and Speex run at 48 kHz.
const NATIVE_RATE: Record<Denoiser, number> = { rnnoise: RATE, gtcrn: 16_000, speex: RATE };

async function render(full: Float32Array, model: Denoiser, waitMs: number): Promise<{ output: Float32Array; ms: number }> {
  const t0 = performance.now();
  const rate = NATIVE_RATE[model];
  const input = await resample(full, RATE, rate);
  const binary = await load(model);
  const ctx = new OfflineAudioContext(1, input.length, rate);
  await ctx.audioWorklet.addModule(`/noise/${model}Worklet.js`);
  const buffer = ctx.createBuffer(1, input.length, rate);
  buffer.copyToChannel(new Float32Array(input), 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const opts = { maxChannels: 1, wasmBinary: binary };
  const node = model === "rnnoise" ? new RnnoiseWorkletNode(ctx as unknown as AudioContext, opts) : model === "gtcrn" ? new GtcrnWorkletNode(ctx as unknown as AudioContext, opts) : new SpeexWorkletNode(ctx as unknown as AudioContext, opts);
  src.connect(node).connect(ctx.destination);
  src.start();
  const quantum = 128 / rate;
  void ctx.suspend(quantum).then(async () => {
    await new Promise((r) => setTimeout(r, waitMs));
    await ctx.resume();
  });
  const rendering = ctx.startRendering();
  const out = await rendering;
  node.destroy();
  const output = await resample(out.getChannelData(0).slice(), rate, RATE);
  return { output: output.length > full.length ? output.subarray(0, full.length) : output, ms: performance.now() - t0 - waitMs };
}
