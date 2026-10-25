import { describe, expect, it } from "vitest";
import { UtteranceSegmenter, DEFAULT_SEGMENTER, segmenterOptions, WAKE_PAUSE_MS, type SegmentEvent } from "@/server/interpreter/segmenter";
import { parseWav, resampleInt16, toMono } from "@/server/interpreter/audio";

const frame = (level: number, ms = 10) => {
  const n = (16000 * ms) / 1000;
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(i / 3) * level * 32767);
  return a;
};
function feed(seg: UtteranceSegmenter, parts: [number, number][], t0 = 0) {
  const events: { at: number; ev: ReturnType<UtteranceSegmenter["push"]> }[] = [];
  let t = t0;
  for (const [level, ms] of parts) for (let i = 0; i < ms; i += 10) {
    t += 10;
    const ev = seg.push(frame(level), t);
    if (ev) events.push({ at: t, ev });
  }
  return events;
}

describe("utterance segmenter", () => {
  it("ends an utterance after the configured pause, and remembers when the voice stopped", () => {
    const seg = new UtteranceSegmenter();
    const ev = feed(seg, [[0, 500], [0.3, 1200], [0, 1000]]);
    expect(ev.map((e) => e.ev!.type)).toEqual(["start", "end"]);
    expect(ev[1].at - seg.lastVoiceAt).toBe(DEFAULT_SEGMENTER.endSilenceMs);
    expect(ev[1].ev).toMatchObject({ speechMs: 1200, forced: false });
  });

  it("a short pause inside a sentence doesn't split it", () => {
    const seg = new UtteranceSegmenter();
    const ev = feed(seg, [[0.3, 800], [0, 400], [0.3, 800], [0, 1000]]);
    expect(ev.filter((e) => e.ev!.type === "end")).toHaveLength(1);
  });

  it("ignores clicks, and learns a noisy room's background level", () => {
    const seg = new UtteranceSegmenter();
    expect(feed(seg, [[0.3, 100], [0, 1000]]).filter((e) => e.ev!.type === "end")).toHaveLength(0);
    // A fan switches on after silence: at first it may look like speech, but within 5 s it becomes
    // the noise floor, so the "utterance" ends and real speech over the fan is still detected.
    const fan = feed(seg, [[0.03, 8000]]);
    expect(fan.filter((e) => e.ev!.type === "end").length).toBeLessThanOrEqual(1);
    expect(feed(seg, [[0.5, 1000], [0.03, 1500]]).filter((e) => e.ev!.type === "end")).toHaveLength(1);
  });

  it("forces a cut in a very long monologue", () => {
    const seg = new UtteranceSegmenter();
    // Fast speech: 1.2 s phrases with only 250 ms dips between them, for 16 s.
    const ev = feed(seg, Array.from({ length: 11 }, () => [[0.3, 1200], [0.005, 250]] as [number, number][]).flat());
    expect(ev.find((e) => e.ev!.type === "end")!.ev).toMatchObject({ forced: true });
  });

  it("the pause is configurable within safe bounds", () => {
    expect(segmenterOptions({ INTERPRETER_PAUSE_MS: "800" }).endSilenceMs).toBe(800);
    expect(segmenterOptions({ INTERPRETER_PAUSE_MS: "50" }).endSilenceMs).toBe(300);
    expect(segmenterOptions({}).endSilenceMs).toBe(600); // default since 2026-10-25 (measured: 0.2 s faster, still whole sentences)
  });
});

describe("interpreter audio helpers", () => {
  it("parses 16-bit WAV, mixes to mono and resamples", () => {
    const samples = Int16Array.from([100, 300, -100, -300]); // 2 stereo frames
    const data = Buffer.from(samples.buffer);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(96000, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(data.length, 40);
    const wav = parseWav(Buffer.concat([h, data]));
    expect(wav).toMatchObject({ sampleRate: 24000, channels: 2 });
    expect([...toMono(wav.samples, 2)]).toEqual([200, -200]);
    expect(resampleInt16(new Int16Array(240), 24000, 48000)).toHaveLength(480);
    expect(() => parseWav(Buffer.from("nope"))).toThrow();
  });
});

describe("utterance segmenter: per-speaker pause", () => {
  it("the pause can change during a call (shorter normally, longer while listening for Hey Mind)", () => {
    const seg = new UtteranceSegmenter({ ...DEFAULT_SEGMENTER, endSilenceMs: 600 });
    const at = (ms: number) => ms;
    let t = 0;
    const push = (level: number, ms: number) => {
      const out: (SegmentEvent | null)[] = [];
      for (let i = 0; i < ms / 100; i++) out.push(seg.push(new Int16Array(1600).fill(Math.round(level * 32767)), at((t += 100))));
      return out.filter(Boolean);
    };
    push(0.3, 1000);
    expect(push(0, 700).some((e) => e!.type === "end")).toBe(true); // 600 ms of silence ends it
    seg.setEndSilence(WAKE_PAUSE_MS);
    expect(seg.endSilenceMs).toBe(800);
    push(0.3, 1000);
    expect(push(0, 700).some((e) => e!.type === "end")).toBe(false); // 700 ms isn't enough now
    expect(push(0, 200).some((e) => e!.type === "end")).toBe(true);
  });
});
