import { describe, expect, it } from "vitest";
import { cutPoints, labelSpeakers, mergeTurns, toRecordingMs } from "@/server/transcription/diarize";

describe("whole-call speaker separation helpers", () => {
  it("cuts long audio about every 25 s, at the quietest moment nearby", () => {
    const pcm = new Int16Array(16000 * 60).fill(8000);
    pcm.fill(0, 16000 * 26, 16000 * 26 + 1600); // a pause at 26 s
    const cuts = cutPoints(pcm);
    expect(cuts.length).toBe(2);
    expect(Math.abs(cuts[0] - (16000 * 26 + 800))).toBeLessThan(1600);
  });

  it("maps Riva time (with 1 s silences inserted at each cut) back to the recording", () => {
    const padsAt = [26_000, 52_000]; // silences began here in Riva's timeline
    expect(toRecordingMs(10_000, padsAt)).toBe(10_000);
    expect(toRecordingMs(30_000, padsAt)).toBe(29_000);
    expect(toRecordingMs(60_000, padsAt)).toBe(58_000);
  });

  it("labels speakers by first appearance and merges a speaker's consecutive lines into a turn", () => {
    const segs = mergeTurns([
      { speaker: 3, text: "Hi Priya.", startMs: 0, endMs: 1000 },
      { speaker: 7, text: "Hi Rohan.", startMs: 1500, endMs: 2500 },
      { speaker: 7, text: "We want 5G.", startMs: 3000, endMs: 4000 },
      { speaker: 3, text: "Great.", startMs: 9000, endMs: 9500 },
      { speaker: 3, text: "Much later.", startMs: 20_000, endMs: 21_000 },
    ]);
    expect(labelSpeakers(segs).map((s) => [s.label, s.text])).toEqual([
      ["Speaker 1", "Hi Priya."],
      ["Speaker 2", "Hi Rohan. We want 5G."],
      ["Speaker 1", "Great."],
      ["Speaker 1", "Much later."],
    ]);
  });
});
