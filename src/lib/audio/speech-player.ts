"use client";

/**
 * Plays spoken replies with as little delay as possible.
 *
 * - Text is spoken sentence by sentence, so the first sentence can start while the rest of the reply is
 *   still being written by the assistant (`feed` the text as it grows, then `end`).
 * - Each sentence is fetched from /api/voice/speak with `stream: true`. Indian languages and English come
 *   back as raw PCM ("audio/L16") while they're being generated, and play as the chunks arrive (first
 *   audio ≈ 0.4 s). Other languages come back as one WAV.
 * - The next sentence is requested while the current one plays, so there is no gap between them.
 * - If the server has no voice for the language, the browser's own voice reads it.
 */

const BCP47: Record<string, string> = { en: "en-US", hi: "hi-IN", bn: "bn-IN", ta: "ta-IN", te: "te-IN", mr: "mr-IN", gu: "gu-IN", kn: "kn-IN", ml: "ml-IN", pa: "pa-IN", ur: "ur-IN", es: "es-ES", fr: "fr-FR", de: "de-DE" };

/** Markdown → plain spoken text. */
export function speakable(md: string) {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/[*_#>✓|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split off the complete sentences at the start of `text`. Returns them and how many characters they used.
 * Very short sentences are joined to the next one so each request carries enough text to sound natural.
 */
export function takeSentences(text: string, final: boolean): { sentences: string[]; used: number } {
  const sentences: string[] = [];
  let used = 0;
  let pending = "";
  const re = /[^.!?।॥\n]*(?:[.!?।॥]+["')\]]*|\n+)(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length > 0) {
    // A sentence at the very end of streamed text may still grow ("3.5" → "3.50 pm"): wait for more.
    if (!final && m.index + m[0].length >= text.length) break;
    pending += m[0];
    used = m.index + m[0].length;
    const s = speakable(pending);
    if (s.length >= 24) {
      sentences.push(s);
      pending = "";
    }
  }
  if (final) {
    const rest = speakable(pending + text.slice(used));
    if (rest) sentences.push(rest);
    used = text.length;
  } else if (pending) {
    used -= pending.length; // keep the short sentence for the next call
  }
  return { sentences, used };
}

type Job = { text: string; language: string; audio: Promise<Response | null> | null; abort: AbortController };

export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private cursor = 0;
  private queue: Job[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private running = false;
  private stopped = false;
  private idle: (() => void)[] = [];
  private consumed = 0;

  constructor(private languageOf: (text: string) => string) {}

  /** Speak the new complete sentences in `fullText` (the whole reply so far). */
  feed(fullText: string) {
    this.stopped = false;
    const { sentences, used } = takeSentences(fullText.slice(this.consumed), false);
    this.consumed += used;
    for (const s of sentences) this.enqueue(s);
  }

  /** The reply is complete: speak whatever is left. Resolves when everything has been played. */
  end(fullText: string): Promise<void> {
    const { sentences } = takeSentences(fullText.slice(this.consumed), true);
    this.consumed = 0;
    for (const s of sentences) this.enqueue(s);
    return this.whenIdle();
  }

  /** Speak one complete text. Resolves when it has been played. */
  say(text: string): Promise<void> {
    this.stopped = false;
    this.consumed = 0;
    return this.end(text);
  }

  get speaking() {
    return this.running || this.queue.length > 0;
  }

  whenIdle(): Promise<void> {
    if (!this.speaking) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  /** Stop at once and forget everything queued. */
  stop() {
    this.stopped = true;
    this.consumed = 0;
    for (const j of this.queue) j.abort.abort();
    this.queue = [];
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.cursor = 0;
  }

  private enqueue(text: string) {
    if (!text) return;
    const language = this.languageOf(text);
    const abort = new AbortController();
    // Request at most one sentence ahead of the one playing, so the voice server isn't flooded.
    const job: Job = { text, language, abort, audio: null };
    this.queue.push(job);
    if (this.queue.length <= 2) job.audio = this.request(job);
    if (!this.running) void this.run();
  }

  private request(job: Job) {
    return fetch("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: job.text.slice(0, 800), language: job.language, stream: true }),
      signal: job.abort.signal,
    })
      .then((r) => (r.ok ? r : null))
      .catch(() => null);
  }

  private async run() {
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue[0];
        job.audio ??= this.request(job);
        const res = await job.audio;
        // Fetch the sentence after this one while this one plays.
        const after = this.queue[1];
        if (after) after.audio ??= this.request(after);
        if (this.stopped) break;
        if (res) await this.play(res);
        else await this.browserVoice(job.text, job.language);
        this.queue.shift();
      }
    } finally {
      this.running = false;
      if (!this.queue.length || this.stopped) {
        for (const r of this.idle.splice(0)) r();
      } else void this.run();
    }
  }

  private audioCtx() {
    if (!this.ctx || this.ctx.state === "closed") this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Schedule samples right after what's already queued; returns when they will have finished. */
  private schedule(samples: Float32Array, rate: number) {
    const ctx = this.audioCtx();
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(this.cursor, ctx.currentTime + 0.12); // small cushion against network jitter
    src.start(at);
    this.cursor = at + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  private untilDone() {
    const ctx = this.audioCtx();
    const ms = Math.max(0, (this.cursor - ctx.currentTime) * 1000);
    return new Promise<void>((r) => setTimeout(r, ms + 30));
  }

  private async play(res: Response) {
    const type = res.headers.get("content-type") ?? "";
    if (type.startsWith("audio/L16") && res.body) {
      const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? 24000);
      const reader = res.body.getReader();
      let carry: Uint8Array | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (this.stopped) {
          void reader.cancel();
          return;
        }
        if (done) break;
        let bytes = value;
        if (carry) {
          const joined = new Uint8Array(carry.length + bytes.length);
          joined.set(carry);
          joined.set(bytes, carry.length);
          bytes = joined;
          carry = null;
        }
        const even = bytes.length - (bytes.length % 2);
        if (even < bytes.length) carry = bytes.slice(even);
        if (!even) continue;
        const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even));
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
        this.schedule(f, rate);
      }
    } else {
      const ctx = this.audioCtx();
      try {
        const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
        this.schedule(decoded.getChannelData(0), decoded.sampleRate);
      } catch {
        return;
      }
    }
    await this.untilDone();
  }

  private browserVoice(text: string, language: string) {
    return new Promise<void>((resolve) => {
      if (typeof speechSynthesis === "undefined" || this.stopped) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = BCP47[language] ?? language;
      const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(u.lang.toLowerCase().slice(0, 2)));
      if (voice) u.voice = voice;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}
