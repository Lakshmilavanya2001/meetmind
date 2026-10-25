import { RIVA_LANG, type RivaConfig } from "../providers/stt";

/**
 * One long-lived Riva (Parakeet) realtime session per speaker. Audio is streamed as it arrives; at each
 * pause we send 1 s of silence plus a commit, which makes the model finalise what was said (≈0.6 s later).
 *
 * Each result is placed by its **word timestamps**, not by which pause it seems to answer. Riva counts time
 * in the audio it has received; we record when each piece of audio was sent, so every word maps back to the
 * moment it was spoken. That stays right when Riva:
 * - sends several results for one pause (it splits sentences itself);
 * - answers late, or not at all (a pause that held only noise);
 * - sends words again for audio it already covered: those words are dropped, so speech never appears twice.
 *
 * Sessions can break on the server ("must specify the START flag", "Internal error from Core"); an idle
 * session (a muted speaker sends no audio) is dropped by the server. So: silence is sent while no audio
 * flows, any error reopens the session, and a watchdog reopens one that stops answering.
 */
const PAD_MS = 1000;
const PAD = Buffer.alloc(32 * PAD_MS); // 1 s of 16 kHz 16-bit silence
const NUDGE_MS = 900;
// Riva's realtime server pays a cost per message: 10 ms frames made results ~4× slower than 100 ms batches.
const BATCH_BYTES = 3200; // 100 ms of 16 kHz 16-bit audio
const BYTES_PER_MS = 32;
export const WATCHDOG_MS = 20_000;
const WATCHDOG_COMMITS = 3;
/** With no audio for this long (muted speaker), send silence so the server keeps the session. */
export const KEEPALIVE_MS = 3000;
const MAX_CLOCK = 3000; // ≈5 min of 100 ms batches

export type RivaUtterance = { text: string; language: string; commitAt: number; speechStartAt: number; speechEndAt: number; resultAt: number };
type Word = { word: string; start_time: number; end_time: number };
/** A stretch of session audio: [from, to) in session ms, sent at `wallAt` (end). Padding isn't real time. */
type Span = { from: number; to: number; wallAt: number; real: boolean };

export class RivaStream {
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private backlog: string[] = [];
  private pending: { commitAt: number; speechStartAt: number; speechEndAt: number }[] = [];
  private nudge: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private batch: Buffer[] = [];
  private batchBytes = 0;
  private lastResultAt = Date.now();
  private lastAudioAt = Date.now();
  private unanswered = 0;
  // Session audio clock (resets with each new session).
  private audioMs = 0;
  private clock: Span[] = [];
  /** Session audio already turned into text: words starting before this are repeats. */
  private doneUntilMs = 0;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: RivaConfig,
    private language: string,
    private onUtterance: (u: RivaUtterance) => void,
    private onError: (message: string) => void = () => {},
  ) {}

  get languageCode() {
    return this.language;
  }

  start() {
    if (this.closed) return;
    const ws = new WebSocket(this.config.url, this.config.apiKey ? ({ headers: { Authorization: `Bearer ${this.config.apiKey}` } } as never) : undefined);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.retries = 0;
      ws.send(JSON.stringify({
        type: "transcription_session.update",
        session: {
          input_audio_transcription: { language: RIVA_LANG[this.language] ?? "en-US", model: this.config.model },
          recognition_config: { enable_automatic_punctuation: true, max_alternatives: 1, enable_word_time_offsets: true },
        },
      }));
      for (const m of this.backlog.splice(0)) ws.send(m);
    };
    ws.onmessage = (m) => {
      let e: { type: string; transcript?: string; words_info?: { words?: Word[] }; error?: { message?: string } };
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (e.type === "error") {
        this.onError(`${e.error?.message ?? "Riva error"} (reopening the session)`);
        return this.reopen();
      }
      if (e.type.endsWith("input_audio_transcription.completed")) this.onResult(e.transcript ?? "", e.words_info?.words ?? []);
    };
    ws.onclose = () => {
      this.open = false;
      if (this.closed) return;
      if (this.pending.length) this.onError(`Riva connection dropped with ${this.pending.length} utterance(s) pending`);
      // A new session starts its own clock: forget this one's timing and the audio queued for it.
      this.pending = [];
      this.backlog = [];
      this.audioMs = 0;
      this.clock = [];
      this.doneUntilMs = 0;
      const delay = Math.min(10_000, 500 * 2 ** this.retries++);
      setTimeout(() => this.start(), delay).unref?.();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    if (!this.keepalive) {
      this.keepalive = setInterval(() => {
        if (!this.open || Date.now() - this.lastAudioAt < KEEPALIVE_MS) return;
        this.sendAudio(PAD, false);
      }, 1000);
      this.keepalive.unref?.();
    }
  }

  private onResult(transcript: string, words: Word[]) {
    const now = Date.now();
    this.lastResultAt = now;
    this.unanswered = 0;
    // Words for audio already covered are repeats: drop them.
    const fresh = words.filter((w) => w.start_time >= this.doneUntilMs - 30);
    if (words.length && !fresh.length) {
      this.settle();
      return;
    }
    let text: string;
    let startAt: number;
    let endAt: number;
    let commitAt = now;
    if (fresh.length) {
      // Keep Riva's own text when nothing was dropped (exact spacing and punctuation).
      text = (fresh.length === words.length ? transcript : fresh.map((w) => w.word).join(" ")).trim();
      const startMs = fresh[0].start_time;
      const endMs = Math.max(...fresh.map((w) => w.end_time));
      this.doneUntilMs = Math.max(this.doneUntilMs, endMs);
      startAt = this.wallAt(startMs);
      endAt = this.wallAt(endMs);
      commitAt = this.settle() ?? now;
    } else {
      // No word timings (shouldn't happen with word offsets on): use the oldest open pause.
      text = transcript.trim();
      const p = this.pending.shift();
      startAt = p?.speechStartAt ?? now - 1000;
      endAt = p?.speechEndAt ?? now - 1000;
      commitAt = p?.commitAt ?? now;
      this.rearm();
    }
    if (text) this.onUtterance({ text, language: this.language, commitAt, speechStartAt: startAt, speechEndAt: endAt, resultAt: now });
  }

  /**
   * A result answers every pause sent before it (results come about 0.6 s after a commit; a pause sent
   * just now is still open). Pauses only drive the nudge and the watchdog: timing comes from the words.
   * Returns when the last answered pause was sent.
   */
  private settle() {
    const cutoff = Date.now() - 150;
    let commitAt: number | undefined;
    while (this.pending.length && this.pending[0].commitAt <= cutoff) commitAt = this.pending.shift()!.commitAt;
    this.rearm();
    return commitAt;
  }

  private rearm() {
    if (this.nudge) clearTimeout(this.nudge);
    this.nudge = null;
    if (this.pending.length) this.armNudge();
  }

  /** Session audio time → when that audio was sent (≈ when it was spoken). */
  private wallAt(ms: number) {
    const c = this.clock;
    if (!c.length) return Date.now();
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].to <= ms) lo = mid + 1;
      else hi = mid;
    }
    const s = c[lo];
    if (ms >= s.to) return s.wallAt; // after everything sent
    if (ms < s.from) return s.wallAt - (s.from - ms); // before the oldest kept span: extrapolate
    return s.real ? s.wallAt - (s.to - ms) : s.wallAt;
  }

  private send(msg: object) {
    const s = JSON.stringify(msg);
    if (this.open && this.ws) this.ws.send(s);
    else if (this.backlog.length < 400) this.backlog.push(s); // ~20 s while connecting
  }

  private sendAudio(buf: Buffer, real: boolean) {
    const from = this.audioMs;
    this.audioMs += buf.length / BYTES_PER_MS;
    this.clock.push({ from, to: this.audioMs, wallAt: Date.now(), real });
    if (this.clock.length > MAX_CLOCK) this.clock.splice(0, this.clock.length - MAX_CLOCK);
    this.send({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
  }

  append(pcm16k: Buffer) {
    this.lastAudioAt = Date.now();
    this.batch.push(Buffer.from(pcm16k)); // copy: frame buffers may be reused
    this.batchBytes += pcm16k.length;
    if (this.batchBytes >= BATCH_BYTES) this.flush();
  }

  private flush() {
    if (!this.batchBytes) return;
    this.sendAudio(Buffer.concat(this.batch), true);
    this.batch = [];
    this.batchBytes = 0;
  }

  /** The speaker paused: finalise what they just said. */
  commit(speechStartAt: number, speechEndAt: number) {
    this.flush();
    this.sendAudio(PAD, false);
    this.send({ type: "input_audio_buffer.commit" });
    this.pending.push({ commitAt: Date.now(), speechStartAt, speechEndAt });
    if (this.pending.length > 20) this.pending.shift();
    if (++this.unanswered >= WATCHDOG_COMMITS && Date.now() - this.lastResultAt > WATCHDOG_MS) {
      this.onError(`no results for ${this.unanswered} pauses (reopening the session)`);
      this.reopen();
      return;
    }
    if (!this.nudge) this.armNudge();
  }

  private armNudge() {
    this.nudge = setTimeout(() => {
      this.nudge = null;
      if (!this.pending.length) return;
      this.sendAudio(PAD, false);
      this.send({ type: "input_audio_buffer.commit" });
    }, NUDGE_MS);
  }

  /** Drop this session and start a fresh one (onclose reconnects). */
  private reopen() {
    this.unanswered = 0;
    this.lastResultAt = Date.now();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  close() {
    this.closed = true;
    if (this.nudge) clearTimeout(this.nudge);
    if (this.keepalive) clearInterval(this.keepalive);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
