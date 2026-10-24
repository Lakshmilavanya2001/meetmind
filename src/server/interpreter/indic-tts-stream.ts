import { wsUrl } from "../providers/indic";

/**
 * One Indic Speak socket (WS /v1/stream) for one output language. Requests on a socket are spoken
 * one at a time, in order, and audio streams back as it's generated (first audio ≈ 0.38 s), so a
 * line starts playing long before it's fully synthesised.
 */
export const TTS_RATE = 48_000;
type Pending = { requestAt: number; startAt?: number; resolve: (v: { ttsMs: number; queueMs: number; playAt: number } | null) => void; resolved: boolean };

export class IndicTtsStream {
  private ws: WebSocket | null = null;
  private open = false;
  private closed = false;
  private retries = 0;
  private seq = 0;
  private current: string | null = null;
  private pending = new Map<string, Pending>();
  private backlog: string[] = [];

  constructor(
    private base: string,
    readonly language: string,
    /** Receives the audio of each line, in order (16-bit mono PCM at TTS_RATE). */
    private onAudio: (pcm: Int16Array) => void,
  ) {}

  start() {
    if (this.closed) return;
    const ws = new WebSocket(`${wsUrl(this.base)}/v1/stream`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.retries = 0;
      for (const m of this.backlog.splice(0)) ws.send(m);
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") {
        const p = this.current ? this.pending.get(this.current) : undefined;
        if (p && !p.resolved) {
          const now = Date.now();
          p.resolved = true;
          p.resolve({ queueMs: (p.startAt ?? now) - p.requestAt, ttsMs: now - (p.startAt ?? p.requestAt), playAt: now });
        }
        const buf = m.data as ArrayBuffer;
        this.onAudio(new Int16Array(buf, 0, Math.floor(buf.byteLength / 2)));
        return;
      }
      let e: { type: string; id?: string; message?: string };
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === "start" && e.id) {
        this.current = e.id;
        const p = this.pending.get(e.id);
        if (p) p.startAt = Date.now();
      } else if ((e.type === "done" || e.type === "cancelled" || e.type === "error") && e.id) {
        this.finish(e.id);
        if (e.type === "error") console.error(`[interpreter] TTS (${this.language}): ${e.message}`);
      }
    };
    ws.onclose = () => {
      this.open = false;
      for (const id of [...this.pending.keys()]) this.finish(id); // lines in flight are lost
      if (this.closed) return;
      setTimeout(() => this.start(), Math.min(10_000, 500 * 2 ** this.retries++)).unref?.();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private finish(id: string) {
    const p = this.pending.get(id);
    if (p && !p.resolved) {
      p.resolved = true;
      p.resolve(null);
    }
    this.pending.delete(id);
    if (this.current === id) this.current = null;
  }

  /** Queue a line; resolves when its first audio arrives (or null if it produced none). */
  speak(text: string) {
    const id = `l${++this.seq}`;
    const msg = JSON.stringify({ type: "synthesize", id, text, language: this.language, sample_rate: TTS_RATE, format: "pcm_s16le" });
    return new Promise<{ ttsMs: number; queueMs: number; playAt: number } | null>((resolve) => {
      this.pending.set(id, { requestAt: Date.now(), resolve, resolved: false });
      if (this.open && this.ws) this.ws.send(msg);
      else this.backlog.push(msg);
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
