import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { setSttProviderForTests } from "@/server/providers/stt";
import { setTtsProviderForTests } from "@/server/providers/tts";
import { setLlmProviderForTests, type ChatMessage, type CompletionResult } from "@/server/ai/llm";
import { handleUtterance } from "@/server/services/voice";
import { createInstantMeeting, joinMeeting } from "@/server/services/meetings";
import { createFakeCallingProvider } from "../fake-calling";
import { createFakeStt } from "../fake-stt";
import { routeReply } from "../fake-llm";
import { createOrg, createUser, resetDb } from "../helpers";

// The fake STT "transcribes" by reading the uploaded bytes as text.
const said = (text: string) => ({ data: Buffer.from(text), mimeType: "audio/wav" });
let n = 0;
const call = (name: string, args: object) => ({ id: `v${++n}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const script = (steps: ((m: ChatMessage[]) => Partial<CompletionResult>)[]) =>
  setLlmProviderForTests({ model: "s", complete: async (req) => { const routed = routeReply(req); if (routed) return routed; const r = { content: "", toolCalls: [], finishReason: "stop", ...steps.shift()!(req.messages) }; if (r.content) req.onDelta?.(r.content); return r; } });

beforeEach(async () => {
  await resetDb();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
  setSttProviderForTests(createFakeStt());
  setTtsProviderForTests({ languages: ["en"], synthesize: async (text, { language }) => (language === "en" ? { audio: Buffer.from(`WAV:${text}`), mimeType: "audio/wav" } : null) });
});
afterAll(() => {
  setCallingProviderForTests("LIVEKIT", null);
  setSttProviderForTests(null);
  setTtsProviderForTests(null);
  setLlmProviderForTests(null);
});

async function setup() {
  const org = await createOrg();
  const mk = async (name: string, title?: string) => {
    const u = await createUser(org.id, name);
    if (title) await db.user.update({ where: { id: u.id }, data: { title } });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, email: u.email, displayName: name, timezone: "UTC" } };
  };
  const host = await mk("Hana Host");
  const rahul = await mk("Rahul Sharma", "Backend Engineer");
  const meeting = await createInstantMeeting(host, { title: "Sync" });
  await joinMeeting(host, meeting.joinCode, { publicUrl: "wss://x" });
  return { host, rahul, meeting };
}

describe("voice assistant mid-call", () => {
  it("ignores speech that isn't addressed to it (nothing stored)", async () => {
    const { host, meeting } = await setup();
    const heard: { triggered: boolean }[] = [];
    const r = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "wake" }, said("I think the deadline is Friday"), (h) => heard.push(h));
    expect(r).toEqual({ heard: "", triggered: false });
    expect(heard).toEqual([{ heard: "I think the deadline is Friday", triggered: false }]); // told early: translate it
    expect(await db.agentConversation.count()).toBe(0);
  });

  it("“Hey Mind, add Rahul to this call” → spoken confirmation → “yes” → invited", async () => {
    const { host, rahul, meeting } = await setup();
    script([
      () => ({ toolCalls: [call("search_users", { query: "Rahul" })] }),
      () => ({ toolCalls: [call("invite_participants", { meeting: "current", user_ids: [rahul.userId] })] }),
    ]);
    const r = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "wake" }, said("Hey Mind, add Rahul to this call"));
    expect(r.heard).toBe("add Rahul to this call");
    expect(r.confirmation?.summary).toMatch(/Ask Rahul Sharma/);
    expect(r.speech?.text).toMatch(/Say yes to confirm, or no to cancel\.$/);
    expect(r.speech?.text).not.toMatch(/@/); // emails are not read aloud
    expect(r.speech?.audioBase64).toBeTruthy();
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id, userId: rahul.userId } })).toBe(0);

    const unclear = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "confirm", actionId: r.confirmation!.actionId, conversationId: r.conversationId }, said("hmm maybe"));
    expect(unclear.speech?.text).toMatch(/say yes or no/);
    const yes = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "confirm", actionId: r.confirmation!.actionId, conversationId: r.conversationId }, said("yes"));
    expect(yes.reply).toMatch(/Done/);
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id, userId: rahul.userId } })).toBe(1);
    expect(await db.callRing.count({ where: { calleeId: rahul.userId, status: "RINGING" } })).toBe(1); // and his app rings
  });

  it("a bare “Hey Mind” asks what to do; push-to-talk needs no wake phrase", async () => {
    const { host, meeting } = await setup();
    expect(await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "wake" }, said("Hey Mind"))).toMatchObject({ triggered: true, expectCommand: true });
    script([() => ({ content: "There are 1 people in this call." })]);
    const r = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "ptt" }, said("who is here"));
    expect(r).toMatchObject({ triggered: true, heard: "who is here", reply: "There are 1 people in this call." });
  });

  it("uses the browser voice when the language can't be synthesised", async () => {
    const { host, meeting } = await setup();
    await db.user.update({ where: { id: host.userId }, data: { preferredLanguage: "hi" } });
    script([() => ({ content: "ठीक है" })]);
    const r = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "ptt" }, said("नमस्ते"));
    expect(r.speech).toEqual({ text: "ठीक है", language: "hi" });
  });

  it("in an interpreted call it listens and answers in the language I picked, and can start transcription by voice", async () => {
    const { host, meeting } = await setup();
    // Profile says English, but in this call I picked Hindi in the interpreter menu.
    await db.meetingParticipant.update({ where: { meetingId_userId: { meetingId: meeting.id, userId: host.userId } }, data: { callLanguage: "hi" } });
    let system = "";
    script([
      (m) => {
        system = String(m[0].content);
        return { toolCalls: [call("set_call_transcription", { meeting: "current", enabled: true })] };
      },
      () => ({ content: "ट्रांसक्रिप्शन शुरू करने से पहले पुष्टि करें।" }),
    ]);
    const stt = createFakeStt();
    setSttProviderForTests(stt);
    const early: { triggered: boolean }[] = [];
    const r = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "wake" }, said("हे माइंड, इस कॉल को ट्रांसक्राइब करो"), (h) => early.push(h));
    expect(early).toEqual([{ heard: "हे माइंड, इस कॉल को ट्रांसक्राइब करो", triggered: true }]); // before the agent ran
    expect((stt.transcribe as unknown as { mock: { calls: [Buffer, { language: string }][] } }).mock.calls[0][1].language).toBe("hi");
    expect(system).toContain('preferred language is "hi"');
    expect(r.speech?.language).toBe("hi");
    expect(r.confirmation?.summary).toMatch(/Start transcribing “Sync” for everyone/);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).transcriptionEnabled).toBe(false); // not yet
    const yes = await handleUtterance(host, { meetingRef: meeting.joinCode, mode: "confirm", actionId: r.confirmation!.actionId, conversationId: r.conversationId }, said("हाँ"));
    expect(yes.triggered).toBe(true);
    const m = await db.meeting.findUniqueOrThrow({ where: { id: meeting.id }, include: { participants: true } });
    expect(m.transcriptionEnabled).toBe(true);
    expect(m.participants.find((p) => p.userId === host.userId)!.transcriptionConsentAt).not.toBeNull();
  });

  it("only participants of a live call can use it", async () => {
    const { rahul, meeting } = await setup();
    await expect(handleUtterance(rahul, { meetingRef: meeting.joinCode, mode: "ptt" }, said("hello"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
