import { RIVA_LANG, type RivaConfig } from "../providers/stt";

/**
 * Transcribe a whole recording in ONE Riva session with speaker separation, so "Speaker 1" means
 * the same person throughout (transcribing 20 s pieces separately can't do that).
 *
 * The audio is sent in pieces cut at quiet moments; after each piece we send 1 s of silence and a
 * commit, which makes the streaming model finalise what it has. Riva's timestamps include those
 * silences, so they're mapped back to the recording's own timeline.
 */
export type DiarizedSegment = { speaker: number; text: string; startMs: number; endMs: number };

const RATE = 16000;
const PAD_MS = 1000;
const PAD = Buffer.alloc((RATE * 2 * PAD_MS) / 1000);
const PIECE_MS = 25_000;
const IDLE_DONE_MS = 3000;

/** Cut points (sample indexes) every ~25 s, at the quietest 100 ms within the next 3 s. */
export function cutPoints(pcm: Int16Array): number[] {
  const cuts: number[] = [];
  const win = RATE / 10;
  for (let at = (PIECE_MS / 1000) * RATE; at < pcm.length - RATE; ) {
    let best = at;
    let bestLevel = Infinity;
    for (let s = at; s < Math.min(pcm.length - win, at + 3 * RATE); s += win) {
      let sum = 0;
      for (let i = s; i < s + win; i++) sum += Math.abs(pcm[i]);
      if (sum < bestLevel) {
        bestLevel = sum;
        best = s + win / 2;
      }
    }
    cuts.push(Math.round(best));
    at = Math.round(best) + (PIECE_MS / 1000) * RATE;
  }
  return cuts;
}

/** Riva time (with inserted silences) → recording time. `padsAt` = Riva times where each silence began. */
export function toRecordingMs(rivaMs: number, padsAt: number[]) {
  const before = padsAt.filter((p) => p <= rivaMs).length;
  return Math.max(0, rivaMs - before * PAD_MS);
}

type RivaWord = { word: string; start_time: number; end_time: number; speaker_tag?: number };

export function transcribeDiarized(pcm: Int16Array, opts: { config: RivaConfig; language?: string; maxSpeakers?: number }): Promise<DiarizedSegment[]> {
  const language = RIVA_LANG[(opts.language ?? "en").split("-")[0]] ?? "en-US";
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const cuts = [...cutPoints(pcm), pcm.length];
  const padsAt: number[] = [];
  cuts.forEach((c, k) => padsAt.push(Math.round((c / RATE) * 1000) + k * PAD_MS));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.config.url, opts.config.apiKey ? ({ headers: { Authorization: `Bearer ${opts.config.apiKey}` } } as never) : undefined);
    const out: DiarizedSegment[] = [];
    let idle: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      if (idle) clearTimeout(idle);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(out.sort((a, b) => a.startMs - b.startMs));
    };
    const armIdle = (ms: number) => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => finish(), ms);
    };
    // Riva processes faster than real time; allow generous time for long calls.
    const hard = setTimeout(() => finish(new Error("Speaker-separated transcription timed out")), 60_000 + pcm.length / RATE * 1000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "transcription_session.update",
        session: {
          input_audio_transcription: { language, model: opts.config.model },
          speaker_diarization: { enable_speaker_diarization: true, max_speaker_count: opts.maxSpeakers ?? 8 },
          recognition_config: { enable_automatic_punctuation: true, max_alternatives: 1, enable_word_time_offsets: true },
        },
      }));
      let start = 0;
      for (const end of cuts) {
        const a = start * 2;
        const b = end * 2;
        for (let i = a; i < b; i += 3200) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytes.subarray(i, Math.min(i + 3200, b)).toString("base64") }));
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: PAD.toString("base64") }));
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        start = end;
      }
      armIdle(15_000); // nothing at all for 15 s → treat as silence
    };
    ws.onmessage = (m) => {
      let e: { type: string; transcript?: string; error?: { message?: string }; words_info?: { words?: RivaWord[] } };
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (e.type === "error") return finish(new Error(e.error?.message ?? "Riva error"));
      if (!e.type.endsWith("input_audio_transcription.completed")) return;
      armIdle(IDLE_DONE_MS);
      const text = e.transcript?.trim();
      const words = e.words_info?.words ?? [];
      if (!text || !words.length) return;
      // The word list can miss words, so keep the full sentence text and take its speaker by majority.
      const votes = new Map<number, number>();
      for (const w of words) if (typeof w.speaker_tag === "number") votes.set(w.speaker_tag, (votes.get(w.speaker_tag) ?? 0) + (w.end_time - w.start_time + 1));
      const speaker = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0;
      out.push({ speaker, text, startMs: toRecordingMs(words[0].start_time, padsAt), endMs: toRecordingMs(words[words.length - 1].end_time, padsAt) });
    };
    ws.onerror = () => finish(new Error("Riva connection failed"));
    ws.onclose = () => finish();
  });
}

/** Stable, human labels in order of first appearance: Speaker 1, Speaker 2, … */
export function labelSpeakers(segments: DiarizedSegment[]) {
  const order = new Map<number, number>();
  for (const s of segments) if (!order.has(s.speaker)) order.set(s.speaker, order.size + 1);
  return segments.map((s) => ({ ...s, label: `Speaker ${order.get(s.speaker)}` }));
}

/** Join consecutive lines by the same speaker with short gaps into one turn (reads like a conversation). */
export function mergeTurns<T extends { speaker: number; text: string; startMs: number; endMs: number }>(segs: T[], maxGapMs = 1500, maxTurnMs = 30_000): T[] {
  const out: T[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.startMs - last.endMs <= maxGapMs && s.endMs - last.startMs <= maxTurnMs) {
      out[out.length - 1] = { ...last, text: `${last.text} ${s.text}`.replace(/\s+/g, " "), endMs: s.endMs };
    } else out.push({ ...s });
  }
  return out;
}
