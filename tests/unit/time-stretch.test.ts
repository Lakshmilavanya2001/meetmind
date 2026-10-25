import { describe, expect, it } from "vitest";
import { catchUpRate, timeStretch } from "@/server/interpreter/time-stretch";

const RATE = 48_000;
const tone = (hz: number, seconds: number) => Int16Array.from({ length: RATE * seconds }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / RATE)));
// Pitch estimate: zero crossings per second / 2, on the middle part.
const pitch = (s: Int16Array) => {
  const a = s.subarray(Math.floor(s.length * 0.2), Math.floor(s.length * 0.8));
  let z = 0;
  for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) z++;
  return z / 2 / (a.length / RATE);
};

describe("timeStretch (catching up without chipmunk voices)", () => {
  it("makes speech shorter by the rate", () => {
    const out = timeStretch(tone(220, 2), 1.25, RATE);
    expect(out.length / RATE).toBeCloseTo(1.6, 1);
  });
  it("keeps the pitch", () => {
    for (const hz of [140, 220, 440]) expect(Math.abs(pitch(timeStretch(tone(hz, 2), 1.3, RATE)) - hz)).toBeLessThan(hz * 0.03);
  });
  it("keeps the loudness (no dips at the joins)", () => {
    const out = timeStretch(tone(200, 2), 1.2, RATE);
    const mid = out.subarray(RATE * 0.2, RATE * 1.4);
    const rms = Math.sqrt(mid.reduce((s, v) => s + v * v, 0) / mid.length);
    expect(rms).toBeGreaterThan(8000 / Math.SQRT2 * 0.9);
  });
  it("leaves audio alone at normal speed or when it's very short", () => {
    const a = tone(220, 1);
    expect(timeStretch(a, 1, RATE)).toBe(a);
    const blip = tone(220, 0.05);
    expect(timeStretch(blip, 1.3, RATE)).toBe(blip);
  });
  it("speeds up only when a sentence had to wait", () => {
    expect([catchUpRate(0), catchUpRate(900), catchUpRate(1500), catchUpRate(4000)]).toEqual([1, 1, 1.2, 1.3]);
  });
});
