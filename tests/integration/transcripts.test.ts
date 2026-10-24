import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { db } from "@/server/db";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { setSttProviderForTests } from "@/server/providers/stt";
import { createInstantMeeting, endMeeting, joinMeeting } from "@/server/services/meetings";
import { inviteUsers } from "@/server/services/invitations";
import {
  deleteTranscript,
  enqueueLiveChunk,
  enqueueRecordingChunk,
  exportTranscript,
  getTranscript,
  importTranscript,
  purgeExpiredTranscripts,
  setConsent,
  setTranscription,
  startRecordingUpload,
} from "@/server/services/transcripts";
import { drainJobs } from "@/server/jobs/transcription-worker";
import { createFakeCallingProvider } from "../fake-calling";
import { createFakeStt } from "../fake-stt";
import { createOrg, createUser, resetDb } from "../helpers";

process.env.UPLOAD_DIR = path.resolve("tests/.tmp/uploads");

let stt: ReturnType<typeof createFakeStt>;
let calling: ReturnType<typeof createFakeCallingProvider>;
const wav = (text: string) => ({ data: Buffer.from(`RIFF${text}`), mimeType: "audio/wav" });
let n = 0;
const meta = (over: object = {}) => ({ clientChunkId: `chunk-${++n}-abcdef`, capturedAt: new Date(Date.now() - 5000).toISOString(), durationMs: 5000, ...over });

beforeEach(async () => {
  await resetDb();
  stt = createFakeStt();
  calling = createFakeCallingProvider();
  setSttProviderForTests(stt);
  setCallingProviderForTests("LIVEKIT", calling);
});
afterAll(() => {
  setSttProviderForTests(null);
  setCallingProviderForTests("LIVEKIT", null);
});

async function setup() {
  const org = await createOrg();
  const mk = async (name: string) => {
    const u = await createUser(org.id, name);
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, user: { displayName: name, timezone: "UTC", email: u.email } };
  };
  const host = await mk("Hana Host");
  const rahul = await mk("Rahul Sharma");
  const outsider = await mk("Olive Outsider"); // same workspace, not in the meeting
  const meeting = await createInstantMeeting(host, { title: "Planning" });
  await inviteUsers(host, meeting.joinCode, [rahul.userId]);
  await joinMeeting(host, meeting.joinCode, { publicUrl: "wss://x" });
  await joinMeeting(rahul, meeting.joinCode, { publicUrl: "wss://x" });
  return { org, host, rahul, outsider, meeting };
}

describe("enabling transcription & consent", () => {
  it("only moderators can enable; it pushes room state to all clients", async () => {
    const { host, rahul, meeting } = await setup();
    await expect(setTranscription(rahul, meeting.joinCode, { enabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const s = await setTranscription(host, meeting.joinCode, { enabled: true, consentSelf: true });
    expect(s).toMatchObject({ enabled: true, myConsent: true });
    expect(calling.updateRoomMetadata).toHaveBeenCalledWith(`mm-${meeting.joinCode}`, { transcription: true, interpretation: false });
  });

  it("audio is refused unless transcription is on AND the speaker consented", async () => {
    const { host, rahul, meeting } = await setup();
    await expect(enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("hi"))).rejects.toThrow(/turned off/);
    await setTranscription(host, meeting.joinCode, { enabled: true, consentSelf: true });
    await expect(enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("hi"))).rejects.toThrow(/haven't agreed/);
    await setConsent(rahul, meeting.joinCode, true);
    await expect(enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("hi"))).resolves.toMatchObject({ duplicate: false });
    await setConsent(rahul, meeting.joinCode, false); // withdrawing stops further capture
    await expect(enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("again"))).rejects.toThrow(/haven't agreed/);
  });
});

describe("live transcription pipeline", () => {
  async function live() {
    const s = await setup();
    await setTranscription(s.host, s.meeting.joinCode, { enabled: true, consentSelf: true });
    await setConsent(s.rahul, s.meeting.joinCode, true);
    return s;
  }

  it("transcribes chunks into speaker-attributed, time-ordered segments and deletes the audio", async () => {
    const { host, rahul, meeting } = await live();
    await enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("we will ship by november fifteenth"));
    await enqueueLiveChunk(host, meeting.joinCode, meta(), wav("agreed"));
    const jobs = await db.transcriptionJob.findMany();
    const files = jobs.map((j) => path.join(process.env.UPLOAD_DIR!, (j.payload as { storageKey: string }).storageKey));
    expect(files.every(existsSync)).toBe(true);
    expect(await drainJobs()).toBe(2);
    const t = await getTranscript(host, meeting.joinCode);
    expect(t.segments.map((s) => [s.speakerLabel, s.text])).toEqual(expect.arrayContaining([["Rahul Sharma", "we will ship by november fifteenth"], ["Hana Host", "agreed"]]));
    expect(t.segments.find((s) => s.speakerLabel === "Rahul Sharma")?.speakerUserId).toBe(rahul.userId);
    expect(files.some(existsSync)).toBe(false);
  });

  it("duplicate uploads of the same chunk are processed once", async () => {
    const { rahul, meeting } = await live();
    const m = meta();
    const a = await enqueueLiveChunk(rahul, meeting.joinCode, m, wav("once"));
    const b = await enqueueLiveChunk(rahul, meeting.joinCode, m, wav("once"));
    expect(b).toMatchObject({ jobId: a.jobId, duplicate: true });
    await drainJobs();
    expect(await db.transcriptSegment.count()).toBe(1);
  });

  it("retries transient STT failures and records permanent ones", async () => {
    const { host, rahul, meeting } = await live();
    stt.failNext("transient");
    await enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("retried text"));
    await drainJobs();
    let job = await db.transcriptionJob.findFirstOrThrow();
    expect(job).toMatchObject({ status: "QUEUED", attempts: 1 });
    await db.transcriptionJob.update({ where: { id: job.id }, data: { runAfter: new Date() } }); // skip the back-off
    await drainJobs();
    job = await db.transcriptionJob.findFirstOrThrow();
    expect(job).toMatchObject({ status: "SUCCEEDED", attempts: 2 });

    stt.failNext("permanent");
    await enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("broken"));
    await drainJobs();
    expect(await db.transcriptionJob.count({ where: { status: "FAILED" } })).toBe(1);
    await endMeeting(host, meeting.joinCode);
    const t = await getTranscript(host, meeting.joinCode);
    expect(t.transcript).toMatchObject({ status: "COMPLETED", error: "1 audio chunk(s) could not be transcribed." });
  });

  it("silence produces no segment", async () => {
    const { rahul, meeting } = await live();
    await enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("   "));
    await drainJobs();
    expect(await db.transcriptSegment.count()).toBe(0);
  });

  it("finalizes after the meeting ends and applies retention", async () => {
    const { org, host, rahul, meeting } = await live();
    await db.organization.update({ where: { id: org.id }, data: { transcriptRetentionDays: 30 } });
    await enqueueLiveChunk(rahul, meeting.joinCode, meta(), wav("late chunk"));
    await endMeeting(host, meeting.joinCode);
    expect((await getTranscript(host, meeting.joinCode)).transcript?.status).toBe("PROCESSING"); // a chunk is still pending
    await drainJobs();
    const t = await db.meetingTranscript.findFirstOrThrow();
    expect(t.status).toBe("COMPLETED");
    expect(t.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);

    await db.meetingTranscript.update({ where: { id: t.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await purgeExpiredTranscripts()).toBe(1);
    expect(await db.transcriptSegment.count()).toBe(0);
  });
});

describe("access control", () => {
  it("only meeting participants can read transcripts", async () => {
    const { host, rahul, outsider, meeting } = await setup();
    await expect(getTranscript(rahul, meeting.joinCode)).resolves.toBeTruthy();
    await expect(getTranscript(outsider, meeting.joinCode)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await createOrg("Other");
    const stranger = await createUser(other.id, "Stranger");
    await expect(getTranscript({ userId: stranger.id, organizationId: other.id, orgRole: "MEMBER", user: { displayName: "Stranger" } }, meeting.joinCode)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteTranscript(rahul, meeting.joinCode)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deleteTranscript(host, meeting.joinCode)).resolves.toBeUndefined();
  });
});

describe("fallbacks: recording upload & transcript import", () => {
  it("transcribes an uploaded recording in chunks without attributing speakers", async () => {
    const { host, rahul, meeting } = await setup();
    await expect(startRecordingUpload(rahul, meeting.joinCode, { fileName: "a.m4a", durationMs: 60000, consentConfirmed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(startRecordingUpload(host, meeting.joinCode, { fileName: "a.m4a", durationMs: 60000 })).rejects.toThrow();
    const { recordingId } = await startRecordingUpload(host, meeting.joinCode, { fileName: "a.m4a", durationMs: 60000, consentConfirmed: true });
    await enqueueRecordingChunk(host, meeting.joinCode, recordingId, { index: 0, startMs: 0, durationMs: 20000 }, wav("part one"));
    await enqueueRecordingChunk(host, meeting.joinCode, recordingId, { index: 1, startMs: 20000, durationMs: 20000 }, wav("part two"));
    await enqueueRecordingChunk(host, meeting.joinCode, recordingId, { index: 1, startMs: 20000, durationMs: 20000 }, wav("part two")); // retry
    await drainJobs();
    const t = await getTranscript(host, meeting.joinCode);
    expect(t.segments.map((s) => [s.startMs, s.speakerLabel, s.speakerUserId, s.text])).toEqual([
      [0, "Recording", null, "part one"],
      [20000, "Recording", null, "part two"],
    ]);
    expect((await db.recording.findUniqueOrThrow({ where: { id: recordingId } })).status).toBe("READY");
  });

  it("imports VTT; links speakers only on an unambiguous name match; won't overwrite silently", async () => {
    const { org, host, meeting } = await setup();
    const twin = await createUser(org.id, "Rahul Sharma");
    await inviteUsers(host, meeting.joinCode, [twin.id]);
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Hana Host>Let's begin.\n\n00:00:04.000 --> 00:00:06.000\n<v Rahul Sharma>Budget is 50k.";
    expect(await importTranscript(host, meeting.joinCode, { content: vtt, fileName: "x.vtt" })).toMatchObject({ format: "vtt", segments: 2 });
    const segs = (await getTranscript(host, meeting.joinCode)).segments;
    expect(segs[0].speakerUserId).toBe(host.userId);
    expect(segs[1].speakerUserId).toBeNull(); // two Rahul Sharmas: not attributed
    await expect(importTranscript(host, meeting.joinCode, { content: vtt })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(importTranscript(host, meeting.joinCode, { content: "Hana Host: replaced", replace: true })).resolves.toMatchObject({ segments: 1 });
  });

  it("exports txt, vtt, srt and json", async () => {
    const { host, meeting } = await setup();
    await importTranscript(host, meeting.joinCode, { content: "[00:05] Hana Host: hello\n[01:10] Hana Host: bye" });
    expect((await exportTranscript(host, meeting.joinCode, "txt")).body).toBe("[00:00:05] Hana Host: hello\n[00:01:10] Hana Host: bye\n");
    expect((await exportTranscript(host, meeting.joinCode, "vtt")).body).toMatch(/^WEBVTT\n\n00:00:05.000 --> 00:01:10.000\n<v Hana Host>hello/);
    expect((await exportTranscript(host, meeting.joinCode, "srt")).body).toMatch(/^1\n00:00:05,000 --> 00:01:10,000\nHana Host: hello/);
    expect(JSON.parse((await exportTranscript(host, meeting.joinCode, "json")).body).segments).toHaveLength(2);
  });
});
