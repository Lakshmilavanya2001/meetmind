/** Runs against the real Riva server when reachable (RIVA_REALTIME_URL); skipped otherwise. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRivaSttProvider, readRivaConfig, wavToPcm16 } from "@/server/providers/stt";

const config = readRivaConfig();
const reachable = config ? await fetch(config.url.replace(/^ws/, "http").replace(/\/v1\/realtime.*$/, "/v1/health/ready")).then((r) => r.ok, () => false) : false;

describe("wavToPcm16", () => {
  it("accepts 16 kHz mono WAV and rejects other audio", () => {
    expect(wavToPcm16(readFileSync("tests/fixtures/rahul-16k.wav")).length).toBeGreaterThan(100_000);
    expect(() => wavToPcm16(Buffer.from("not audio at all"))).toThrow(/WAV/);
  });
});

describe.skipIf(!reachable)("Riva streaming STT (real server)", () => {
  const stt = createRivaSttProvider(config!);

  it("transcribes English with punctuation and word timings", async () => {
    const r = await stt.transcribe(readFileSync("tests/fixtures/rahul-16k.wav"), { mimeType: "audio/wav", language: "en" });
    expect(r.text.toLowerCase()).toMatch(/api integration/);
    expect(r.text).toMatch(/[.,]/);
    expect(r.words!.length).toBeGreaterThan(5);
  });

  it("separates two speakers and keeps the final sentence", async () => {
    const r = await stt.transcribe(readFileSync("tests/fixtures/two-16k.wav"), { mimeType: "audio/wav", language: "en", diarize: true });
    expect(r.text.toLowerCase()).toMatch(/april the 10th|april the tenth/);
    expect(new Set(r.words!.map((w) => w.speaker)).size).toBeGreaterThanOrEqual(2);
  });

  it("recognises Hindi (Devanagari output)", async () => {
    const r = await stt.transcribe(readFileSync("tests/fixtures/hindi-16k.wav"), { mimeType: "audio/wav", language: "hi" });
    expect(r.text).toMatch(/[ऀ-ॿ]/);
  });
});
