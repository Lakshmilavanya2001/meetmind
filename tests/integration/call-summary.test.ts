import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setLlmProviderForTests } from "@/server/ai/llm";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { setSttProviderForTests } from "@/server/providers/stt";
import { outboxProvider, setSmsProviderForTests } from "@/server/providers/sms";
import { createSampleCall, joinMeeting, createInstantMeeting, endMeeting } from "@/server/services/meetings";
import { enqueueRecordingChunk, renameSpeaker, startRecordingUpload } from "@/server/services/transcripts";
import { deliverSummary, getDeliveries, sendSummaryNow, setSummaryPrefs } from "@/server/services/summary-delivery";
import { confirmPhoneVerification, startPhoneVerification } from "@/server/services/sms";
import { updateProfile } from "@/server/services/profile";
import { summarizeMeeting } from "@/server/services/summaries";
import { runPostCallSummaries } from "@/server/services/post-call";
import { drainJobs } from "@/server/jobs/transcription-worker";
import { parseWav } from "@/server/interpreter/audio";
import { resetRateLimits } from "@/server/rate-limit";
import { createFakeCallingProvider } from "../fake-calling";
import { createFakeStt } from "../fake-stt";
import { createOrg, createUser, resetDb } from "../helpers";

const SUMMARY = {
  summary: ["Move 200 connections to the 5G Business Pro plan. Details: visit http://evil.example/login", "Credit note for 30 disconnected lines"],
  decisions: [{ text: "Go ahead with 5G Business Pro, pending the quote", segments: [1] }],
  action_items: [{ task: "Email the quote", owner: "Rohan", due: "Thursday", segments: [1] }],
  open_issues: [{ text: "Where to deliver the SIM cards", segments: [1] }],
};
beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
  setSmsProviderForTests(outboxProvider);
  setLlmProviderForTests({ model: "t", complete: async () => ({ content: JSON.stringify(SUMMARY), toolCalls: [], finishReason: "stop" }) });
  process.env.EMAIL_DEV_OUTBOX = "true";
});
afterAll(() => {
  setCallingProviderForTests("LIVEKIT", null);
  setSmsProviderForTests(null);
  setLlmProviderForTests(null);
  setSttProviderForTests(null);
});

async function setup() {
  const org = await createOrg();
  const mk = async (name: string) => {
    const u = await createUser(org.id, name, { timezone: "Asia/Kolkata" });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, email: u.email, displayName: name, timezone: "Asia/Kolkata" } };
  };
  return { aisha: await mk("Aisha Khan"), priya: await mk("Priya Patel") };
}
/** Upload a WAV the way the browser does: ≤20 s pieces, announced up front. */
async function upload(ctx: Awaited<ReturnType<typeof setup>>["aisha"], ref: string, wav: Buffer) {
  const { samples } = parseWav(wav);
  const piece = 16000 * 20;
  const n = Math.ceil(samples.length / piece);
  const { recordingId, speakers } = await startRecordingUpload(ctx, ref, { fileName: "call.wav", durationMs: Math.round((samples.length / 16000) * 1000), consentConfirmed: true, chunks: n, language: "en" });
  for (let i = 0; i < n; i++) {
    const part = samples.subarray(i * piece, (i + 1) * piece);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + part.length * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(part.length * 2, 40);
    await enqueueRecordingChunk(ctx, ref, recordingId, { index: i, startMs: i * 20_000, durationMs: Math.round((part.length / 16000) * 1000) }, { data: Buffer.concat([h, Buffer.from(part.buffer, part.byteOffset, part.byteLength)]), mimeType: "audio/wav" });
  }
  return { recordingId, speakers, pieces: n };
}

describe("recorded call → speakers (real Riva)", () => {
  it.skipIf(!process.env.RIVA_REALTIME_URL)("the sample call is transcribed in one pass with two consistent speakers", async () => {
    const { aisha } = await setup();
    const m = await createSampleCall(aisha);
    const r = await upload(aisha, m.joinCode, readFileSync("public/samples/sample-call.wav"));
    expect(r.speakers).toBe(true);
    await drainJobs();
    const segs = await db.transcriptSegment.findMany({ where: { meetingId: m.id }, orderBy: { startMs: "asc" } });
    const labels = [...new Set(segs.map((s) => s.speakerLabel))];
    expect(labels).toEqual(["Speaker 1", "Speaker 2"]);
    expect(segs.length).toBeGreaterThanOrEqual(10);
    // Rohan opens; Priya answers; they alternate.
    expect(segs[0]).toMatchObject({ speakerLabel: "Speaker 1" });
    expect(segs[0].text).toMatch(/Rohan/);
    expect(segs[1]).toMatchObject({ speakerLabel: "Speaker 2" });
    expect(segs.find((s) => /credit note/i.test(s.text))!.speakerLabel).toBe("Speaker 1");
    expect(segs.find((s) => /Dubai/i.test(s.text))!.speakerLabel).toBe("Speaker 2");
    expect((await db.recording.findUniqueOrThrow({ where: { id: r.recordingId } })).status).toBe("READY");
    // Audio pieces are not kept.
    expect(await db.transcriptionJob.count({ where: { recordingId: r.recordingId, status: { not: "SUCCEEDED" } } })).toBe(0);
  }, 120_000);
});

describe("recorded call → fallback without speakers", () => {
  it("if speaker separation keeps failing, each piece is transcribed so nothing is lost", async () => {
    const { aisha } = await setup();
    const prev = process.env.RIVA_REALTIME_URL;
    process.env.RIVA_REALTIME_URL = "ws://127.0.0.1:9/never";
    setSttProviderForTests(createFakeStt());
    try {
      const m = await createSampleCall(aisha);
      const tone = Buffer.from("hello from the recording");
      const wav = Buffer.alloc(44 + 32000 * 2);
      wav.write("RIFF", 0); wav.writeUInt32LE(36 + 64000, 4); wav.write("WAVE", 8); wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(64000, 40);
      tone.copy(wav, 44);
      await upload(aisha, m.joinCode, wav);
      for (let i = 0; i < 3; i++) {
        await drainJobs();
        await db.transcriptionJob.updateMany({ where: { status: "QUEUED" }, data: { runAfter: new Date() } });
      }
      await drainJobs();
      const job = await db.transcriptionJob.findFirstOrThrow({ where: { idempotencyKey: { endsWith: ":diarize" } } });
      expect(job.status).toBe("SUCCEEDED");
      expect(await db.transcriptSegment.count({ where: { meetingId: m.id, speakerLabel: "Recording" } })).toBeGreaterThan(0);
    } finally {
      process.env.RIVA_REALTIME_URL = prev;
      setSttProviderForTests(null);
    }
  }, 60_000);
});

describe("naming speakers", () => {
  it("host renames Speaker 1 everywhere; attendees can't", async () => {
    const { aisha, priya } = await setup();
    const m = await createSampleCall(aisha);
    const t = await db.meetingTranscript.create({ data: { meetingId: m.id, status: "COMPLETED" } });
    await db.transcriptSegment.createMany({ data: [0, 1, 2].map((i) => ({ transcriptId: t.id, meetingId: m.id, speakerLabel: i % 2 ? "Speaker 2" : "Speaker 1", startMs: i * 1000, endMs: i * 1000 + 900, text: `line ${i}`, source: "RECORDING" as const })) });
    await expect(renameSpeaker(priya, m.joinCode, { from: "Speaker 1", to: "x" })).rejects.toBeTruthy();
    expect(await renameSpeaker(aisha, m.joinCode, { from: "Speaker 1", to: "Rohan (account manager)" })).toEqual({ renamed: 2 });
    expect(await db.transcriptSegment.count({ where: { meetingId: m.id, speakerLabel: "Rohan (account manager)" } })).toBe(2);
    await expect(renameSpeaker(aisha, m.joinCode, { from: "Speaker 9", to: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("summary delivery", () => {
  async function endedCallWithSummary() {
    const { aisha, priya } = await setup();
    const m = await createInstantMeeting(aisha, { title: "5G upgrade call" });
    await joinMeeting(aisha, m.joinCode, { publicUrl: "wss://x" });
    await joinMeeting(priya, m.joinCode, { publicUrl: "wss://x" });
    const t = await db.meetingTranscript.create({ data: { meetingId: m.id, status: "PROCESSING" } });
    await db.transcriptSegment.create({ data: { transcriptId: t.id, meetingId: m.id, speakerLabel: "Aisha Khan", speakerUserId: aisha.userId, startMs: 0, endMs: 2000, text: "Let's go with 5G Business Pro.", source: "LIVE_CAPTURE" } });
    await endMeeting(aisha, m.joinCode);
    await db.meetingTranscript.update({ where: { id: t.id }, data: { status: "COMPLETED" } });
    return { aisha, priya, m };
  }

  it("after the call: in the app for everyone, email unless turned off, SMS only if asked and verified", async () => {
    const { aisha, priya, m } = await endedCallWithSummary();
    await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", phoneNumber: "+919812345678" });
    await startPhoneVerification(aisha);
    await confirmPhoneVerification(aisha, { code: /(\d{6})/.exec((await db.smsMessage.findFirstOrThrow()).body)![1] });
    await setSummaryPrefs(aisha, { email: true, sms: true });
    await setSummaryPrefs(priya, { email: false, sms: false });
    await expect(setSummaryPrefs(priya, { email: true, sms: true })).rejects.toThrow(/Verify your mobile/);

    expect(await runPostCallSummaries()).toBe(1);
    const d = await getDeliveries(aisha, m.joinCode);
    const by = Object.fromEntries(d.people.map((p) => [p.name, Object.fromEntries(Object.entries(p.channels).map(([k, v]) => [k, v.status]))]));
    expect(by).toEqual({
      "Aisha Khan": { IN_APP: "SENT", EMAIL: "OUTBOX", SMS: "OUTBOX" },
      "Priya Patel": { IN_APP: "SENT", EMAIL: "SKIPPED", SMS: "SKIPPED" },
    });
    expect(d.channels).toEqual({ email: "outbox", sms: "outbox" });

    const email = await db.emailMessage.findFirstOrThrow({ where: { userId: aisha.userId } });
    expect(email.subject).toBe("Call summary: 5G upgrade call");
    expect(email.text).toMatch(/Key discussion points[\s\S]*Decisions[\s\S]*Go ahead with 5G Business Pro[\s\S]*Action items[\s\S]*Email the quote — Rohan[\s\S]*Open questions/);
    const sms = await db.smsMessage.findFirstOrThrow({ where: { userId: aisha.userId, purpose: "summary" } });
    expect(sms.body).toMatch(/^MeetMind call summary — 5G upgrade call: Move 200 connections/);
    expect(sms.body).not.toMatch(/evil\.example/); // links from the meeting's text are stripped
    expect(sms.body).toMatch(/Full notes: https:\/\/meet\.test\/meetings\/.*\/transcript$/);
    expect(await db.notification.count({ where: { type: "summary.ready" } })).toBe(2);
  });

  it("the host can resend; attendees can't; delivery needs a summary", async () => {
    const { aisha, priya, m } = await endedCallWithSummary();
    await expect(sendSummaryNow(aisha, m.joinCode)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await summarizeMeeting(aisha, m.joinCode);
    await expect(sendSummaryNow(priya, m.joinCode)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const d = await sendSummaryNow(aisha, m.joinCode);
    expect(d.people).toHaveLength(2);
    expect(await db.summaryDelivery.count({ where: { meetingId: m.id } })).toBe(6);
  });

  it("without the dev outbox and with no SMTP, email delivery is reported as failed, not hidden", async () => {
    const { aisha, m } = await endedCallWithSummary();
    await summarizeMeeting(aisha, m.joinCode);
    delete process.env.EMAIL_DEV_OUTBOX;
    const rows = await deliverSummary(m.id);
    expect(rows.filter((r) => r.channel === "EMAIL").map((r) => r.status)).toEqual(["FAILED", "FAILED"]);
    expect((await db.emailMessage.findFirstOrThrow()).error).toMatch(/isn't configured/);
  });
});
