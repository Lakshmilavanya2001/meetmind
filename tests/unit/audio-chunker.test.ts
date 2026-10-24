import { describe, expect, it } from "vitest";
import { encodeWav, resample, SpeechChunker, splitForTranscription } from "@/lib/audio/wav";

const frame = (amp: number) => Float32Array.from({ length: 1600 }, (_, i) => amp * Math.sin(i / 3));

describe("browser audio helpers", () => {
  it("encodes a valid 16 kHz mono WAV header", async () => {
    const blob = encodeWav(new Float32Array(16000));
    const v = new DataView(await blob.arrayBuffer());
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16000);
    expect(blob.size).toBe(44 + 32000);
  });

  it("resamples 48 kHz → 16 kHz", () => {
    expect(resample(new Float32Array(48000), 48000).length).toBe(16000);
  });

  it("emits utterances at pauses, never pure silence", () => {
    const chunks: { durationMs: number; startedAt: number }[] = [];
    const c = new SpeechChunker((x) => chunks.push(x));
    let t = 0;
    const feed = (amp: number, n: number) => { for (let i = 0; i < n; i++) c.push(frame(amp), (t += 100)); };
    feed(0, 50); // 5 s silence → nothing
    expect(chunks).toHaveLength(0);
    feed(0.3, 40); // 4 s speech
    feed(0, 10); // 1 s pause → chunk closes
    expect(chunks).toHaveLength(1);
    expect(chunks[0].durationMs).toBeGreaterThanOrEqual(4000);
    feed(0.3, 250); // 25 s monologue → split at 20 s
    expect(chunks).toHaveLength(2);
    expect(chunks[1].durationMs).toBe(20000);
    c.flush();
    expect(chunks).toHaveLength(3);
  });

  it("keeps capturing a long continuous monologue (regression: adaptive floor swallowed speech)", () => {
    const chunks: { durationMs: number }[] = [];
    const c = new SpeechChunker((x) => chunks.push(x));
    for (let i = 0; i < 1200; i++) c.push(frame(0.3), i * 100); // 2 minutes without a pause
    c.flush();
    expect(chunks.reduce((n, x) => n + x.durationMs, 0)).toBeGreaterThanOrEqual(119_000);
  });

  it("splits long recordings near quiet points", () => {
    const rate = 16000;
    const audio = Float32Array.from({ length: rate * 50 }, (_, i) => (Math.floor(i / rate) % 10 === 9 ? 0 : 0.3 * Math.sin(i / 5)));
    const parts = splitForTranscription(audio, 20_000);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.samples.length <= rate * 20)).toBe(true);
    expect(parts.reduce((n, p) => n + p.samples.length, 0)).toBe(audio.length);
  });
});
