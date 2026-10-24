import { wsUrl } from "../providers/indic";

/**
 * Live recognition with IndicConformer (WS /v1/stream). The server finds the end of each utterance
 * itself (Silero VAD) and sends a `final` ~85 ms after the pause. Its times are positions in the audio
 * we sent; we map them back to wall-clock time to measure latency from when the person stopped talking.
 */
export type IndicUtterance = { text: string; language: string; speechStartAt: number; speechEndAt: number; resultAt: number };

const BATCH_BYTES = 3200; // 100 ms of 16 kHz 16-bit audio per message
const SPEECH_PAD_MS = 200; // the server keeps 200 ms after speech; the speaker stopped that much earlier

export class IndicAsrStream {
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private retries = 0;
  private batch: Buffer[] = [];
  private batchBytes = 0;
  private backlog: Buffer[] = [];
  /** Audio ms appended so far (this connection) and the wall time of the latest append. */
  private appendedMs = 0;
  private lastAppendWall = 0;
  private starts = new Map<number, number>();

  constructor(
    private base: string,
    readonly language: string,
    private pauseMs: number,
    private onUtterance: (u: IndicUtterance) => void,
    private onError: (message: string) => void = () => {},
  ) {}

  /** Wall-clock time for a position in the audio we sent (audio arrives in real time from the call). */
  private wallAt(audioMs: number) {
    return this.lastAppendWall - (this.appendedMs - audioMs);
  }

  start() {
    if (this.closed) return;
    const url = `${wsUrl(this.base)}/v1/stream?language=${encodeURIComponent(this.language)}&sample_rate=16000&encoding=pcm_s16le&partials=false`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.appendedMs = 0; // positions restart with each connection
    ws.onopen = () => {
      this.open = true;
      this.retries = 0;
      ws.send(JSON.stringify({ type: "config", vad: { min_silence_ms: this.pauseMs, speech_pad_ms: SPEECH_PAD_MS, max_segment_s: 15 } }));
      for (const b of this.backlog.splice(0)) ws.send(b);
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      let e: { type: string; segment_id?: number; start_ms?: number; end_ms?: number; text?: string; message?: string };
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === "speech_start" && e.segment_id !== undefined) this.starts.set(e.segment_id, this.wallAt(e.start_ms ?? 0));
      else if (e.type === "final") {
        const text = e.text?.trim();
        const startAt = this.starts.get(e.segment_id ?? -1) ?? this.wallAt(e.start_ms ?? 0);
        this.starts.delete(e.segment_id ?? -1);
        if (!text) return;
        this.onUtterance({ text, language: this.language, speechStartAt: startAt, speechEndAt: this.wallAt(Math.max(0, (e.end_ms ?? 0) - SPEECH_PAD_MS)), resultAt: Date.now() });
      } else if (e.type === "error") this.onError(e.message ?? "Indic ASR error");
    };
    ws.onclose = () => {
      this.open = false;
      if (this.closed) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retries++);
      setTimeout(() => this.start(), delay).unref?.();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  append(pcm16k: Buffer) {
    this.batch.push(Buffer.from(pcm16k));
    this.batchBytes += pcm16k.length;
    this.appendedMs += pcm16k.length / 32;
    this.lastAppendWall = Date.now();
    if (this.batchBytes < BATCH_BYTES) return;
    const chunk = Buffer.concat(this.batch);
    this.batch = [];
    this.batchBytes = 0;
    if (this.open && this.ws) this.ws.send(chunk);
    else if (this.backlog.length < 200) this.backlog.push(chunk); // ~20 s while (re)connecting
  }

  close() {
    this.closed = true;
    try {
      this.ws?.send(JSON.stringify({ type: "stop" }));
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
