import { describe, expect, it } from "vitest";
import { backgroundReductionDb, bestLag, siSdr } from "@/lib/audio/quality";

let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const R = 48_000;
// "Speech": a modulated tone with silent gaps; "noise": white noise.
const clean = Float32Array.from({ length: R * 4 }, (_, i) => ((i / R) % 1 < 0.6 ? Math.sin((2 * Math.PI * 220 * i) / R) * Math.sin((Math.PI * ((i / R) % 0.6)) / 0.6) * 0.5 : 0));
const noise = Float32Array.from({ length: clean.length }, () => rnd() * 0.15);
const noisy = clean.map((v, i) => v + noise[i]);

describe("speech-quality measures", () => {
  it("SI-SDR: perfect copy is very high, adding noise lowers it, scaling doesn't matter", () => {
    expect(siSdr(clean, clean)).toBeGreaterThan(60);
    const a = siSdr(clean, noisy);
    expect(a).toBeLessThan(15);
    expect(siSdr(clean, noisy.map((v) => v * 0.3))).toBeCloseTo(a, 5);
  });

  it("finds a model's processing delay so quality isn't misjudged", () => {
    const delayed = new Float32Array(clean.length + 480);
    delayed.set(clean, 480);
    expect(bestLag(clean, delayed)).toBe(480);
    expect(siSdr(clean, delayed, 480)).toBeGreaterThan(60);
    expect(siSdr(clean, delayed, 0)).toBeLessThan(10);
  });

  it("background reduction: with and without a clean reference", () => {
    const denoised = clean.map((v, i) => v + noise[i] * 0.1); // noise 20 dB quieter
    expect(backgroundReductionDb(noisy, denoised, { ref: clean })).toBeCloseTo(20, 0);
    expect(backgroundReductionDb(noisy, denoised)).toBeGreaterThan(15);
    expect(backgroundReductionDb(noisy, noisy, { ref: clean })).toBeCloseTo(0, 5);
  });
});
