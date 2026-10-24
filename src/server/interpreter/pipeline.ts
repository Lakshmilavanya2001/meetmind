import "server-only";
import { db } from "../db";
import { translateLine } from "../services/translation";

/** What the interpreter tells clients over the call's data channel (topic "interpreter"). */
export type InterpreterMessage =
  | { type: "line"; id: string; speakerId: string; speaker: string; language: string; text: string; speechEndAt: number }
  | { type: "translation"; id: string; language: string; text: string }
  | { type: "latency"; id: string; language: string; asrMs: number; mtMs: number; ttsMs: number; queueMs: number; totalMs: number; spoken: boolean };

/** Where translated speech goes: in a call, one audio track per language. */
export interface InterpreterOutput {
  /**
   * Synthesise `text` and queue it on the track for `language`. Resolves when it starts playing
   * (playAt), or null when no voice is available for that language (clients show the text).
   */
  speak(language: string, text: string): Promise<{ ttsMs: number; queueMs: number; playAt: number } | null>;
  send(message: InterpreterMessage): void;
}

export type Utterance = { text: string; language: string; speechStartAt: number; speechEndAt: number; resultAt: number };
export type Speaker = { userId: string; label: string };
export type MeetingRef = { id: string; startedAt: Date | null };

/**
 * One finished utterance → transcript line, then for every other language in the call:
 * translate (cached, shared with captions) → speak on that language's track → record latency.
 * End-to-end latency is measured from the moment the speaker stopped talking to the moment the
 * translated speech starts playing into the call.
 */
export async function interpretUtterance(o: { meeting: MeetingRef; speaker: Speaker; utt: Utterance; targetLanguages: string[]; out: InterpreterOutput }) {
  const { meeting, speaker, utt, out } = o;
  const transcript = await db.meetingTranscript.upsert({ where: { meetingId: meeting.id }, update: {}, create: { meetingId: meeting.id, status: "PROCESSING" } });
  const base = (meeting.startedAt ?? new Date(utt.speechStartAt)).getTime();
  const segment = await db.transcriptSegment.create({
    data: {
      transcriptId: transcript.id,
      meetingId: meeting.id,
      speakerUserId: speaker.userId,
      speakerLabel: speaker.label,
      startMs: Math.max(0, utt.speechStartAt - base),
      endMs: Math.max(0, utt.speechEndAt - base),
      text: utt.text,
      language: utt.language,
      source: "LIVE_CAPTURE",
    },
  });
  await db.meetingTranscript.update({ where: { id: transcript.id }, data: { indexedAt: null } });
  out.send({ type: "line", id: segment.id, speakerId: speaker.userId, speaker: speaker.label, language: utt.language, text: utt.text, speechEndAt: utt.speechEndAt });

  const asrMs = Math.max(0, utt.resultAt - utt.speechEndAt);
  const targets = [...new Set(o.targetLanguages)].filter((l) => l !== utt.language);
  await Promise.all(
    targets.map(async (language) => {
      const t0 = Date.now();
      const translated = await translateLine({ id: segment.id, text: utt.text, language: utt.language }, language);
      const mtMs = Date.now() - t0;
      if (!translated) return; // translation failed: captions show the original
      out.send({ type: "translation", id: segment.id, language, text: translated });
      const spoken = await out.speak(language, translated).catch((err) => {
        console.error("[interpreter] speech failed", (err as Error).message);
        return null;
      });
      const ttsMs = spoken?.ttsMs ?? 0;
      const queueMs = spoken?.queueMs ?? 0;
      const totalMs = (spoken?.playAt ?? Date.now()) - utt.speechEndAt;
      out.send({ type: "latency", id: segment.id, language, asrMs, mtMs, ttsMs, queueMs, totalMs, spoken: !!spoken });
      await db.interpretationEvent.create({
        data: {
          meetingId: meeting.id,
          segmentId: segment.id,
          speakerUserId: speaker.userId,
          sourceLanguage: utt.language,
          targetLanguage: language,
          sourceText: utt.text,
          translatedText: translated,
          speechEndAt: new Date(utt.speechEndAt),
          asrMs,
          mtMs,
          ttsMs,
          queueMs,
          totalMs,
        },
      });
    }),
  );
  return segment;
}
