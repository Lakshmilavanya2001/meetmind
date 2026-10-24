import { describe, expect, it } from "vitest";
import { parseTimestamp, parseTranscriptFile } from "@/server/transcript-import";

describe("transcript import parsing", () => {
  it("parses WebVTT with voice tags and hours", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.500
<v Rahul Sharma>We will ship the API by November 15.</v>

01:02:03.250 --> 01:02:05.000
<v Priya Patel>Agreed.`;
    const r = parseTranscriptFile(vtt);
    expect(r.format).toBe("vtt");
    expect(r.segments).toEqual([
      { startMs: 1000, endMs: 4500, speaker: "Rahul Sharma", text: "We will ship the API by November 15." },
      { startMs: 3723250, endMs: 3725000, speaker: "Priya Patel", text: "Agreed." },
    ]);
  });

  it("parses SRT with 'Name: text' lines", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
Amit Kumar: Budget is fifty thousand.

2
00:00:03,000 --> 00:00:04,000
no speaker here`;
    const r = parseTranscriptFile(srt, "call.srt");
    expect(r.format).toBe("srt");
    expect(r.segments.map((s) => [s.speaker, s.text])).toEqual([["Amit Kumar", "Budget is fifty thousand."], [null, "no speaker here"]]);
  });

  it("parses plain text, with and without timestamps", () => {
    const timed = parseTranscriptFile("[00:10] Rahul: hello\n[00:25] Priya: hi there");
    expect(timed.approximateTimes).toBe(false);
    expect(timed.segments.map((s) => [s.startMs, s.endMs, s.speaker])).toEqual([[10000, 25000, "Rahul"], [25000, 30000, "Priya"]]);
    const untimed = parseTranscriptFile("Rahul: first\nPriya: second");
    expect(untimed.approximateTimes).toBe(true);
    expect(untimed.segments.map((s) => s.startMs)).toEqual([0, 5000]);
  });

  it("parses timestamps", () => {
    expect(parseTimestamp("00:01:02.5")).toBe(62500);
    expect(parseTimestamp("1:02")).toBe(62000);
    expect(parseTimestamp("nope")).toBeNull();
  });
});
