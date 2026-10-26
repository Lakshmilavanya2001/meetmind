import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEPALIVE_MS, LATE_RESULT_MS, RivaStream, WATCHDOG_MS } from "@/server/interpreter/riva-stream";

type Word = { word: string; start_time: number; end_time: number };

// A stand-in for the realtime WebSocket: records what's sent and lets the test reply as Riva would.
class FakeSocket {
  static last: FakeSocket;
  static opened = 0;
  closed = false;
  sent: { type: string; audio?: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
    FakeSocket.opened++;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.(), 0);
  }
  error(message: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "error", error: { message } }) });
  }
  /** A result; `words` are [text, startMs, endMs] in session audio time. */
  reply(transcript: string, words: [string, number, number][] = []) {
    const w: Word[] = words.map(([word, start_time, end_time]) => ({ word, start_time, end_time }));
    this.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript, words_info: { words: w } }) });
  }
}

const FRAME = Buffer.alloc(3200); // 100 ms of 16 kHz 16-bit audio

describe("RivaStream: placing Parakeet's results", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function open() {
    const got: { text: string; speechStartAt: number; speechEndAt: number }[] = [];
    const errors: string[] = [];
    const s = new RivaStream({ url: "ws://riva", model: "m" } as never, "en", (u) => got.push(u), (m) => errors.push(m));
    s.start();
    await vi.advanceTimersByTimeAsync(1);
    const t0 = Date.now(); // session audio 0 ms is sent at about t0
    return { s, got, errors, ws: FakeSocket.last, t0 };
  }
  /** Feed `ms` of real-time audio. */
  async function speak(s: RivaStream, ms: number) {
    for (let i = 0; i < ms / 100; i++) {
      await vi.advanceTimersByTimeAsync(100);
      s.append(FRAME);
    }
  }

  it("times each line from its words: the moment they were spoken", async () => {
    const { s, got, ws, t0 } = await open();
    await speak(s, 4000);
    s.commit(0, 0);
    await vi.advanceTimersByTimeAsync(600);
    ws.reply("Good morning everyone.", [["Good", 1000, 1200], ["morning", 1300, 1600], ["everyone.", 1700, 2500]]);
    expect(got.map((g) => g.text)).toEqual(["Good morning everyone."]);
    // Audio is sent in 100 ms batches as it's captured, so session 1000 ms was spoken 1.0 s in.
    expect(got[0].speechStartAt - t0).toBe(1000);
    expect(got[0].speechEndAt - t0).toBe(2500);
  });

  it("several results for one pause become several lines, each in its place", async () => {
    const { s, got, ws, t0 } = await open();
    await speak(s, 9000);
    s.commit(0, 0);
    await vi.advanceTimersByTimeAsync(600);
    ws.reply("First sentence.", [["First", 500, 900], ["sentence.", 1000, 1800]]);
    ws.reply("Second sentence.", [["Second", 4000, 4400], ["sentence.", 4500, 5200]]);
    ws.reply("Third one.", [["Third", 7000, 7400], ["one.", 7500, 8000]]);
    expect(got.map((g) => g.text)).toEqual(["First sentence.", "Second sentence.", "Third one."]);
    const starts = got.map((g) => g.speechStartAt - t0);
    expect(starts[0]).toBeLessThan(starts[1]);
    expect(starts[1]).toBeLessThan(starts[2]);
    expect(starts).toEqual([500, 4000, 7000]);
  });

  it("never writes the same speech twice: words for audio already covered are dropped", async () => {
    const { s, got, ws } = await open();
    await speak(s, 6000);
    s.commit(0, 0);
    await vi.advanceTimersByTimeAsync(600);
    ws.reply("Can we move the review", [["Can", 500, 600], ["we", 700, 800], ["move", 900, 1100], ["the", 1200, 1300], ["review", 1400, 1800]]);
    // Riva sends the end of that sentence again, with the rest of it.
    ws.reply("move the review to Friday?", [["move", 900, 1100], ["the", 1200, 1300], ["review", 1400, 1800], ["to", 1900, 2000], ["Friday?", 2100, 2600]]);
    ws.reply("the review", [["the", 1200, 1300], ["review", 1400, 1800]]); // entirely repeated
    expect(got.map((g) => g.text)).toEqual(["Can we move the review", "to Friday?"]);
  });

  it("a pause with only noise (never answered) doesn't move later lines", async () => {
    const { s, got, ws, t0 } = await open();
    await speak(s, 2000);
    s.commit(0, 0); // a cough: Riva sends nothing back
    await speak(s, 5000);
    s.commit(0, 0);
    await vi.advanceTimersByTimeAsync(600);
    // Session audio: speech 0–2000, the cough's padding 2000–3000 (sent at 2.0 s), speech 3000–3800, the nudge's
    // padding 3800–4800 (sent at 2.9 s, since the cough got no answer), then speech again: session 4800 was
    // captured at 2.8 s, so session 5000 is 3.0 s and 6000 is 4.0 s.
    ws.reply("Real words.", [["Real", 5000, 5300], ["words.", 5400, 6000]]);
    expect(got).toHaveLength(1);
    expect(got[0].speechStartAt - t0).toBe(3000);
    expect(got[0].speechEndAt - t0).toBe(4000);
  });

  it("falls back to the pause's times when a result has no word timings", async () => {
    const { s, got, ws } = await open();
    await speak(s, 2000);
    s.commit(111, 222);
    await vi.advanceTimersByTimeAsync(600);
    ws.reply("No timings.");
    expect(got).toEqual([expect.objectContaining({ text: "No timings.", speechStartAt: 111, speechEndAt: 222 })]);
  });

  it("reopens the session when Riva reports an error, and keeps working", async () => {
    const { s, got, errors } = await open();
    const before = FakeSocket.opened;
    FakeSocket.last.error("inference request must specify the START flag on the first request");
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.opened).toBe(before + 1); // a fresh session
    expect(errors[0]).toMatch(/START flag.*reopening/);
    expect(FakeSocket.last.sent[0]).toMatchObject({ type: "transcription_session.update" });
    await speak(s, 2000);
    s.commit(0, 0);
    await vi.advanceTimersByTimeAsync(500);
    FakeSocket.last.reply("Still here.", [["Still", 300, 600], ["here.", 700, 1200]]);
    expect(got.map((g) => g.text)).toEqual(["Still here."]);
  });

  it("reopens a session that stopped answering (watchdog)", async () => {
    const { s, errors } = await open();
    const before = FakeSocket.opened;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS / 2);
      s.commit(0, 0); // the speaker talks; nothing ever comes back
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.opened).toBe(before + 1);
    expect(errors.join(" ")).toMatch(/no results/);
  });

  it("keeps an idle session alive (a muted speaker sends no audio)", async () => {
    const { ws } = await open();
    const audioSent = () => ws.sent.filter((m) => m.type === "input_audio_buffer.append").length;
    expect(audioSent()).toBe(0);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS + 1500);
    expect(audioSent()).toBeGreaterThan(0);
  });

  it("reopens a session whose results come in far behind the speech", async () => {
    const { s, errors } = await open();
    await speak(s, LATE_RESULT_MS + 4000);
    s.commit(0, 0);
    const before = FakeSocket.opened;
    FakeSocket.last.reply("Old words.", [["Old", 300, 600], ["words.", 700, 1200]]); // spoken ~13 s ago
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors.join(" ")).toMatch(/late \(reopening/);
    expect(FakeSocket.opened).toBe(before + 1);
  });
});
