import { RIVA_LANG, type RivaConfig } from "../providers/stt";

/**
 * One long-lived Riva realtime session per speaker. Audio is streamed as it arrives; at each pause
 * we send 1 s of silence plus a commit, which makes the streaming model finalise the utterance
 * (≈0.6 s later). If nothing comes back within NUDGE_MS we repeat the silence + commit once.
 */
const PAD = Buffer.alloc(32000); // 1 s of 16 kHz 16-bit silence
const NUDGE_MS = 900;
// Riva's realtime server pays a cost per message: 10 ms frames made results ~4× slower than 100 ms batches.
const BATCH_BYTES = 3200; // 100 ms of 16 kHz 16-bit audio

export type RivaUtterance = { text: string; language: string; commitAt: number; speechStartAt: number; speechEndAt: number; resultAt: number };

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
      let e: { type: string; transcript?: string; error?: { message?: string } };
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (e.type === "error") return this.onError(e.error?.message ?? "Riva error");
      if (!e.type.endsWith("input_audio_transcription.completed")) return;
      const text = e.transcript?.trim();
      if (!text) return;
      const p = this.pending.shift();
      if (this.nudge) clearTimeout(this.nudge);
      this.nudge = null;
      if (this.pending.length) this.armNudge();
      if (p) this.onUtterance({ text, language: this.language, ...p, resultAt: Date.now() });
    };
    ws.onclose = () => {
      this.open = false;
      if (this.closed) return;
      // Reconnect with backoff; utterances in flight are lost (rare, and logged).
      if (this.pending.length) this.onError(`Riva connection dropped with ${this.pending.length} utterance(s) pending`);
      this.pending = [];
      const delay = Math.min(10_000, 500 * 2 ** this.retries++);
      setTimeout(() => this.start(), delay).unref?.();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private send(msg: object) {
    const s = JSON.stringify(msg);
    if (this.open && this.ws) this.ws.send(s);
    else if (this.backlog.length < 400) this.backlog.push(s); // ~20 s while connecting
  }

  append(pcm16k: Buffer) {
    this.batch.push(Buffer.from(pcm16k)); // copy: frame buffers may be reused
    this.batchBytes += pcm16k.length;
    if (this.batchBytes >= BATCH_BYTES) this.flush();
  }

  private flush() {
    if (!this.batchBytes) return;
    this.send({ type: "input_audio_buffer.append", audio: Buffer.concat(this.batch).toString("base64") });
    this.batch = [];
    this.batchBytes = 0;
  }

  /** The speaker paused: finalise what they just said. */
  commit(speechStartAt: number, speechEndAt: number) {
    this.flush();
    this.send({ type: "input_audio_buffer.append", audio: PAD.toString("base64") });
    this.send({ type: "input_audio_buffer.commit" });
    this.pending.push({ commitAt: Date.now(), speechStartAt, speechEndAt });
    if (!this.nudge) this.armNudge();
  }

  private armNudge() {
    this.nudge = setTimeout(() => {
      this.nudge = null;
      if (!this.pending.length) return;
      this.send({ type: "input_audio_buffer.append", audio: PAD.toString("base64") });
      this.send({ type: "input_audio_buffer.commit" });
    }, NUDGE_MS);
  }

  close() {
    this.closed = true;
    if (this.nudge) clearTimeout(this.nudge);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
