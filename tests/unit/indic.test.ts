import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndicAsrStream } from "@/server/interpreter/indic-asr-stream";
import { IndicTtsStream } from "@/server/interpreter/indic-tts-stream";
import { createIndicSttProvider, indicCovers, indicTranslate } from "@/server/providers/indic";
import { interpreterLanguageCodes } from "@/server/interpreter/constants";

/** Minimal stand-in for the browser/Node WebSocket, driven by the test. */
class FakeWS {
  static last: FakeWS;
  sent: (string | Uint8Array)[] = [];
  binaryType = "blob";
  onopen?: () => void;
  onmessage?: (m: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.onclose?.();
  }
  json(o: object) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWS);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.INDIC_ASR_URL;
});

describe("Indic live recognition stream", () => {
  it("configures the pause, batches audio in 100 ms messages and maps times back to the wall clock", () => {
    const got: { text: string; speechEndAt: number; speechStartAt: number }[] = [];
    const s = new IndicAsrStream("http://asr", "hi", 500, (u) => got.push(u));
    s.start();
    const ws = FakeWS.last;
    expect(ws.url).toBe("ws://asr/v1/stream?language=hi&sample_rate=16000&encoding=pcm_s16le&partials=false");
    ws.onopen!();
    expect(JSON.parse(ws.sent[0] as string)).toMatchObject({ type: "config", vad: { min_silence_ms: 500, speech_pad_ms: 200 } });
    const t0 = Date.now();
    // 3 s of audio arriving in real time, 10 ms at a time.
    for (let i = 0; i < 300; i++) {
      vi.advanceTimersByTime(10);
      s.append(Buffer.alloc(320));
    }
    expect(ws.sent.slice(1).every((b) => (b as Uint8Array).length === 3200)).toBe(true);
    expect(ws.sent).toHaveLength(1 + 30);
    ws.json({ type: "speech_start", segment_id: 1, start_ms: 500 });
    ws.json({ type: "final", segment_id: 1, text: "नमस्ते", start_ms: 500, end_ms: 2700 });
    expect(got[0].text).toBe("नमस्ते");
    expect(got[0].speechStartAt - t0).toBe(500); // audio position 500 ms = 0.5 s after the first frame began
    expect(got[0].speechEndAt - t0).toBe(2500); // end_ms minus the 200 ms pad
  });
});

describe("Indic streamed speech", () => {
  it("plays lines strictly in order and reports timing per line", async () => {
    const audio: number[] = [];
    const tts = new IndicTtsStream("http://tts", "hi", (pcm) => audio.push(pcm[0]));
    tts.start();
    const ws = FakeWS.last;
    const first = tts.speak("पहली");
    const second = tts.speak("दूसरी");
    ws.onopen!();
    expect(ws.sent.map((m) => JSON.parse(m as string).text)).toEqual(["पहली", "दूसरी"]);
    vi.advanceTimersByTime(100);
    ws.json({ type: "start", id: "l1" });
    vi.advanceTimersByTime(350);
    ws.onmessage!({ data: new Int16Array([1, 1]).buffer });
    ws.json({ type: "done", id: "l1" });
    ws.json({ type: "start", id: "l2" });
    vi.advanceTimersByTime(300);
    ws.onmessage!({ data: new Int16Array([2, 2]).buffer });
    expect(audio).toEqual([1, 2]);
    expect(await first).toMatchObject({ queueMs: 100, ttsMs: 350 });
    expect(await second).toMatchObject({ queueMs: 450, ttsMs: 300 });
  });

  it("a dropped connection resolves pending lines instead of hanging", async () => {
    const tts = new IndicTtsStream("http://tts", "ta", () => {});
    tts.start();
    const p = tts.speak("வணக்கம்");
    FakeWS.last.onopen!();
    FakeWS.last.onclose!();
    expect(await p).toBeNull();
    tts.close();
  });
});

describe("Indic translation and file recognition", () => {
  it("translation: one or many lines; a cut-off result counts as a failure", async () => {
    process.env.INDIC_TRANSLATE_URL = "http://mt";
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      return new Response(JSON.stringify(b.texts ? { translations: [{ translation: "एक" }, { translation: "दो…", finish_reason: "length" }] } : { translation: "नमस्ते" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await indicTranslate(["Hello"], "hi")).toEqual(["नमस्ते"]);
    expect(await indicTranslate(["one", "two"], "hi")).toEqual(["एक", ""]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "Hello", tgt_lang: "hi" });
    delete process.env.INDIC_TRANSLATE_URL;
  });

  it("file recognition posts the audio with the language and the accurate decoder", async () => {
    const calls: string[] = [];
    const stt = createIndicSttProvider("http://asr", (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ text: " नमस्ते आज " }));
    }) as unknown as typeof fetch);
    expect(await stt.transcribe(Buffer.from("RIFF"), { mimeType: "audio/wav", language: "ta" })).toEqual({ text: "नमस्ते आज", language: "ta" });
    expect(calls[0]).toBe("http://asr/v1/transcribe?language=ta&decoding=rnnt");
  });

  it("language coverage and the interpreter's language list", () => {
    expect([indicCovers("en"), indicCovers("ta"), indicCovers("es"), indicCovers(null)]).toEqual([true, true, false, false]);
    expect(interpreterLanguageCodes()).toEqual(["en", "hi", "es"]);
    process.env.INDIC_ASR_URL = "http://asr";
    const all = interpreterLanguageCodes();
    expect(all).toHaveLength(24);
    expect(all).toEqual(expect.arrayContaining(["en", "es", "hi", "ta", "te", "bn", "sat", "ur"]));
  });
});
