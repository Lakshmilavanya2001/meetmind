import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { cancelRings, expireRings, getRingStates, listIncomingCalls, respondToRing, ringAgain, startCall } from "@/server/services/calls";
import { createInstantMeeting, endMeeting, joinMeeting } from "@/server/services/meetings";
import { inviteUsers } from "@/server/services/invitations";
import { updateProfile } from "@/server/services/profile";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";
import type { OrgRole } from "@/generated/prisma/enums";

beforeEach(async () => {
  await resetDb();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
});
afterAll(() => setCallingProviderForTests("LIVEKIT", null));

async function setup() {
  const org = await createOrg();
  const mk = async (name: string, role: OrgRole = "MEMBER") => {
    const u = await createUser(org.id, name, { role });
    return { userId: u.id, organizationId: org.id, orgRole: role, user: { displayName: name, timezone: "UTC" } };
  };
  return { org, aisha: await mk("Aisha Khan"), rahul: await mk("Rahul Sharma"), priya: await mk("Priya Patel"), mk };
}

describe("calling people", () => {
  it("a voice call rings the callee, who can accept and join", async () => {
    const { aisha, rahul } = await setup();
    const { meeting } = await startCall(aisha, { userIds: [rahul.userId], type: "VOICE" });
    expect(meeting.callType).toBe("VOICE");
    await joinMeeting(aisha, meeting.joinCode, { publicUrl: "wss://x" });
    const incoming = await listIncomingCalls(rahul);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ caller: { displayName: "Aisha Khan" }, meeting: { joinCode: meeting.joinCode, callType: "VOICE" } });
    expect(await listIncomingCalls(aisha)).toHaveLength(0);

    const res = await respondToRing(rahul, incoming[0].id, "accept");
    expect(res.joinCode).toBe(meeting.joinCode);
    await expect(joinMeeting(rahul, meeting.joinCode, { publicUrl: "wss://x" })).resolves.toMatchObject({ myRole: "ATTENDEE" });
    expect(await getRingStates(aisha, meeting.joinCode)).toEqual([expect.objectContaining({ displayName: "Rahul Sharma", status: "ACCEPTED" })]);
    await expect(respondToRing(rahul, incoming[0].id, "accept")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("declines and unanswered calls are reported to the caller; missed calls notify the callee", async () => {
    const { aisha, rahul, priya } = await setup();
    const { meeting } = await startCall(aisha, { userIds: [rahul.userId, priya.userId], type: "VIDEO" });
    const [ring] = await listIncomingCalls(rahul);
    await respondToRing(rahul, ring.id, "decline");
    await db.callRing.updateMany({ where: { calleeId: priya.userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireRings();
    const states = Object.fromEntries((await getRingStates(aisha, meeting.joinCode)).map((s) => [s.displayName, s.status]));
    expect(states).toEqual({ "Rahul Sharma": "DECLINED", "Priya Patel": "MISSED" });
    expect((await db.notification.findFirstOrThrow({ where: { userId: priya.userId } })).title).toBe("Missed video call from Aisha Khan");
    expect(await listIncomingCalls(priya)).toHaveLength(0);
  });

  it("hanging up or ending stops the ringing", async () => {
    const { aisha, rahul, priya } = await setup();
    const a = await startCall(aisha, { userIds: [rahul.userId], type: "VOICE" });
    await cancelRings(aisha, a.meeting.joinCode);
    expect(await listIncomingCalls(rahul)).toHaveLength(0);
    const b = await startCall(aisha, { userIds: [priya.userId], type: "VOICE" });
    await joinMeeting(aisha, b.meeting.joinCode, { publicUrl: "wss://x" });
    await endMeeting(aisha, b.meeting.joinCode);
    expect(await listIncomingCalls(priya)).toHaveLength(0);
  });

  it("adding someone to a live meeting rings them; ringing again works only for participants", async () => {
    const { aisha, rahul, priya } = await setup();
    const m = await createInstantMeeting(aisha, { title: "Standup" });
    await joinMeeting(aisha, m.joinCode, { publicUrl: "wss://x" });
    await inviteUsers(aisha, m.joinCode, [rahul.userId]);
    expect(await listIncomingCalls(rahul)).toHaveLength(1);
    await expect(ringAgain(aisha, m.joinCode, [priya.userId])).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("only workspace members can be called; no self-calls; guests can't start calls; only the callee can answer", async () => {
    const { aisha, rahul, priya, mk } = await setup();
    const other = await createOrg("Other");
    const outsider = await createUser(other.id, "Olly");
    await expect(startCall(aisha, { userIds: [outsider.id] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(startCall(aisha, { userIds: [aisha.userId] })).rejects.toThrow(/yourself/);
    const guest = await mk("Gus Guest", "GUEST");
    await expect(startCall(guest, { userIds: [rahul.userId] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await startCall(aisha, { userIds: [rahul.userId] });
    const [ring] = await listIncomingCalls(rahul);
    await expect(respondToRing(priya, ring.id, "accept")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Phase 12: ringing is limited to people in the call", () => {
  it("a workspace member outside the call can't ring its participants or read ring states", async () => {
    const { aisha, rahul, priya } = await setup();
    const { meeting } = await startCall(aisha, { userIds: [rahul.userId], type: "VOICE" });
    await joinMeeting(aisha, meeting.joinCode, { publicUrl: "wss://x" });
    await expect(ringAgain(priya, meeting.joinCode, [rahul.userId])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getRingStates(priya, meeting.joinCode)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepting after the call ended fails and stops the ring", async () => {
    const { aisha, rahul } = await setup();
    const { meeting } = await startCall(aisha, { userIds: [rahul.userId], type: "VOICE" });
    await joinMeeting(aisha, meeting.joinCode, { publicUrl: "wss://x" });
    const [ring] = await listIncomingCalls(rahul);
    await db.meeting.update({ where: { id: meeting.id }, data: { status: "ENDED" } }); // ended without the usual ring cleanup
    await expect(respondToRing(rahul, ring.id, "accept")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.callRing.findUniqueOrThrow({ where: { id: ring.id } })).status).toBe("CANCELED");
  });
});

describe("profile: language and phone", () => {
  it("normalises phone numbers, rejects bad ones, and un-verifies on change", async () => {
    const { aisha } = await setup();
    await db.user.update({ where: { id: aisha.userId }, data: { phoneNumber: "+919800000000", phoneVerifiedAt: new Date() } });
    const p = await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", preferredLanguage: "hi", phoneNumber: "+91 98123 45678" });
    expect(p).toMatchObject({ preferredLanguage: "hi", phoneNumber: "+919812345678", phoneVerifiedAt: null });
    await expect(updateProfile(aisha, { displayName: "Aisha Khan", timezone: "UTC", phoneNumber: "98123" })).rejects.toThrow(/international format/);
    await expect(updateProfile(aisha, { displayName: "Aisha Khan", timezone: "UTC", preferredLanguage: "xx" })).rejects.toThrow();
  });
});
