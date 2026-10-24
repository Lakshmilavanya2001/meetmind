"use client";

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

export type NoiseMode = "off" | "standard" | "enhanced";
export const NOISE_MODES: { mode: NoiseMode; label: string; hint: string }[] = [
  { mode: "off", label: "Off", hint: "No noise suppression (echo cancellation stays on)" },
  { mode: "standard", label: "Standard", hint: "Browser noise suppression + echo cancellation" },
  { mode: "enhanced", label: "Enhanced", hint: "AI noise removal (RNNoise) — fans, traffic, typing" },
];

const KEY = "mm.noiseMode";
export function loadNoiseMode(): NoiseMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "off" || v === "standard" || v === "enhanced" ? v : "standard";
  } catch {
    return "standard";
  }
}
export function saveNoiseMode(mode: NoiseMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* preference only */
  }
}

let wasm: Promise<ArrayBuffer> | null = null;

/**
 * LiveKit audio processor that runs the microphone through RNNoise before it is sent.
 * RNNoise works on 48 kHz audio, so it uses its own 48 kHz AudioContext.
 */
export function createRnnoiseProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let ctx: AudioContext | null = null;
  let node: RnnoiseWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;

  const teardown = async () => {
    source?.disconnect();
    node?.destroy();
    node?.disconnect();
    await ctx?.close().catch(() => {});
    ctx = null;
    node = null;
    source = null;
    dest = null;
  };

  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: "rnnoise",
    async init({ track }) {
      wasm ??= loadRnnoise({ url: "/noise/rnnoise.wasm", simdUrl: "/noise/rnnoise_simd.wasm" });
      ctx = new AudioContext({ sampleRate: 48_000 });
      await ctx.audioWorklet.addModule("/noise/rnnoiseWorklet.js");
      node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await wasm });
      source = ctx.createMediaStreamSource(new MediaStream([track]));
      dest = ctx.createMediaStreamDestination();
      source.connect(node).connect(dest);
      processor.processedTrack = dest.stream.getAudioTracks()[0];
    },
    async restart(opts) {
      await teardown();
      await processor.init(opts);
    },
    async destroy() {
      await teardown();
      processor.processedTrack = undefined;
    },
  };
  return processor;
}
