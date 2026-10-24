import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createInstantMeeting, getAccessibleMeeting, joinMeeting, removeParticipant } from "@/server/services/meetings";
import { scheduleMeeting } from "@/server/services/scheduling";
import {
  acceptExternalInvitation,
  acceptExternalInvitationAsNewUser,
  inviteByEmail,
  inviteUsers,
  listMyWorkspaces,
  previewExternalInvitation,
  switchWorkspace,
} from "@/server/services/invitations";
import { searchDirectory } from "@/server/services/directory";
import { listNotifications, markNotificationsRead } from "@/server/services/notifications";
import { resolveSession } from "@/server/auth/session";
import { requireMember } from "@/server/auth/permissions";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, loginAs, resetDb } from "../helpers";
import type { OrgRole } from "@/generated/prisma/enums";

beforeEach(async () => {
  await resetDb();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
});
afterAll(() => setCallingProviderForTests("LIVEKIT", null));

async function setup() {
  const org = await createOrg();
  const mk = async (name: string, role: OrgRole = "MEMBER", email?: string) => {
    const u = await createUser(org.id, name, { role, email });
    return { userId: u.id, organizationId: org.id, orgRole: role, user: { displayName: name, timezone: "UTC", email: u.email } };
  };
  const host = await mk("Hana Host");
  const rahul = await mk("Rahul Sharma");
  const amit = await mk("Amit Kumar");
  const meeting = await createInstantMeeting(host, { title: "Sync" });
  return { org, mk, host, rahul, amit, meeting };
}

const tokenFrom = (link: string) => link.split("/invite/")[1];

describe("inviting workspace members", () => {
  it("adds a participant, notifies them with a join-now link for live meetings", async () => {
    const { host, rahul, meeting } = await setup();
    await joinMeeting(host, meeting.joinCode, { publicUrl: "wss://x" });
    const { results } = await inviteUsers(host, meeting.joinCode, [rahul.userId]);
    expect(results[0]).toMatchObject({ displayName: "Rahul Sharma", status: "invited", emailStatus: "not_configured" });
    const n = await db.notification.findFirstOrThrow({ where: { userId: rahul.userId } });
    expect(n.link).toBe(`/m/${meeting.joinCode}`);
    expect(n.title).toMatch(/join .* now/);
    await expect(getAccessibleMeeting(rahul, meeting.joinCode)).resolves.toBeTruthy();
  });

  it("is idempotent and lets a moderator re-invite someone they removed", async () => {
    const { host, rahul, meeting } = await setup();
    await inviteUsers(host, meeting.joinCode, [rahul.userId]);
    expect((await inviteUsers(host, meeting.joinCode, [rahul.userId])).results[0].status).toBe("already_invited");
    await removeParticipant(host, meeting.joinCode, rahul.userId);
    await expect(joinMeeting(rahul, meeting.joinCode, { publicUrl: "wss://x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await inviteUsers(host, meeting.joinCode, [rahul.userId])).results[0].status).toBe("reinvited");
    await expect(joinMeeting(rahul, meeting.joinCode, { publicUrl: "wss://x" })).resolves.toBeTruthy();
  });

  it("attendees can't invite; non-members are rejected", async () => {
    const { host, rahul, amit, meeting } = await setup();
    await inviteUsers(host, meeting.joinCode, [rahul.userId]);
    await expect(inviteUsers(rahul, meeting.joinCode, [amit.userId])).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await createOrg("Other");
    const outsider = await createUser(other.id, "Olly Outsider");
    await expect(inviteUsers(host, meeting.joinCode, [outsider.id])).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("adds a calendar entry when inviting to a scheduled meeting", async () => {
    const { host, amit } = await setup();
    const start = new Date(Date.now() + 86400_000);
    const { meeting } = await scheduleMeeting(host, { title: "Plan", startTime: start.toISOString(), endTime: new Date(start.getTime() + 1800_000).toISOString(), participantIds: [] });
    await inviteUsers(host, meeting.joinCode, [amit.userId]);
    expect(await db.calendarEvent.findFirst({ where: { meetingId: meeting.id, userId: amit.userId, status: "TENTATIVE" } })).toBeTruthy();
  });
});

describe("email invitations", () => {
  it("a registered member's email is treated as a normal invite", async () => {
    const { host, rahul, meeting } = await setup();
    const res = await inviteByEmail(host, meeting.joinCode, rahul.user.email.toUpperCase());
    expect(res.kind).toBe("member");
  });

  it("unknown emails are refused unless the workspace allows external invites", async () => {
    const { org, host, meeting } = await setup();
    await expect(inviteByEmail(host, meeting.joinCode, "vendor@outside.dev")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.organization.update({ where: { id: org.id }, data: { allowExternalInvites: true } });
    const res = await inviteByEmail(host, meeting.joinCode, "vendor@outside.dev");
    expect(res).toMatchObject({ kind: "external", email: "vendor@outside.dev", emailStatus: "not_configured" });
    if (res.kind !== "external") throw new Error();
    expect(res.inviteLink).toMatch(/^https:\/\/meet\.test\/invite\/[\w-]{43}$/);
    // Only the hash is stored.
    expect(await db.meetingInvitation.count({ where: { tokenHash: tokenFrom(res.inviteLink) } })).toBe(0);
  });

  it("guest sign-up via the link creates a restricted guest account", async () => {
    const { org, host, meeting, mk } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { allowExternalInvites: true } });
    const res = await inviteByEmail(host, meeting.joinCode, "vendor@outside.dev");
    if (res.kind !== "external") throw new Error();
    const token = tokenFrom(res.inviteLink);

    expect(await previewExternalInvitation(token)).toMatchObject({ email: "vendor@outside.dev", hasAccount: false, meeting: { title: "Sync", hostName: "Hana Host" } });
    const accepted = await acceptExternalInvitationAsNewUser(token, { displayName: "Vera Vendor", password: "guest-password-1" });
    expect(accepted.joinCode).toBe(meeting.joinCode);
    await expect(acceptExternalInvitationAsNewUser(token, { displayName: "Again", password: "guest-password-1" })).rejects.toMatchObject({ code: "CONFLICT" });

    const { ctx: guest } = await loginAs(accepted.userId, org.id);
    expect(guest.orgRole).toBe("GUEST");
    await expect(joinMeeting(guest, meeting.joinCode, { publicUrl: "wss://x" })).resolves.toMatchObject({ myRole: "ATTENDEE" });
    // Guests can't browse the directory or see other meetings, and members don't see guests in search.
    expect(() => requireMember(guest)).toThrow(/Guests/);
    const otherMeeting = await createInstantMeeting(host, { title: "Internal only" });
    await expect(getAccessibleMeeting(guest, otherMeeting.joinCode)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const member = await mk("Mia Member");
    expect(await searchDirectory(member, "Vera")).toHaveLength(0);
  });

  it("an existing account must match the invited email; acceptance adds guest access to that workspace", async () => {
    const { org, host, meeting } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { allowExternalInvites: true } });
    const otherOrg = await createOrg("Partner Co");
    const partner = await createUser(otherOrg.id, "Pat Partner", { email: "pat@partner.dev" });
    const stranger = await createUser(otherOrg.id, "Sam Stranger", { email: "sam@partner.dev" });
    const res = await inviteByEmail(host, meeting.joinCode, "pat@partner.dev");
    if (res.kind !== "external") throw new Error();
    const token = tokenFrom(res.inviteLink);

    await expect(acceptExternalInvitation({ userId: stranger.id, user: { email: stranger.email } }, token)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { token: sess, ctx } = await loginAs(partner.id, otherOrg.id);
    const out = await acceptExternalInvitation(ctx, token);
    await switchWorkspace(ctx, out.organizationId);
    const switched = await resolveSession(sess);
    expect(switched).toMatchObject({ organizationId: org.id, orgRole: "GUEST" });
    expect((await listMyWorkspaces(ctx)).map((w) => w.name).sort()).toEqual(["Acme", "Partner Co"]);
    await expect(switchWorkspace(ctx, (await createOrg("Nope")).id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("expired and withdrawn links are refused", async () => {
    const { org, host, meeting } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { allowExternalInvites: true } });
    const first = await inviteByEmail(host, meeting.joinCode, "a@outside.dev");
    const second = await inviteByEmail(host, meeting.joinCode, "a@outside.dev"); // re-invite withdraws the old link
    if (first.kind !== "external" || second.kind !== "external") throw new Error();
    await expect(previewExternalInvitation(tokenFrom(first.inviteLink))).rejects.toThrow(/withdrawn/);
    await db.meetingInvitation.updateMany({ where: { inviteeEmail: "a@outside.dev", status: "PENDING" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(previewExternalInvitation(tokenFrom(second.inviteLink))).rejects.toThrow(/expired/);
    await expect(previewExternalInvitation("garbage")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("notifications", () => {
  it("users only see and mark their own notifications", async () => {
    const { host, rahul, amit, meeting } = await setup();
    await inviteUsers(host, meeting.joinCode, [rahul.userId, amit.userId]);
    const mine = await listNotifications(rahul);
    expect(mine.unread).toBe(1);
    await markNotificationsRead(rahul, [(await listNotifications(amit)).items[0].id]); // someone else's id: no effect
    expect((await listNotifications(amit)).unread).toBe(1);
    await markNotificationsRead(rahul);
    expect((await listNotifications(rahul)).unread).toBe(0);
  });
});
