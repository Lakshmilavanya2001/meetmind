import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import type { AuthContext } from "../auth/session";
import { deleteObject, putObject } from "../storage";
import { getCallingProvider } from "../providers/calling";
import { isSttConfigured, readRivaConfig } from "../providers/stt";
import { getAccessibleMeeting } from "./meetings";
import { finalizeTranscriptIfIdle } from "./transcript-lifecycle";
import { parseTranscriptFile } from "../transcript-import";
import type { ParticipantRole, TranscriptSource } from "@/generated/prisma/enums";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole"> & { user: { displayName: string } };

export const MAX_CHUNK_BYTES = 2 * 1024 * 1024; // ~60 s of 16 kHz mono WAV
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4"]);

/**
 * Transcripts are visible only to people who were part of the meeting (host or invited/joined
 * participants who were not removed) — not to every workspace member with the link.
 */
export async function getTranscriptMeeting(ctx: Ctx, ref: string) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  const me = meeting.participants.find((p) => p.userId === ctx.userId);
  if (meeting.hostId !== ctx.userId && (!me || me.removedAt)) {
    throw new AppError("FORBIDDEN", "Only people who were part of this meeting can see its transcript.");
  }
  return { meeting, myRole, me };
}

const isModerator = (r: ParticipantRole) => r === "HOST" || r === "COHOST";

async function ensureTranscript(meetingId: string) {
  return db.meetingTranscript.upsert({ where: { meetingId }, update: {}, create: { meetingId, status: "PROCESSING" } });
}

/** Push the meeting's live AI state to every connected client (they refresh on any metadata change). */
export async function pushRoomState(meeting: { id: string; provider: "LIVEKIT" | "MICROSOFT_TEAMS"; providerRoomId: string | null }) {
  if (!meeting.providerRoomId) return;
  const m = await db.meeting.findUnique({ where: { id: meeting.id }, select: { transcriptionEnabled: true, interpretationEnabled: true } });
  try {
    await getCallingProvider(meeting.provider).updateRoomMetadata(meeting.providerRoomId, { transcription: !!m?.transcriptionEnabled, interpretation: !!m?.interpretationEnabled });
  } catch (err) {
    // Clients also poll the state, so a failed push only delays the banner.
    console.error("[transcription] room metadata update failed", (err as Error).message);
  }
}

// ─── Enable / consent ────────────────────────────────────────────────────

export async function setTranscription(ctx: Ctx, ref: string, input: { enabled: boolean; consentSelf?: boolean }) {
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  if (!isModerator(myRole)) throw new AppError("FORBIDDEN", "Only the host or a co-host can turn transcription on or off.");
  if (meeting.status === "ENDED" || meeting.status === "CANCELED") throw new AppError("CONFLICT", "This meeting is over.");
  if (input.enabled && !isSttConfigured()) throw new AppError("NOT_CONFIGURED", "Transcription isn't configured on this server (STT_BASE_URL / STT_MODEL).");

  await db.$transaction(async (tx) => {
    // The interpreter depends on transcription consent, so turning transcription off stops it too.
    await tx.meeting.update({ where: { id: meeting.id }, data: { transcriptionEnabled: input.enabled, ...(input.enabled ? {} : { interpretationEnabled: false }) } });
    if (input.enabled) {
      await tx.meetingTranscript.upsert({ where: { meetingId: meeting.id }, update: { status: "PROCESSING" }, create: { meetingId: meeting.id, status: "PROCESSING" } });
      if (input.consentSelf) {
        await tx.meetingParticipant.update({ where: { meetingId_userId: { meetingId: meeting.id, userId: ctx.userId } }, data: { transcriptionConsentAt: new Date() } });
      }
    }
  });
  await pushRoomState(meeting);
  await audit({ action: input.enabled ? "transcription.enable" : "transcription.disable", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
  return getTranscriptionState(ctx, ref);
}

/** Each participant decides for their own audio. Consent can be withdrawn at any time. */
export async function setConsent(ctx: Ctx, ref: string, consent: boolean) {
  const { meeting, me } = await getTranscriptMeeting(ctx, ref);
  if (!me) throw new AppError("FORBIDDEN", "Join the meeting first.");
  await db.meetingParticipant.update({ where: { id: me.id }, data: { transcriptionConsentAt: consent ? new Date() : null } });
  await audit({ action: consent ? "transcription.consent" : "transcription.consent_withdrawn", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
  return getTranscriptionState(ctx, ref);
}

export async function getTranscriptionState(ctx: Ctx, ref: string) {
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  const fresh = await db.meeting.findUniqueOrThrow({
    where: { id: meeting.id },
    select: {
      transcriptionEnabled: true,
      transcript: { select: { status: true } },
      participants: { where: { userId: ctx.userId }, select: { transcriptionConsentAt: true } },
    },
  });
  return {
    enabled: fresh.transcriptionEnabled,
    myConsent: !!fresh.participants[0]?.transcriptionConsentAt,
    canManage: isModerator(myRole),
    transcriptStatus: fresh.transcript?.status ?? null,
    sttConfigured: isSttConfigured(),
  };
}

// ─── Audio intake ────────────────────────────────────────────────────────

export const chunkMetaSchema = z.object({
  clientChunkId: z.string().regex(/^[\w-]{8,64}$/),
  capturedAt: z.iso.datetime({ offset: true }),
  durationMs: z.coerce.number().int().min(200).max(60_000),
});

/** Live capture: a participant uploads a short chunk of their own microphone audio. */
export async function enqueueLiveChunk(ctx: Ctx, ref: string, raw: unknown, audio: { data: Buffer; mimeType: string }) {
  const meta = chunkMetaSchema.parse(raw);
  const { meeting, me } = await getTranscriptMeeting(ctx, ref);
  if (meeting.status !== "LIVE") throw new AppError("CONFLICT", "The meeting is not in progress.");
  if (!meeting.transcriptionEnabled) throw new AppError("FORBIDDEN", "Transcription is turned off for this meeting.");
  if (!me?.transcriptionConsentAt) throw new AppError("FORBIDDEN", "You haven't agreed to have your audio transcribed.");
  validateAudio(audio);

  // Timestamps: trust the client clock only if it's roughly consistent with the server's.
  const serverEstimate = Date.now() - meta.durationMs;
  const claimed = new Date(meta.capturedAt).getTime();
  const startedAt = Math.abs(claimed - serverEstimate) < 2 * 60_000 ? claimed : serverEstimate;
  const startMs = Math.max(0, startedAt - (meeting.startedAt?.getTime() ?? startedAt));

  return createJob({
    meetingId: meeting.id,
    source: "LIVE_CAPTURE",
    idempotencyKey: `live:${meeting.id}:${ctx.userId}:${meta.clientChunkId}`,
    audio,
    payload: { speakerUserId: ctx.userId, speakerLabel: ctx.user.displayName, startMs, durationMs: meta.durationMs },
  });
}

function validateAudio(audio: { data: Buffer; mimeType: string }) {
  if (audio.data.length === 0) throw new AppError("VALIDATION", "Empty audio.");
  if (audio.data.length > MAX_CHUNK_BYTES) throw new AppError("VALIDATION", "Audio chunk is too large.");
  if (!AUDIO_TYPES.has(audio.mimeType.split(";")[0])) throw new AppError("VALIDATION", "Unsupported audio type.");
}

/** Per-workspace daily cap on transcribed audio (TRANSCRIPTION_DAILY_MINUTES_PER_ORG, default 24 h of audio). */
async function assertTranscriptionQuota(meetingId: string, addMs: number) {
  const limitMin = Number(process.env.TRANSCRIPTION_DAILY_MINUTES_PER_ORG || 1440);
  const [{ used }] = await db.$queryRaw<{ used: number | null }[]>`
    SELECT COALESCE(SUM((j."payload"->>'durationMs')::int), 0)::int AS used
    FROM "TranscriptionJob" j JOIN "Meeting" m ON m."id" = j."meetingId"
    WHERE m."organizationId" = (SELECT "organizationId" FROM "Meeting" WHERE "id" = ${meetingId})
      AND j."createdAt" > now() - interval '24 hours'`;
  if ((used ?? 0) + addMs > limitMin * 60_000) {
    throw new AppError("RATE_LIMITED", "Your workspace has reached its daily transcription limit. Try again later or ask an admin to raise TRANSCRIPTION_DAILY_MINUTES_PER_ORG.");
  }
}

async function createJob(input: {
  meetingId: string;
  source: TranscriptSource;
  idempotencyKey: string;
  recordingId?: string;
  audio: { data: Buffer; mimeType: string };
  payload: { speakerUserId: string | null; speakerLabel: string; startMs: number; durationMs: number; mode?: "store" };
}) {
  // Duplicate uploads (retries, double sends) return the original job instead of transcribing twice.
  const existing = await db.transcriptionJob.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, status: true } });
  if (existing) return { jobId: existing.id, status: existing.status, duplicate: true };
  await assertTranscriptionQuota(input.meetingId, input.payload.durationMs);

  await ensureTranscript(input.meetingId);
  const storageKey = `transcription/${input.meetingId}/${randomUUID()}.${input.audio.mimeType.includes("wav") ? "wav" : "bin"}`;
  await putObject(storageKey, input.audio.data);
  try {
    const job = await db.transcriptionJob.create({
      data: {
        meetingId: input.meetingId,
        source: input.source,
        recordingId: input.recordingId,
        idempotencyKey: input.idempotencyKey,
        payload: { ...input.payload, storageKey, mimeType: input.audio.mimeType },
      },
    });
    return { jobId: job.id, status: job.status, duplicate: false };
  } catch (err) {
    await deleteObject(storageKey);
    // Lost a race with an identical upload.
    const dup = await db.transcriptionJob.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, status: true } });
    if (dup) return { jobId: dup.id, status: dup.status, duplicate: true };
    throw err;
  }
}

/** Post-meeting fallback: the host uploads a recording; the browser splits it into WAV chunks. */
export async function startRecordingUpload(ctx: Ctx, ref: string, raw: unknown) {
  const input = z
    .object({
      fileName: z.string().max(200),
      durationMs: z.number().int().min(1000).max(6 * 3600_000),
      consentConfirmed: z.literal(true),
      // How many pieces the uploader will send. With speaker separation available, the whole call is
      // transcribed in one pass once they're all in, so "Speaker 1" is the same person throughout.
      chunks: z.number().int().min(1).max(5000).optional(),
      language: z.enum(["en", "hi", "es"]).default("en"),
    })
    .parse(raw);
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  if (!isModerator(myRole)) throw new AppError("FORBIDDEN", "Only the host or a co-host can upload a recording.");
  if (!isSttConfigured()) throw new AppError("NOT_CONFIGURED", "Transcription isn't configured on this server.");
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { recordingRetentionDays: true } });
  const recording = await db.recording.create({
    data: {
      meetingId: meeting.id,
      startedById: ctx.userId,
      status: "PROCESSING",
      mimeType: "audio/wav",
      durationMs: input.durationMs,
      chunkCount: input.chunks && readRivaConfig() ? input.chunks : null,
      language: input.language,
      startedAt: meeting.startedAt ?? new Date(),
      expiresAt: org.recordingRetentionDays ? new Date(Date.now() + org.recordingRetentionDays * 86400_000) : null,
    },
  });
  await db.meetingTranscript.upsert({ where: { meetingId: meeting.id }, update: { status: "PROCESSING" }, create: { meetingId: meeting.id, status: "PROCESSING" } });
  await audit({ action: "transcription.recording_upload", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { recordingId: recording.id, fileName: input.fileName, consentConfirmed: true } });
  return { recordingId: recording.id, speakers: !!recording.chunkCount };
}

export async function enqueueRecordingChunk(ctx: Ctx, ref: string, recordingId: string, raw: unknown, audio: { data: Buffer; mimeType: string }) {
  const meta = z.object({ index: z.coerce.number().int().min(0).max(5000), startMs: z.coerce.number().int().min(0), durationMs: z.coerce.number().int().min(200).max(60_000) }).parse(raw);
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  if (!isModerator(myRole)) throw new AppError("FORBIDDEN", "Only the host or a co-host can upload a recording.");
  const rec = await db.recording.findFirst({ where: { id: recordingId, meetingId: meeting.id } });
  if (!rec) throw new AppError("NOT_FOUND", "Recording not found.");
  if (rec.chunkCount && meta.index >= rec.chunkCount) throw new AppError("VALIDATION", "More pieces than announced for this recording.");
  validateAudio(audio);
  return createJob({
    meetingId: meeting.id,
    source: "RECORDING",
    recordingId,
    idempotencyKey: `rec:${recordingId}:${meta.index}`,
    audio,
    // A single recording mixes everyone's voices; without diarisation we don't attribute speakers.
    payload: { speakerUserId: null, speakerLabel: "Recording", startMs: meta.startMs, durationMs: meta.durationMs, ...(rec.chunkCount ? { mode: "store" as const } : {}) },
  });
}

/** Manual import of a VTT/SRT/text transcript. Speakers are linked to participants only on an unambiguous name match. */
export async function importTranscript(ctx: Ctx, ref: string, raw: unknown) {
  const input = z.object({ content: z.string().min(1).max(1_000_000), fileName: z.string().max(200).default(""), replace: z.boolean().default(false) }).parse(raw);
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  if (!isModerator(myRole)) throw new AppError("FORBIDDEN", "Only the host or a co-host can import a transcript.");
  // Replacing deletes the existing transcript, which is a host-only action (like deleteTranscript).
  if (input.replace && meeting.hostId !== ctx.userId) throw new AppError("FORBIDDEN", "Only the host can replace this meeting's transcript.");
  const parsed = parseTranscriptFile(input.content, input.fileName);
  if (parsed.segments.length === 0) throw new AppError("VALIDATION", "No transcript lines were found in that file.");

  const transcript = await ensureTranscript(meeting.id);
  const existing = await db.transcriptSegment.count({ where: { transcriptId: transcript.id } });
  if (existing > 0 && !input.replace) {
    throw new AppError("CONFLICT", "This meeting already has a transcript. Choose “replace” to overwrite it.", { existingSegments: existing });
  }

  const byName = new Map<string, string[]>();
  for (const p of meeting.participants) {
    const k = p.user.displayName.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), p.userId]);
  }
  const speakerId = (name: string | null) => {
    const ids = name ? byName.get(name.toLowerCase()) : undefined;
    return ids?.length === 1 ? ids[0] : null;
  };

  await db.$transaction(async (tx) => {
    if (input.replace) {
      await tx.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });
      await tx.transcriptChunk.deleteMany({ where: { transcriptId: transcript.id } });
    }
    await tx.transcriptSegment.createMany({
      data: parsed.segments.map((s) => ({
        transcriptId: transcript.id,
        meetingId: meeting.id,
        speakerUserId: speakerId(s.speaker),
        speakerLabel: s.speaker ?? "Unknown speaker",
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text.slice(0, 5000),
        source: "UPLOAD" as const,
      })),
    });
    const days = (await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { transcriptRetentionDays: true } })).transcriptRetentionDays;
    await tx.meetingTranscript.update({
      where: { id: transcript.id },
      data: { status: "COMPLETED", error: null, indexedAt: null, expiresAt: days ? new Date(Date.now() + days * 86400_000) : null },
    });
  });
  await audit({ action: "transcription.import", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { format: parsed.format, segments: parsed.segments.length } });
  return { format: parsed.format, segments: parsed.segments.length, approximateTimes: parsed.approximateTimes };
}

// ─── Reading, export, deletion ───────────────────────────────────────────

export async function getTranscript(ctx: Ctx, ref: string, opts: { afterMs?: number } = {}) {
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  const transcript = await db.meetingTranscript.findUnique({ where: { meetingId: meeting.id } });
  const [segments, pending, failed] = await Promise.all([
    db.transcriptSegment.findMany({
      where: { meetingId: meeting.id, ...(opts.afterMs !== undefined ? { startMs: { gt: opts.afterMs } } : {}) },
      orderBy: [{ startMs: "asc" }, { createdAt: "asc" }],
      select: { id: true, startMs: true, endMs: true, speakerLabel: true, speakerUserId: true, text: true, source: true },
    }),
    db.transcriptionJob.count({ where: { meetingId: meeting.id, status: { in: ["QUEUED", "RUNNING"] } } }),
    db.transcriptionJob.count({ where: { meetingId: meeting.id, status: "FAILED" } }),
  ]);
  return {
    meeting: { id: meeting.id, title: meeting.title, joinCode: meeting.joinCode, status: meeting.status, startedAt: meeting.startedAt, timezone: meeting.timezone, transcriptionEnabled: meeting.transcriptionEnabled },
    canManage: isModerator(myRole),
    isHost: meeting.hostId === ctx.userId,
    transcript: transcript ? { status: transcript.status, error: transcript.error, expiresAt: transcript.expiresAt, updatedAt: transcript.updatedAt } : null,
    processing: { pending, failed },
    segments,
  };
}

export const fmtClock = (ms: number, withMillis = false) => {
  const s = Math.floor(ms / 1000);
  const base = `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return withMillis ? `${base}.${String(ms % 1000).padStart(3, "0")}` : base;
};

export async function exportTranscript(ctx: Ctx, ref: string, format: "txt" | "vtt" | "srt" | "json") {
  const t = await getTranscript(ctx, ref);
  if (t.segments.length === 0) throw new AppError("NOT_FOUND", "There is no transcript to download yet.");
  const name = `${t.meeting.title.replace(/[^\w-]+/g, "_").slice(0, 60)}-transcript`;
  await audit({ action: "transcription.export", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: t.meeting.id, metadata: { format } });
  if (format === "json") {
    return { fileName: `${name}.json`, contentType: "application/json", body: JSON.stringify({ meeting: t.meeting.title, segments: t.segments.map(({ startMs, endMs, speakerLabel, text }) => ({ startMs, endMs, speaker: speakerLabel, text })) }, null, 2) };
  }
  if (format === "txt") {
    return { fileName: `${name}.txt`, contentType: "text/plain; charset=utf-8", body: t.segments.map((s) => `[${fmtClock(s.startMs)}] ${s.speakerLabel}: ${s.text}`).join("\n") + "\n" };
  }
  const cue = (s: (typeof t.segments)[number], i: number) => {
    const end = Math.max(s.endMs, s.startMs + 500);
    if (format === "vtt") return `${fmtClock(s.startMs, true)} --> ${fmtClock(end, true)}\n<v ${s.speakerLabel}>${s.text}`;
    return `${i + 1}\n${fmtClock(s.startMs, true).replace(".", ",")} --> ${fmtClock(end, true).replace(".", ",")}\n${s.speakerLabel}: ${s.text}`;
  };
  const body = (format === "vtt" ? "WEBVTT\n\n" : "") + t.segments.map(cue).join("\n\n") + "\n";
  return { fileName: `${name}.${format}`, contentType: format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8", body };
}

/** Delete a meeting's transcript and everything derived from it (segments, search index, summaries, action items). */
export async function deleteTranscript(ctx: Ctx, ref: string) {
  const { meeting } = await getTranscriptMeeting(ctx, ref);
  if (meeting.hostId !== ctx.userId) throw new AppError("FORBIDDEN", "Only the host can delete this meeting's transcript.");
  await purgeMeetingTranscript(meeting.id);
  await audit({ action: "transcription.delete", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
}

async function purgeMeetingTranscript(meetingId: string) {
  const jobs = await db.transcriptionJob.findMany({ where: { meetingId }, select: { payload: true } });
  await db.$transaction([
    db.actionItem.deleteMany({ where: { meetingId } }),
    db.meetingSummary.deleteMany({ where: { meetingId } }),
    db.transcriptionJob.deleteMany({ where: { meetingId } }),
    db.meetingTranscript.deleteMany({ where: { meetingId } }), // cascades segments + chunks
    db.meeting.update({ where: { id: meetingId }, data: { transcriptionEnabled: false } }),
  ]);
  for (const j of jobs) {
    const key = (j.payload as { storageKey?: string } | null)?.storageKey;
    if (key) await deleteObject(key).catch(() => {});
  }
}

/** Retention: remove transcripts (and derived data) past their expiry. Returns how many were purged. */
export async function purgeExpiredTranscripts(now = new Date()) {
  const expired = await db.meetingTranscript.findMany({ where: { expiresAt: { lt: now } }, select: { meetingId: true } });
  for (const t of expired) {
    await purgeMeetingTranscript(t.meetingId);
    await audit({ action: "transcription.retention_purge", targetType: "Meeting", targetId: t.meetingId });
  }
  await db.recording.updateMany({ where: { expiresAt: { lt: now }, status: { not: "DELETED" } }, data: { status: "DELETED", storageKey: null } });
  return expired.length;
}

export { finalizeTranscriptIfIdle };

/** What was said in the last few minutes of a meeting (for "set up the meeting we just agreed on"). */
export async function getRecentLines(ctx: Ctx, ref: string, minutes: number) {
  const { meeting } = await getTranscriptMeeting(ctx, ref);
  const segments = await db.transcriptSegment.findMany({
    where: { meetingId: meeting.id, createdAt: { gte: new Date(Date.now() - minutes * 60_000) } },
    orderBy: [{ startMs: "asc" }, { createdAt: "asc" }],
    take: 300,
    select: { startMs: true, speakerLabel: true, speakerUserId: true, text: true },
  });
  return { meeting: { title: meeting.title, joinCode: meeting.joinCode, transcriptionEnabled: meeting.transcriptionEnabled }, segments };
}

/**
 * Name a speaker found in a recording ("Speaker 1" → "Priya Patel"), optionally linking the lines to
 * a participant. Host or co-host only. The summary can then be regenerated with real names.
 */
export async function renameSpeaker(ctx: Ctx, ref: string, raw: unknown) {
  const input = z.object({ from: z.string().trim().min(1).max(80), to: z.string().trim().min(1).max(80), userId: z.string().min(1).nullable().optional() }).parse(raw);
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  if (!isModerator(myRole)) throw new AppError("FORBIDDEN", "Only the host or a co-host can name speakers.");
  let userId: string | null = null;
  if (input.userId) {
    const p = meeting.participants.find((x) => x.userId === input.userId && !x.removedAt);
    if (!p && meeting.hostId !== input.userId) throw new AppError("VALIDATION", "That person isn't part of this meeting.");
    userId = input.userId;
  }
  const res = await db.transcriptSegment.updateMany({ where: { meetingId: meeting.id, speakerLabel: input.from }, data: { speakerLabel: input.to, ...(userId ? { speakerUserId: userId } : {}) } });
  if (res.count === 0) throw new AppError("NOT_FOUND", `No lines are labelled “${input.from}”.`);
  await db.meetingTranscript.updateMany({ where: { meetingId: meeting.id }, data: { indexedAt: null } });
  await audit({ action: "transcript.rename_speaker", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { from: input.from, to: input.to, linked: !!userId, lines: res.count } });
  return { renamed: res.count };
}
