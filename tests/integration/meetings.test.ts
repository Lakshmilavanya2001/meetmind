import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setCallingProviderForTests } from "@/server/providers/calling";
import {
  createInstantMeeting,
  endMeeting,
  getAccessibleMeeting,
  handleCallingEvent,
  joinMeeting,
  listLiveParticipants,
  muteParticipant,
  parseMeetingRef,
  removeParticipant,
  setParticipantRole,
} from "@/server/services/meetings";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

let fake: ReturnType<typeof createFakeCallingProvider>;
const URL = { publicUrl: "wss://meet.test" };

const ctxOf = (u: { id: string; displayName: string }, orgId: string) => ({ userId: u.id, organizationId: orgId, user: { displayName: u.displayName } });

async function setup() {
  const org = await createOrg();
  const host = await createUser(org.id, "Hana Host");
  const bob = await createUser(org.id, "Bob Attendee");
  const carol = await createUser(org.id, "Carol Cohost");
  const H = ctxOf(host, org.id), B = ctxOf(bob, org.id), C = ctxOf(carol, org.id);
  const meeting = await createInstantMeeting(H, { title: "Standup" });
  return { org, host, bob, carol, H, B, C, meeting, room: `mm-${meeting.joinCode}` };
}

beforeEach(async () => {
  await resetDb();
  fake = createFakeCallingProvider();
  setCallingProviderForTests("LIVEKIT", fake);
});
afterAll(() => setCallingProviderForTests("LIVEKIT", null));

describe("meeting refs", () => {
  it("accepts codes, ids and full links", () => {
    expect(parseMeetingRef("ABC-DEFG-HIJ")).toBe("abc-defg-hij");
    expect(parseMeetingRef("https://x.test:3443/m/abc-defg-hij?foo=1")).toBe("abc-defg-hij");
  });
});

describe("instant meetings & joining", () => {
  it("creator is host; join mints a token and marks the meeting live", async () => {
    const { H, meeting, room } = await setup();
    const res = await joinMeeting(H, meeting.joinCode, URL);
    expect(res.myRole).toBe("HOST");
    expect(res.serverUrl).toBe("wss://meet.test");
    expect(res.token).toContain(`${room}:${H.userId}`);
    expect(fake.ensureRoom).toHaveBeenCalledWith(room, expect.anything());
    const m = await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.status).toBe("LIVE");
    expect(m.startedAt).not.toBeNull();
  });

  it("workspace members can join by link as attendees; joining twice is idempotent", async () => {
    const { B, meeting } = await setup();
    expect((await joinMeeting(B, meeting.joinCode, URL)).myRole).toBe("ATTENDEE");
    await joinMeeting(B, meeting.joinCode, URL);
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id } })).toBe(2);
  });

  it("people from another workspace get NOT_FOUND (existence is not revealed)", async () => {
    const { meeting } = await setup();
    const other = await createOrg("Other");
    const outsider = await createUser(other.id, "Olly Outsider");
    await expect(joinMeeting(ctxOf(outsider, other.id), meeting.joinCode, URL)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getAccessibleMeeting(ctxOf(outsider, other.id), meeting.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not change state when the calling provider is down", async () => {
    const { B, meeting } = await setup();
    fake.setFailing(true);
    await expect(joinMeeting(B, meeting.joinCode, URL)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).status).toBe("SCHEDULED");
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id, userId: B.userId } })).toBe(0);
  });

  it("cannot join a cancelled meeting", async () => {
    const { B, meeting } = await setup();
    await db.meeting.update({ where: { id: meeting.id }, data: { status: "CANCELED" } });
    await expect(joinMeeting(B, meeting.joinCode, URL)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("host controls", () => {
  async function inCall() {
    const s = await setup();
    for (const c of [s.H, s.B, s.C]) {
      await joinMeeting(c, s.meeting.joinCode, URL);
      fake.connect(s.room, c.userId);
    }
    return s;
  }

  it("attendees cannot moderate", async () => {
    const { B, C, meeting } = await inCall();
    await expect(removeParticipant(B, meeting.joinCode, C.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(muteParticipant(B, meeting.joinCode, C.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(endMeeting(B, meeting.joinCode)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setParticipantRole(B, meeting.joinCode, C.userId, "COHOST")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("host can promote a co-host, who can then mute and remove attendees", async () => {
    const { H, B, C, meeting, room } = await inCall();
    await setParticipantRole(H, meeting.joinCode, C.userId, "COHOST");
    expect(await muteParticipant(C, meeting.joinCode, B.userId)).toEqual({ muted: true });
    await removeParticipant(C, meeting.joinCode, B.userId);
    expect(fake.rooms.get(room)!.has(B.userId)).toBe(false);
  });

  it("removed participants cannot rejoin", async () => {
    const { H, B, meeting } = await inCall();
    await removeParticipant(H, meeting.joinCode, B.userId);
    await expect(joinMeeting(B, meeting.joinCode, URL)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.auditLog.count({ where: { action: "meeting.participant_remove" } })).toBe(1);
  });

  it("nobody can remove the host; co-hosts cannot remove co-hosts", async () => {
    const { H, B, C, meeting } = await inCall();
    await setParticipantRole(H, meeting.joinCode, C.userId, "COHOST");
    await setParticipantRole(H, meeting.joinCode, B.userId, "COHOST");
    await expect(removeParticipant(C, meeting.joinCode, H.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(removeParticipant(C, meeting.joinCode, B.userId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("live participant list merges provider presence with server roles", async () => {
    const { H, B, meeting } = await inCall();
    const list = await listLiveParticipants(B, meeting.joinCode);
    expect(list).toHaveLength(3);
    expect(list.find((p) => p.userId === H.userId)?.role).toBe("HOST");
  });

  it("end meeting closes the room for everyone", async () => {
    const { H, meeting, room } = await inCall();
    await endMeeting(H, meeting.joinCode);
    expect(fake.endRoom).toHaveBeenCalledWith(room);
    const m = await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    expect(m.status).toBe("ENDED");
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id, leftAt: null } })).toBe(0);
  });
});

describe("provider webhooks", () => {
  it("track joins, leaves and room close; ignore unknown rooms", async () => {
    const { H, B, meeting, room } = await setup();
    await joinMeeting(H, meeting.joinCode, URL);
    await joinMeeting(B, meeting.joinCode, URL);
    const t = new Date("2026-01-01T10:05:00Z");
    await handleCallingEvent("LIVEKIT", { type: "participant_joined", roomId: room, identity: B.userId, at: t });
    let p = await db.meetingParticipant.findFirstOrThrow({ where: { meetingId: meeting.id, userId: B.userId } });
    expect(p.firstJoinedAt).toEqual(t);
    await handleCallingEvent("LIVEKIT", { type: "participant_left", roomId: room, identity: B.userId, at: t });
    p = await db.meetingParticipant.findFirstOrThrow({ where: { meetingId: meeting.id, userId: B.userId } });
    expect(p.leftAt).toEqual(t);
    await handleCallingEvent("LIVEKIT", { type: "room_finished", roomId: room, at: t });
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).status).toBe("ENDED");
    await expect(handleCallingEvent("LIVEKIT", { type: "room_finished", roomId: "mm-unknown", at: t })).resolves.toBeUndefined();
  });
});
