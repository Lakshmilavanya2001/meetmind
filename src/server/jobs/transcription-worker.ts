import "server-only";
import { db } from "../db";
import { getObject, deleteObject } from "../storage";
import { getSttProvider, TransientSttError } from "../providers/stt";
import { finalizeTranscriptIfIdle } from "../services/transcript-lifecycle";
import { purgeExpiredTranscripts } from "../services/transcripts";
import { findTranscriptsNeedingIndex, indexMeetingTranscript } from "../services/transcript-index";
import { isEmbeddingConfigured } from "../providers/embeddings";
import { expireRings } from "../services/calls";
import { readRivaConfig } from "../providers/stt";
import { labelSpeakers, mergeTurns, transcribeDiarized } from "../transcription/diarize";
import { parseWav, resampleInt16, toMono } from "../interpreter/audio";
import { sendDueReminders } from "../services/reminders";
import { runPostCallSummaries } from "../services/post-call";

const MAX_ATTEMPTS = 5;
// Recognisers occasionally emit control characters (PostgreSQL rejects NUL in text): keep printable text only.
const clean = (t: string) => t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
const STALE_RUNNING_MS = 5 * 60_000;

type JobPayload = {
  storageKey: string;
  mimeType: string;
  speakerUserId: string | null;
  speakerLabel: string;
  startMs: number;
  durationMs: number;
  /** "store": a recording piece kept for the whole-call pass; "diarize": that pass. Absent: transcribe this piece. */
  mode?: "store" | "diarize";
};

/** Atomically claim the next runnable job. SKIP LOCKED lets several app instances share the queue. */
async function claimJob() {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "TranscriptionJob" SET status = 'RUNNING', attempts = attempts + 1, "startedAt" = now(), "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "TranscriptionJob"
      WHERE (status = 'QUEUED' AND "runAfter" <= now())
         OR (status = 'RUNNING' AND "startedAt" < now() - (${STALE_RUNNING_MS} * interval '1 millisecond'))
      ORDER BY "runAfter" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  if (!rows[0]) return null;
  return db.transcriptionJob.findUnique({ where: { id: rows[0].id } });
}

/** Process one job. Returns false when the queue is empty. Exported for tests and scripts. */
export async function processNextJob(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const p = job.payload as JobPayload;
  if (p.mode === "store") return storeRecordingPiece(job);
  if (p.mode === "diarize") return diarizeRecording(job);
  try {
    const audio = await getObject(p.storageKey);
    // Recognise in the speaker's own language (e.g. Hindi) when we know who is speaking.
    const language = p.speakerUserId ? (await db.user.findUnique({ where: { id: p.speakerUserId }, select: { preferredLanguage: true } }))?.preferredLanguage : undefined;
    const { text: rawText, language: spokenLanguage } = await getSttProvider().transcribe(audio, { mimeType: p.mimeType, fileName: p.storageKey.split("/").pop(), language });
    const text = clean(rawText);
    const transcript = await db.meetingTranscript.findUnique({ where: { meetingId: job.meetingId }, select: { id: true } });
    await db.$transaction(async (tx) => {
      // The job row is the idempotency guard: only a RUNNING job owned by this claim writes segments.
      const owned = await tx.transcriptionJob.updateMany({ where: { id: job.id, status: "RUNNING", attempts: job.attempts }, data: { status: "SUCCEEDED", completedAt: new Date(), lastError: null } });
      if (owned.count === 0 || !transcript) return;
      if (text) {
        await tx.transcriptSegment.create({
          data: {
            transcriptId: transcript.id,
            meetingId: job.meetingId,
            speakerUserId: p.speakerUserId,
            speakerLabel: p.speakerLabel,
            startMs: p.startMs,
            endMs: p.startMs + p.durationMs,
            text,
            language: spokenLanguage ?? null,
            source: job.source,
          },
        });
        await tx.meetingTranscript.update({ where: { id: transcript.id }, data: { indexedAt: null } });
      }
    });
    // Raw audio is not retained once transcribed.
    await deleteObject(p.storageKey).catch(() => {});
    if (job.recordingId) await maybeFinishRecording(job.recordingId);
  } catch (err) {
    const transient = err instanceof TransientSttError || (err as NodeJS.ErrnoException)?.code === "ECONNRESET";
    const retry = transient && job.attempts < MAX_ATTEMPTS;
    const message = (err as Error).message?.slice(0, 500) ?? "Unknown error";
    console.error(`[transcription] job ${job.id} attempt ${job.attempts} failed${retry ? " (will retry)" : ""}:`, message);
    await db.transcriptionJob.update({
      where: { id: job.id },
      data: retry
        ? { status: "QUEUED", lastError: message, runAfter: new Date(Date.now() + 2000 * 2 ** job.attempts) }
        : { status: "FAILED", lastError: message, completedAt: new Date() },
    });
    if (!retry) {
      const key = p?.storageKey;
      if (key) await deleteObject(key).catch(() => {});
      if (job.recordingId) await maybeFinishRecording(job.recordingId);
    }
  }
  await finalizeTranscriptIfIdle(job.meetingId);
  return true;
}

type Job = NonNullable<Awaited<ReturnType<typeof claimJob>>>;

/** A recording piece for the whole-call pass: keep the audio, transcribe later. */
async function storeRecordingPiece(job: Job) {
  await db.transcriptionJob.updateMany({ where: { id: job.id, status: "RUNNING", attempts: job.attempts }, data: { status: "SUCCEEDED", completedAt: new Date(), lastError: null } });
  if (job.recordingId) await maybeFinishRecording(job.recordingId);
  await finalizeTranscriptIfIdle(job.meetingId);
  return true;
}

/**
 * The whole recording in one speaker-separated session ("Speaker 1", "Speaker 2"…). If that keeps
 * failing, fall back to transcribing each piece without speakers, so the transcript is never lost.
 */
async function diarizeRecording(job: Job) {
  const rec = await db.recording.findUniqueOrThrow({ where: { id: job.recordingId! } });
  const pieces = (await db.transcriptionJob.findMany({ where: { recordingId: rec.id, status: "SUCCEEDED" } }))
    .map((j) => j.payload as JobPayload)
    .filter((x) => x.mode === "store")
    .sort((a, b) => a.startMs - b.startMs);
  const transcript = await db.meetingTranscript.findUnique({ where: { meetingId: job.meetingId }, select: { id: true } });
  type Row = { speakerLabel: string; text: string; startMs: number; endMs: number; language: string | null };
  let rows: Row[];
  try {
    const audio = await Promise.all(pieces.map(async (x) => ({ x, wav: parseWav(await getObject(x.storageKey)) })));
    const total = Math.max(0, ...audio.map(({ x, wav }) => Math.round((x.startMs / 1000) * 16000) + wav.samples.length));
    const pcm = new Int16Array(total);
    for (const { x, wav } of audio) pcm.set(resampleInt16(toMono(wav.samples, wav.channels), wav.sampleRate, 16000), Math.round((x.startMs / 1000) * 16000));
    const config = readRivaConfig();
    if (!config) throw new Error("Riva is not configured");
    const segs = labelSpeakers(mergeTurns(await transcribeDiarized(pcm, { config, language: rec.language ?? "en" })));
    rows = segs.map((x) => ({ speakerLabel: x.label, text: clean(x.text), startMs: x.startMs, endMs: Math.max(x.endMs, x.startMs + 1), language: rec.language ?? "en" }));
  } catch (err) {
    console.error(`[transcription] speaker-separated pass failed (attempt ${job.attempts}):`, (err as Error).message);
    if (job.attempts < 3) {
      await db.transcriptionJob.update({ where: { id: job.id }, data: { status: "QUEUED", lastError: (err as Error).message.slice(0, 500), runAfter: new Date(Date.now() + 3000 * job.attempts) } });
      return true;
    }
    rows = [];
    for (const x of pieces) {
      const r = await getSttProvider().transcribe(await getObject(x.storageKey), { mimeType: x.mimeType, language: rec.language ?? undefined }).catch(() => null);
      if (r?.text && clean(r.text)) rows.push({ speakerLabel: "Recording", text: clean(r.text), startMs: x.startMs, endMs: x.startMs + x.durationMs, language: r.language ?? null });
    }
  }
  await db.$transaction(async (tx) => {
    const owned = await tx.transcriptionJob.updateMany({ where: { id: job.id, status: "RUNNING", attempts: job.attempts }, data: { status: "SUCCEEDED", completedAt: new Date(), lastError: null } });
    if (owned.count === 0 || !transcript) return;
    if (rows.length) {
      await tx.transcriptSegment.createMany({ data: rows.map((r) => ({ transcriptId: transcript.id, meetingId: job.meetingId, speakerUserId: null, source: "RECORDING" as const, ...r })) });
      await tx.meetingTranscript.update({ where: { id: transcript.id }, data: { indexedAt: null } });
    }
  });
  // Raw audio is not retained once transcribed.
  for (const x of pieces) await deleteObject(x.storageKey).catch(() => {});
  await db.recording.update({ where: { id: rec.id }, data: { status: "READY", endedAt: new Date() } });
  await finalizeTranscriptIfIdle(job.meetingId);
  return true;
}

async function maybeFinishRecording(recordingId: string) {
  const open = await db.transcriptionJob.count({ where: { recordingId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (open > 0) return;
  const rec = await db.recording.findUnique({ where: { id: recordingId }, select: { chunkCount: true, meetingId: true } });
  if (rec?.chunkCount) {
    // Whole-call mode: once every piece is in, run the speaker-separated pass (once).
    const stored = (await db.transcriptionJob.findMany({ where: { recordingId, status: "SUCCEEDED" }, select: { payload: true } })).filter((j) => (j.payload as JobPayload).mode === "store").length;
    if (stored < rec.chunkCount) return;
    await db.transcriptionJob.upsert({
      where: { idempotencyKey: `rec:${recordingId}:diarize` },
      update: {},
      create: { meetingId: rec.meetingId, source: "RECORDING", recordingId, idempotencyKey: `rec:${recordingId}:diarize`, payload: { mode: "diarize", storageKey: "", mimeType: "", speakerUserId: null, speakerLabel: "", startMs: 0, durationMs: 0 } },
    });
    return;
  }
  const failed = await db.transcriptionJob.count({ where: { recordingId, status: "FAILED" } });
  await db.recording.update({ where: { id: recordingId }, data: { status: failed > 0 ? "FAILED" : "READY", endedAt: new Date() } });
}

/** Drain the queue (tests / scripts). */
export async function drainJobs(max = 1000) {
  let n = 0;
  while (n < max && (await processNextJob())) n++;
  return n;
}

// ─── Search indexing ─────────────────────────────────────────────────────

const lastIndexed = new Map<string, number>();
let indexBackoffUntil = 0;

/** One indexing pass. Live meetings are re-indexed at most once a minute. Exported for tests/scripts. */
export async function indexPendingTranscripts() {
  if (!isEmbeddingConfigured() || Date.now() < indexBackoffUntil) return 0;
  let n = 0;
  for (const { meetingId } of await findTranscriptsNeedingIndex(10)) {
    if (Date.now() - (lastIndexed.get(meetingId) ?? 0) < 60_000) continue;
    lastIndexed.set(meetingId, Date.now());
    try {
      await indexMeetingTranscript(meetingId);
      n++;
    } catch (err) {
      console.error(`[index] meeting ${meetingId} failed:`, (err as Error).message);
      indexBackoffUntil = Date.now() + 30_000; // embedding service trouble: back off, retry later
      break;
    }
  }
  return n;
}

// ─── Background loop ─────────────────────────────────────────────────────

const g = globalThis as unknown as { __mmWorker?: { running: boolean } };

export function startTranscriptionWorker({ concurrency = 4, idleMs = 1000 } = {}) {
  if (g.__mmWorker?.running) return;
  g.__mmWorker = { running: true };
  console.log(`[transcription] worker started (concurrency ${concurrency})`);
  for (let i = 0; i < concurrency; i++) {
    (async function loop() {
      while (g.__mmWorker?.running) {
        try {
          if (!(await processNextJob())) await new Promise((r) => setTimeout(r, idleMs));
        } catch (err) {
          console.error("[transcription] worker error", err);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }
  // Unanswered calls → missed-call notifications: every 5 s.
  setInterval(() => expireRings().catch((e) => console.error("[calls] ring expiry failed", e)), 5_000).unref?.();
  // Due reminders (in-app + SMS): every 15 s.
  setInterval(() => sendDueReminders().catch((e) => console.error("[reminders] sweep failed", e)), 15_000).unref?.();
  // Automatic post-call summaries and action-item reminders: every 30 s.
  setInterval(() => runPostCallSummaries().catch((e) => console.error("[post-call] sweep failed", e)), 30_000).unref?.();
  // Search indexing: every 10 s.
  setInterval(() => indexPendingTranscripts().catch((e) => console.error("[index] sweep failed", e)), 10_000).unref?.();
  // Retention sweep: hourly.
  const sweep = () => purgeExpiredTranscripts().then((n) => n && console.log(`[retention] purged ${n} transcript(s)`)).catch((e) => console.error("[retention] sweep failed", e));
  setTimeout(sweep, 30_000);
  setInterval(sweep, 3600_000).unref?.();
}
