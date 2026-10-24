import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { cancelMeeting, rescheduleMeeting, scheduleMeeting } from "@/server/services/scheduling";
import { findFreeSlots, getAvailability } from "@/server/services/calendar";
import { respondToInvitation } from "@/server/services/invitations";
import { createOrg, createUser, resetDb } from "../helpers";
import type { OrgRole } from "@/generated/prisma/enums";

beforeEach(resetDb);

const DAY = 24 * 3600_000;
const at = (daysFromNow: number, hourUtc: number, min = 0) => {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setUTCHours(hourUtc, min, 0, 0);
  return d;
};

async function setup() {
  const org = await createOrg();
  const mk = async (name: string, role: OrgRole = "MEMBER", timezone = "UTC") => {
    const u = await createUser(org.id, name, { role, timezone });
    return { userId: u.id, organizationId: org.id, orgRole: role, user: { displayName: name, timezone, email: u.email } };
  };
  const host = await mk("Hana Host");
  const rahul = await mk("Rahul Sharma", "MEMBER", "Asia/Kolkata");
  const priya = await mk("Priya Patel", "MEMBER", "America/New_York");
  return { org, mk, host, rahul, priya };
}

const sched = (startDays: number, h: number, durMin: number, ids: string[], extra: object = {}) => ({
  title: "Project review",
  startTime: at(startDays, h).toISOString(),
  endTime: new Date(at(startDays, h).getTime() + durMin * 60_000).toISOString(),
  participantIds: ids,
  ...extra,
});

describe("scheduleMeeting", () => {
  it("creates the meeting, calendar entries, invitations and notifications", async () => {
    const { host, rahul, priya } = await setup();
    const res = await scheduleMeeting(host, sched(1, 15, 30, [rahul.userId, priya.userId]));
    expect(res.meeting.joinCode).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(res.invited.map((i) => i.displayName).sort()).toEqual(["Priya Patel", "Rahul Sharma"]);
    // Email isn't configured in tests — reported honestly, not claimed as sent.
    expect(res.invited.every((i) => i.emailStatus === "not_configured")).toBe(true);

    const events = await db.calendarEvent.findMany({ where: { meetingId: res.meeting.id } });
    expect(events.find((e) => e.userId === host.userId)?.status).toBe("CONFIRMED");
    expect(events.filter((e) => e.status === "TENTATIVE")).toHaveLength(2);
    expect(await db.meetingInvitation.count({ where: { meetingId: res.meeting.id, status: "PENDING" } })).toBe(2);
    const n = await db.notification.findFirstOrThrow({ where: { userId: rahul.userId } });
    expect(n.link).toBe(`/meetings/${res.meeting.joinCode}`);
    expect(await db.notification.count({ where: { userId: host.userId } })).toBe(0);
  });

  it("rejects people outside the workspace and invalid times", async () => {
    const { host } = await setup();
    const other = await createOrg("Other");
    const outsider = await createUser(other.id, "Olly Outsider");
    await expect(scheduleMeeting(host, sched(1, 15, 30, [outsider.id]))).rejects.toMatchObject({
      code: "VALIDATION",
      details: { unknownUserIds: [outsider.id] },
    });
    await expect(scheduleMeeting(host, sched(-1, 15, 30, []))).rejects.toThrow(/in the past/);
    await expect(scheduleMeeting(host, sched(1, 15, 2, []))).rejects.toThrow(/at least 5 minutes/);
    await expect(scheduleMeeting(host, { ...sched(1, 15, 30, []), startTime: "tomorrow 3pm" })).rejects.toThrow(/ISO 8601/);
  });

  it("blocks conflicts unless explicitly allowed; back-to-back is fine", async () => {
    const { host, rahul } = await setup();
    await scheduleMeeting(rahul, sched(2, 10, 60, []));
    const err = await scheduleMeeting(host, sched(2, 10, 30, [rahul.userId])).catch((e) => e);
    expect(err.code).toBe("CONFLICT");
    expect(err.details.conflicts[0]).toMatchObject({ displayName: "Rahul Sharma" });
    // Rahul's meeting is private to him: the host only sees that he is busy.
    expect(err.details.conflicts[0].busy[0].title).toBeNull();

    await expect(scheduleMeeting(host, sched(2, 11, 30, [rahul.userId]))).resolves.toBeTruthy(); // starts when the other ends
    const forced = await scheduleMeeting(host, sched(2, 10, 30, [rahul.userId], { allowConflicts: true }));
    expect(forced.conflicts).toHaveLength(1);
  });

  it("guests cannot schedule", async () => {
    const { mk } = await setup();
    const guest = await mk("Gus Guest", "GUEST");
    await expect(scheduleMeeting(guest, sched(1, 15, 30, []))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("reschedule & cancel", () => {
  it("only moderators reschedule; calendar moves; own old slot is not a conflict", async () => {
    const { host, rahul } = await setup();
    const { meeting } = await scheduleMeeting(host, sched(3, 9, 60, [rahul.userId]));
    await expect(rescheduleMeeting(rahul, meeting.joinCode, { startTime: at(3, 9, 30).toISOString(), endTime: at(3, 10, 30).toISOString() })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const res = await rescheduleMeeting(host, meeting.joinCode, { startTime: at(3, 9, 30).toISOString(), endTime: at(3, 10, 30).toISOString() });
    expect(res.conflicts).toHaveLength(0);
    const ev = await db.calendarEvent.findFirstOrThrow({ where: { meetingId: meeting.id, userId: rahul.userId } });
    expect(ev.startsAt).toEqual(at(3, 9, 30));
    expect(await db.notification.count({ where: { userId: rahul.userId, type: "meeting.rescheduled" } })).toBe(1);
  });

  it("host-only cancel frees everyone's calendar and revokes invitations", async () => {
    const { host, rahul } = await setup();
    const { meeting } = await scheduleMeeting(host, sched(4, 9, 60, [rahul.userId]));
    await expect(cancelMeeting(rahul, meeting.joinCode)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await cancelMeeting(host, meeting.joinCode);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).status).toBe("CANCELED");
    expect(await db.meetingInvitation.count({ where: { meetingId: meeting.id, status: "PENDING" } })).toBe(0);
    const avail = await getAvailability(host, [rahul.userId], at(4, 0), at(5, 0));
    expect(avail.users[0].busy).toHaveLength(0);
    await expect(cancelMeeting(host, meeting.joinCode)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a live meeting can't be cancelled or rescheduled", async () => {
    const { host } = await setup();
    const { meeting } = await scheduleMeeting(host, sched(1, 9, 60, []));
    await db.meeting.update({ where: { id: meeting.id }, data: { status: "LIVE" } });
    await expect(cancelMeeting(host, meeting.joinCode)).rejects.toThrow(/end it instead/);
    await expect(rescheduleMeeting(host, meeting.joinCode, { startTime: at(2, 9).toISOString(), endTime: at(2, 10).toISOString() })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("RSVP", () => {
  it("accept confirms the calendar entry; decline frees it; host is told", async () => {
    const { host, rahul, priya } = await setup();
    const { meeting } = await scheduleMeeting(host, sched(1, 12, 30, [rahul.userId, priya.userId]));
    await respondToInvitation(rahul, meeting.joinCode, "accept");
    await respondToInvitation(priya, meeting.joinCode, "decline");
    const events = await db.calendarEvent.findMany({ where: { meetingId: meeting.id } });
    expect(events.find((e) => e.userId === rahul.userId)).toMatchObject({ status: "CONFIRMED", isBusy: true });
    expect(events.find((e) => e.userId === priya.userId)).toMatchObject({ status: "CANCELED", isBusy: false });
    expect(await db.notification.count({ where: { userId: host.userId } })).toBe(2);
    await expect(respondToInvitation(host, meeting.joinCode, "accept")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("availability & free slots", () => {
  const MON = new Date("2030-01-07T00:00:00Z"); // a Monday

  it("finds slots inside everyone's local working hours and around busy time", async () => {
    const { host, rahul, priya } = await setup();
    // Hana: UTC 09–18, Rahul: Kolkata 09–18 = UTC 03:30–12:30, Priya: New York 09–18 = UTC 14–23.
    // Hana+Rahul overlap 09:00–12:30 UTC. Block 09:00–10:00 for Rahul.
    await db.calendarEvent.create({ data: { userId: rahul.userId, title: "Dentist", startsAt: new Date("2030-01-07T09:00:00Z"), endsAt: new Date("2030-01-07T10:00:00Z") } });
    const { slots } = await findFreeSlots(host, { userIds: [rahul.userId], rangeStart: MON, rangeEnd: new Date(MON.getTime() + DAY), durationMinutes: 60 });
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2030-01-07T10:00:00.000Z",
      "2030-01-07T10:30:00.000Z",
      "2030-01-07T11:00:00.000Z",
      "2030-01-07T11:30:00.000Z",
    ]);
    // Rahul (Kolkata) and Priya (New York) never share working hours.
    const none = await findFreeSlots(host, { userIds: [rahul.userId, priya.userId], rangeStart: MON, rangeEnd: new Date(MON.getTime() + 5 * DAY), durationMinutes: 30 });
    expect(none.slots).toHaveLength(0);
    expect(none.note).toMatch(/External calendars are not connected/);
  });

  it("skips weekends", async () => {
    const { host } = await setup();
    const sat = new Date("2030-01-12T00:00:00Z");
    const { slots } = await findFreeSlots(host, { userIds: [], rangeStart: sat, rangeEnd: new Date(sat.getTime() + 2 * DAY), durationMinutes: 30 });
    expect(slots).toHaveLength(0);
  });
});
