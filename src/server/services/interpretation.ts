import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import type { AuthContext } from "../auth/session";
import { readRivaConfig } from "../providers/stt";
import { getTtsProvider } from "../providers/tts";
import { getCallingProvider } from "../providers/calling";
import { INTERPRETER_IDENTITY, interpreterLanguageCodes } from "../interpreter/constants";
import { INDIC_NAMES, readIndicConfig } from "../providers/indic";
import { getTranscriptMeeting, pushRoomState } from "./transcripts";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole"> & { user: { displayName: string } };

const NAMES: Record<string, string> = {
  ...INDIC_NAMES,
  en: "English",
  hi: "हिन्दी (Hindi)",
  es: "Español (Spanish)",
  fr: "Français (French)",
  de: "Deutsch (German)",
  it: "Italiano (Italian)",
  pt: "Português (Portuguese)",
  zh: "中文 (Chinese)",
  ja: "日本語 (Japanese)",
  ko: "한국어 (Korean)",
  ar: "العربية (Arabic)",
  vi: "Tiếng Việt (Vietnamese)",
};
export const interpreterLanguages = () => interpreterLanguageCodes().map((code) => ({ code, name: NAMES[code] ?? code, voice: !!getTtsProvider() }));
/** Which engines the interpreter uses (shown to users; Indic models need attribution). */
export const interpreterEngines = () => ({ indic: !!readIndicConfig().asr });
const isModerator = (r: string) => r === "HOST" || r === "COHOST";

export async function getInterpretationState(ctx: Ctx, ref: string) {
  const { meeting, myRole, me } = await getTranscriptMeeting(ctx, ref);
  const fresh = await db.meeting.findUniqueOrThrow({ where: { id: meeting.id }, select: { interpretationEnabled: true, transcriptionEnabled: true } });
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { preferredLanguage: true } });
  const pref = me?.callLanguage ?? user.preferredLanguage;
  return {
    enabled: fresh.interpretationEnabled,
    canManage: isModerator(myRole),
    available: !!readRivaConfig(),
    myLanguage: interpreterLanguageCodes().includes(pref) ? pref : "en",
    /** Has this person picked a language in this call, and is their voice being interpreted? */
    chosen: !!me?.callLanguage,
    myVoice: !!me?.transcriptionConsentAt,
    languages: interpreterLanguages(),
    engines: interpreterEngines(),
    agentIdentity: INTERPRETER_IDENTITY,
  };
}

/** Host or co-host turns the AI interpreter on or off. It needs transcription, so turning it on turns that on too. */
export async function setInterpretation(ctx: Ctx, ref: string, raw: unknown) {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(raw);
  const { meeting, myRole } = await getTranscriptMeeting(ctx, ref);
  if (!isModerator(myRole)) throw new AppError("FORBIDDEN", "Only the host or a co-host can turn the interpreter on or off.");
  if (meeting.status !== "LIVE") throw new AppError("CONFLICT", "The interpreter can only join a live call.");
  if (enabled && !readRivaConfig()) throw new AppError("NOT_CONFIGURED", "Live interpretation needs streaming speech recognition (RIVA_REALTIME_URL).");
  await db.$transaction(async (tx) => {
    await tx.meeting.update({ where: { id: meeting.id }, data: enabled ? { interpretationEnabled: true, transcriptionEnabled: true } : { interpretationEnabled: false } });
    if (enabled) {
      await tx.meetingTranscript.upsert({ where: { meetingId: meeting.id }, update: { status: "PROCESSING" }, create: { meetingId: meeting.id, status: "PROCESSING" } });
      // The host who switches it on consents for their own voice; everyone else is asked.
      await tx.meetingParticipant.update({ where: { meetingId_userId: { meetingId: meeting.id, userId: ctx.userId } }, data: { transcriptionConsentAt: new Date() } });
    }
  });
  if (!enabled && meeting.providerRoomId) await getCallingProvider(meeting.provider).removeParticipant(meeting.providerRoomId, INTERPRETER_IDENTITY).catch(() => {});
  await pushRoomState(meeting);
  await audit({ action: enabled ? "interpretation.enable" : "interpretation.disable", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
  return getInterpretationState(ctx, ref);
}

/**
 * Each participant picks the language they speak and want to hear. No host step: choosing a language in a
 * live call is the person's own opt-in. Their voice goes to the interpreter (this is their consent for
 * their own audio only), and the interpreter is switched on for the call if it isn't already.
 * Everyone else's voice is still used only after they agree for themselves.
 */
export async function setMyCallLanguage(ctx: Ctx, ref: string, raw: unknown) {
  const { language } = z.object({ language: z.string().refine((l) => interpreterLanguageCodes().includes(l), "That language isn't available") }).parse(raw);
  const { meeting, me } = await getTranscriptMeeting(ctx, ref);
  if (!me) throw new AppError("FORBIDDEN", "Join the meeting first.");
  const live = meeting.status === "LIVE" && !!readRivaConfig();
  let switchedOn = false;
  await db.$transaction(async (tx) => {
    await tx.meetingParticipant.update({ where: { id: me.id }, data: { callLanguage: language, ...(live && !me.transcriptionConsentAt ? { transcriptionConsentAt: new Date() } : {}) } });
    if (!live) return;
    const m = await tx.meeting.findUniqueOrThrow({ where: { id: meeting.id }, select: { interpretationEnabled: true } });
    if (m.interpretationEnabled) return;
    await tx.meeting.update({ where: { id: meeting.id }, data: { interpretationEnabled: true, transcriptionEnabled: true } });
    await tx.meetingTranscript.upsert({ where: { meetingId: meeting.id }, update: { status: "PROCESSING" }, create: { meetingId: meeting.id, status: "PROCESSING" } });
    switchedOn = true;
  });
  if (switchedOn) await pushRoomState(meeting);
  await audit({ action: "interpretation.language", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { language, switchedOn } });
  return getInterpretationState(ctx, ref);
}

/** Stop using my voice for interpretation (and transcription). I keep hearing others in my language. */
export async function stopInterpretingMe(ctx: Ctx, ref: string) {
  const { meeting, me } = await getTranscriptMeeting(ctx, ref);
  if (!me) throw new AppError("FORBIDDEN", "Join the meeting first.");
  await db.meetingParticipant.update({ where: { id: me.id }, data: { transcriptionConsentAt: null } });
  await audit({ action: "transcription.consent_withdrawn", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { via: "interpreter" } });
  return getInterpretationState(ctx, ref);
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

/** End-to-end latency of everything the interpreter said in this meeting (participants only). */
export async function getLatencyReport(ctx: Ctx, ref: string) {
  const { meeting } = await getTranscriptMeeting(ctx, ref);
  const events = await db.interpretationEvent.findMany({ where: { meetingId: meeting.id }, orderBy: { createdAt: "asc" } });
  const stats = (rows: typeof events) => {
    const total = rows.map((e) => e.totalMs).sort((a, b) => a - b);
    const avg = (k: "asrMs" | "mtMs" | "ttsMs" | "queueMs" | "totalMs") => (rows.length ? Math.round(rows.reduce((s, e) => s + e[k], 0) / rows.length) : null);
    return { count: rows.length, avgMs: avg("totalMs"), p50Ms: pct(total, 50), p95Ms: pct(total, 95), maxMs: total.at(-1) ?? null, avgAsrMs: avg("asrMs"), avgMtMs: avg("mtMs"), avgTtsMs: avg("ttsMs"), avgQueueMs: avg("queueMs") };
  };
  const pairs = new Map<string, typeof events>();
  for (const e of events) pairs.set(`${e.sourceLanguage}→${e.targetLanguage}`, [...(pairs.get(`${e.sourceLanguage}→${e.targetLanguage}`) ?? []), e]);
  return {
    meeting: { title: meeting.title, joinCode: meeting.joinCode },
    overall: stats(events),
    byPair: [...pairs.entries()].map(([pair, rows]) => ({ pair, ...stats(rows) })),
    recent: events.slice(-50).reverse().map((e) => ({ at: e.createdAt, source: e.sourceLanguage, target: e.targetLanguage, original: e.sourceText, translated: e.translatedText, asrMs: e.asrMs, mtMs: e.mtMs, ttsMs: e.ttsMs, queueMs: e.queueMs, totalMs: e.totalMs })),
  };
}
