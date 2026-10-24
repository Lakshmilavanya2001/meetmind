// Regression tests for the Phase 7 security review findings.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { setLlmProviderForTests, type ChatMessage, type CompletionResult } from "@/server/ai/llm";
import { runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { createInstantMeeting, endMeeting, handleCallingEvent, joinMeeting, muteParticipant, removeParticipant, setParticipantRole } from "@/server/services/meetings";
import { acceptExternalInvitation, acceptExternalInvitationAsNewUser, inviteByEmail, inviteUsers } from "@/server/services/invitations";
import { importTranscript } from "@/server/services/transcripts";
import { findConflicts } from "@/server/services/calendar";
import { scheduleMeeting } from "@/server/services/scheduling";
import { login } from "@/server/services/auth";
import { readBodyLimited } from "@/server/http";
import { parseTranscriptFile } from "@/server/transcript-import";
import { createFakeCallingProvider } from "../fake-calling";
import { routeReply } from "../fake-llm";
import { createOrg, createUser, loginAs, resetDb, TEST_PASSWORD } from "../helpers";

let fake: ReturnType<typeof createFakeCallingProvider>;
beforeEach(async () => {
  await resetDb();
  fake = createFakeCallingProvider();
  setCallingProviderForTests("LIVEKIT", fake);
});
afterAll(() => {
  setCallingProviderForTests("LIVEKIT", null);
  setLlmProviderForTests(null);
});

async function setup() {
  const org = await createOrg();
  const mk = async (name: string, email?: string) => {
    const u = await createUser(org.id, name, { email });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, displayName: name, timezone: "UTC", email: u.email } };
  };
  const host = await mk("Hana Host");
  const cohost = await mk("Cora Cohost");
  const member = await mk("Mallory Member");
  const meeting = await createInstantMeeting(host, { title: "Board" });
  await inviteUsers(host, meeting.joinCode, [cohost.userId]);
  await setParticipantRole(host, meeting.joinCode, cohost.userId, "COHOST");
  return { org, host, cohost, member, meeting };
}

describe("#1 guest invitation links are single-use and never undo a removal", () => {
  it("a removed guest can't get back in with their old link", async () => {
    const { org, host, meeting } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { allowExternalInvites: true } });
    const inv = await inviteByEmail(host, meeting.joinCode, "guest@outside.dev");
    if (inv.kind !== "external") throw new Error();
    const token = inv.inviteLink.split("/invite/")[1];
    const { userId } = await acceptExternalInvitationAsNewUser(token, { displayName: "Gil Guest", password: "guest-password-1" });
    await removeParticipant(host, meeting.joinCode, userId);
    const { ctx } = await loginAs(userId, org.id);
    await expect(acceptExternalInvitation(ctx, token)).rejects.toMatchObject({ code: "FORBIDDEN" }); // revoked on removal
    expect((await db.meetingParticipant.findFirstOrThrow({ where: { userId } })).removedAt).not.toBeNull();
  });
});

describe("#2 ended meetings can't be joined by outsiders", () => {
  it("a member who wasn't in the meeting can't join it after it ended (and so can't read its transcript)", async () => {
    const { host, cohost, member, meeting } = await setup();
    await joinMeeting(host, meeting.joinCode, { publicUrl: "wss://x" });
    await endMeeting(host, meeting.joinCode);
    await expect(joinMeeting(member, meeting.joinCode, { publicUrl: "wss://x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id, userId: member.userId } })).toBe(0);
    await expect(joinMeeting(cohost, meeting.joinCode, { publicUrl: "wss://x" })).resolves.toBeTruthy(); // participants may reopen
  });
});

describe("#3 transcript import is linear-time", () => {
  it("adversarial 1 MB inputs parse quickly", () => {
    for (const evil of ["<v" + " ".repeat(1_000_000) + "x", "WEBVTT\n\n00:00.000 --> 00:01.000\n" + "<".repeat(1_000_000)]) {
      const t = Date.now();
      parseTranscriptFile(evil);
      expect(Date.now() - t).toBeLessThan(500);
    }
    expect(parseTranscriptFile("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Rahul Sharma>hi</v>").segments[0]).toMatchObject({ speaker: "Rahul Sharma", text: "hi" });
  });
});

describe("#4 stale call tokens", () => {
  it("kicks removed people and anyone joining an ended meeting's room", async () => {
    const { host, cohost, meeting } = await setup();
    await joinMeeting(host, meeting.joinCode, { publicUrl: "wss://x" });
    await joinMeeting(cohost, meeting.joinCode, { publicUrl: "wss://x" });
    await setParticipantRole(host, meeting.joinCode, cohost.userId, "ATTENDEE");
    await removeParticipant(host, meeting.joinCode, cohost.userId);
    vi.mocked(fake.removeParticipant).mockClear();
    await handleCallingEvent("LIVEKIT", { type: "participant_joined", roomId: `mm-${meeting.joinCode}`, identity: cohost.userId, at: new Date() });
    expect(fake.removeParticipant).toHaveBeenCalledWith(`mm-${meeting.joinCode}`, cohost.userId);

    await endMeeting(host, meeting.joinCode);
    await handleCallingEvent("LIVEKIT", { type: "room_started", roomId: `mm-${meeting.joinCode}`, at: new Date() });
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).status).toBe("ENDED");
    await handleCallingEvent("LIVEKIT", { type: "participant_joined", roomId: `mm-${meeting.joinCode}`, identity: host.userId, at: new Date() });
    expect(fake.removeParticipant).toHaveBeenCalledWith(`mm-${meeting.joinCode}`, host.userId);
  });
});

describe("#5 the assistant can't be steered into acting without confirmation", () => {
  let n = 0;
  const call = (name: string, args: object) => ({ id: `c${++n}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
  const script = (steps: ((m: ChatMessage[]) => Partial<CompletionResult>)[]) =>
    setLlmProviderForTests({ model: "s", complete: async (req) => routeReply(req) ?? ({ content: "", toolCalls: [], finishReason: "stop", ...steps.shift()!(req.messages) }) });

  it("invites wait for confirmation — even with auto-execution on, once untrusted text was read", async () => {
    const { org, host, member, meeting } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { agentAutoExecute: true } });
    script([
      () => ({ toolCalls: [call("get_meeting_participants", { meeting: meeting.joinCode })] }), // untrusted text enters the context
      () => ({ toolCalls: [call("invite_participants", { meeting: meeting.joinCode, user_ids: [member.userId] })] }),
    ]);
    const events: AgentEvent[] = [];
    await runAgentTurn(host, { message: "Who's in the board meeting?" }, (e) => events.push(e));
    expect(events.some((e) => e.type === "confirmation")).toBe(true);
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id, userId: member.userId } })).toBe(0);
  });
});

describe("#6 bounded uploads", () => {
  it("rejects oversized bodies even without a Content-Length", async () => {
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(100_000)); c.close(); } });
    const req = new Request("http://x", { method: "POST", body: big, duplex: "half" } as RequestInit);
    await expect(readBodyLimited(req, 1_000_000)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("#7 co-hosts can't do host-only things", () => {
  it("can't replace the transcript or mute the host", async () => {
    const { host, cohost, meeting } = await setup();
    await importTranscript(host, meeting.joinCode, { content: "Hana Host: hello" });
    await expect(importTranscript(cohost, meeting.joinCode, { content: "Cora Cohost: wiped", replace: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(muteParticipant(cohost, meeting.joinCode, host.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("#9 smaller issues", () => {
  it("availability doesn't leak busy time from another workspace", async () => {
    const { host, member } = await setup();
    const other = await createOrg("Other");
    await db.organizationMember.create({ data: { organizationId: other.id, userId: member.userId, role: "MEMBER" } });
    const otherHost = await createUser(other.id, "Otto");
    const start = new Date(Date.now() + 86400_000);
    await scheduleMeeting({ userId: otherHost.id, organizationId: other.id, orgRole: "MEMBER", user: { displayName: "Otto", timezone: "UTC" } }, { title: "Secret", startTime: start.toISOString(), endTime: new Date(start.getTime() + 3600_000).toISOString(), participantIds: [member.userId] });
    expect(await findConflicts(host, [member.userId], start, new Date(start.getTime() + 3600_000))).toHaveLength(0);
  });

  it("failed logins from one IP don't lock the account for other IPs", async () => {
    const org = await createOrg();
    await createUser(org.id, "Vic", { email: "vic@test.dev" });
    for (let i = 0; i < 10; i++) await login({ email: "vic@test.dev", password: "wrong" }, { ip: "6.6.6.6" }).catch(() => {});
    await expect(login({ email: "vic@test.dev", password: TEST_PASSWORD }, { ip: "6.6.6.6" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(login({ email: "vic@test.dev", password: TEST_PASSWORD }, { ip: "10.0.0.2" })).resolves.toBeTruthy();
  });
});
