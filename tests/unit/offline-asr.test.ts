import { describe, expect, it, vi } from "vitest";
import { OfflineAsr, offlineAsrLanguages, pcmToWav } from "@/server/interpreter/offline-asr";
import type { SttProvider } from "@/server/providers/stt";

const FRAME = 3200; // 100 ms of 16 kHz 16-bit audio

/** Feeds `seconds` of 100 ms frames ending at `endAt` (wall-clock ms). */
function feed(asr: OfflineAsr, endAt: number, seconds: number) {
  const n = Math.round(seconds * 10);
  for (let i = 0; i < n; i++) asr.append(Buffer.alloc(FRAME, i % 250), endAt - (n - 1 - i) * 100);
}

/** A stand-in STT server: records each request; `reply` decides the answer. */
function fakeStt(reply: (call: number) => { text?: string; delayMs?: number; fail?: boolean }) {
  const calls: { language?: string; audioBytes: number }[] = [];
  const stt: SttProvider = {
    model: "granite",
    languages: ["en", "fr", "de", "es", "pt", "ja"],
    transcribe: vi.fn(async (audio: Buffer, opts: { language?: string }) => {
      calls.push({ language: opts.language, audioBytes: audio.length - 44 });
      const r = reply(calls.length - 1);
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (r.fail) throw new Error("Speech-to-text service error 503");
      return { text: r.text ?? "" };
    }),
  };
  return { calls, stt };
}

describe("offline recognition for the interpreter", () => {
  it("sends one utterance, cut by time with a little before and after, in the speaker's language", async () => {
    const { calls, stt } = fakeStt(() => ({ text: " can we move the review to friday " }));
    const got: { text: string; speechStartAt: number; speechEndAt: number }[] = [];
    const asr = new OfflineAsr(stt, "en", (u) => got.push(u));
    feed(asr, 10_000, 5); // audio from 5.1 s to 10.0 s
    asr.commit(7_000, 9_000);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(calls[0].language).toBe("en");
    // 6.7 s .. 9.2 s: 300 ms before speech started, 200 ms after it ended
    expect(calls[0].audioBytes).toBe(2_500 * 32);
    expect(got[0]).toMatchObject({ text: "can we move the review to friday", speechStartAt: 7_000, speechEndAt: 9_000 });
  });

  it("keeps lines in order when an earlier request is slower", async () => {
    const { stt } = fakeStt((n) => (n === 0 ? { text: "first", delayMs: 50 } : { text: "second" }));
    const got: string[] = [];
    const asr = new OfflineAsr(stt, "en", (u) => got.push(u.text));
    feed(asr, 10_000, 8);
    asr.commit(3_000, 5_000);
    asr.commit(6_000, 9_000);
    await vi.waitFor(() => expect(got).toEqual(["first", "second"]));
  });

  it("skips audio it no longer has and reports failures without stopping", async () => {
    let fail = true;
    const { calls, stt } = fakeStt(() => (fail ? { fail: true } : { text: "back" }));
    const errors: string[] = [];
    const got: string[] = [];
    const asr = new OfflineAsr(stt, "en", (u) => got.push(u.text), (m) => errors.push(m));
    feed(asr, 10_000, 5); // audio from 5.1 s to 10.0 s
    asr.commit(1_000, 1_100); // no audio kept for that time: nothing to send
    asr.commit(6_000, 8_000);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    fail = false;
    asr.commit(6_000, 8_000);
    await vi.waitFor(() => expect(got).toEqual(["back"]));
    expect(calls).toHaveLength(2);
  });

  it("is on only for listed languages the STT server covers", () => {
    const { stt } = fakeStt(() => ({}));
    expect([...offlineAsrLanguages(stt, { INTERPRETER_OFFLINE_ASR_LANGUAGES: "en, hi" })]).toEqual(["en"]);
    expect(offlineAsrLanguages(stt, {}).size).toBe(0);
    expect(offlineAsrLanguages(null, { INTERPRETER_OFFLINE_ASR_LANGUAGES: "en" }).size).toBe(0);
  });

  it("writes a 16 kHz mono WAV header", () => {
    const wav = pcmToWav(Buffer.alloc(320));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(320);
  });
});
