import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { hashPassword } from "../auth/password";
import { generateToken, hashToken } from "../auth/tokens";
import type { AuthContext } from "../auth/session";
import { getDirectoryUsers } from "./directory";
import { getAccessibleMeeting } from "./meetings";
import { notifyUsers } from "./notifications";
import { ringUsers } from "./calls";
import { emailMeetingUpdate, type EmailStatus } from "./meeting-mail";
import { appUrl } from "../email-templates";
import { displayNameSchema, emailSchema, passwordSchema } from "@/lib/validation";
import { formatRangeInZone } from "@/lib/time";
import { Prisma } from "@/generated/prisma/client";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole"> & { user: { displayName: string; timezone: string; email?: string } };

export type InviteOutcome = {
  userId: string;
  displayName: string;
  email: string;
  status: "invited" | "already_invited" | "reinvited";
  emailStatus: EmailStatus | "skipped";
};

const EXTERNAL_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

async function loadModeratedMeeting(ctx: Ctx, ref: string) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  if (myRole !== "HOST" && myRole !== "COHOST") throw new AppError("FORBIDDEN", "Only the host or a co-host can invite people to this meeting.");
  if (meeting.status === "CANCELED" || meeting.status === "ENDED") {
    throw new AppError("CONFLICT", `You can't invite people to a ${meeting.status === "CANCELED" ? "cancelled" : "finished"} meeting.`);
  }
  return meeting;
}

/**
 * Invite workspace members (by user id) to a meeting. Returns what actually happened per person.
 * Being invited lets them join and puts it in their calendar; we notify them in-app (and by email when configured).
 * The calling provider cannot pull someone into a live room — they join from the notification/link.
 */
export async function inviteUsers(ctx: Ctx, ref: string, userIds: string[]): Promise<{ meeting: { id: string; title: string; joinCode: string; status: string }; results: InviteOutcome[] }> {
  const meeting = await loadModeratedMeeting(ctx, ref);
  const ids = [...new Set(userIds)].filter((id) => id !== meeting.hostId);
  if (ids.length === 0) throw new AppError("VALIDATION", "Choose at least one person to invite.");
  if (ids.length > 50) throw new AppError("VALIDATION", "You can invite at most 50 people at once.");

  // Guests already invited to this meeting stay invitable; otherwise only full members.
  const users = await getDirectoryUsers(ctx, ids, { includeGuests: true });
  const allowed = users.filter((u) => u.role !== "GUEST" || meeting.participants.some((p) => p.userId === u.id));
  if (allowed.length !== ids.length) {
    const found = new Set(allowed.map((u) => u.id));
    throw new AppError("VALIDATION", "Some people are not members of this workspace.", { unknownUserIds: ids.filter((id) => !found.has(id)) });
  }

  const existing = new Map(meeting.participants.map((p) => [p.userId, p]));
  const results: InviteOutcome[] = [];
  const toNotify: typeof allowed = [];

  for (const u of allowed) {
    const prior = existing.get(u.id);
    if (prior && !prior.removedAt) {
      results.push({ userId: u.id, displayName: u.displayName, email: u.email, status: "already_invited", emailStatus: "skipped" });
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.meetingParticipant.upsert({
        where: { meetingId_userId: { meetingId: meeting.id, userId: u.id } },
        // An explicit re-invite by a moderator lifts an earlier removal.
        update: { removedAt: null, role: "ATTENDEE", invitedById: ctx.userId },
        create: { meetingId: meeting.id, userId: u.id, role: "ATTENDEE", invitedById: ctx.userId },
      });
      await tx.meetingInvitation.create({ data: { meetingId: meeting.id, inviteeUserId: u.id, invitedById: ctx.userId, channel: "IN_APP" } });
      if (meeting.scheduledStart && meeting.scheduledEnd) {
        await tx.calendarEvent.upsert({
          where: { userId_meetingId: { userId: u.id, meetingId: meeting.id } },
          update: { status: "TENTATIVE", isBusy: true, startsAt: meeting.scheduledStart, endsAt: meeting.scheduledEnd },
          create: { userId: u.id, meetingId: meeting.id, title: meeting.title, startsAt: meeting.scheduledStart, endsAt: meeting.scheduledEnd, status: "TENTATIVE" },
        });
      }
    });
    toNotify.push(u);
    results.push({ userId: u.id, displayName: u.displayName, email: u.email, status: prior ? "reinvited" : "invited", emailStatus: "skipped" });
  }

  if (toNotify.length > 0) {
    const live = meeting.status === "LIVE";
    // People added to a call in progress get an incoming-call prompt, not just a notification.
    if (live) await ringUsers(meeting.id, ctx.userId, toNotify.map((u) => u.id));
    await notifyUsers(toNotify.map((u) => u.id), {
      type: "meeting.invitation",
      title: live ? `${ctx.user.displayName} is asking you to join “${meeting.title}” now` : `${ctx.user.displayName} invited you to “${meeting.title}”`,
      body: live ? "The meeting is in progress." : meeting.scheduledStart && meeting.scheduledEnd ? formatRangeInZone(meeting.scheduledStart, meeting.scheduledEnd, meeting.timezone) : undefined,
      link: live ? `/m/${meeting.joinCode}` : `/meetings/${meeting.joinCode}`,
      data: { meetingId: meeting.id },
    });
    const emailStatus = await emailMeetingUpdate(meeting, toNotify.map((u) => ({ email: u.email, timezone: u.timezone })), {
      hostName: ctx.user.displayName,
      kind: "invite",
    });
    for (const r of results) if (r.status !== "already_invited") r.emailStatus = emailStatus[r.email];
    await audit({
      action: "meeting.invite",
      actorUserId: ctx.userId,
      organizationId: ctx.organizationId,
      targetType: "Meeting",
      targetId: meeting.id,
      metadata: { userIds: toNotify.map((u) => u.id) },
    });
  }
  return { meeting: { id: meeting.id, title: meeting.title, joinCode: meeting.joinCode, status: meeting.status }, results };
}

/**
 * Invite someone by email. Registered members are invited normally. Unregistered people get a
 * guest invitation link — only if the workspace allows external invites. We never guess addresses.
 */
export async function inviteByEmail(ctx: Ctx, ref: string, rawEmail: unknown) {
  const email = emailSchema.parse(rawEmail);
  const meeting = await loadModeratedMeeting(ctx, ref);

  const existingUser = await db.user.findUnique({
    where: { email },
    select: { id: true, memberships: { where: { organizationId: ctx.organizationId }, select: { role: true } } },
  });
  if (existingUser?.memberships.length && existingUser.memberships[0].role !== "GUEST") {
    const { results } = await inviteUsers(ctx, ref, [existingUser.id]);
    return { kind: "member" as const, result: results[0] };
  }

  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { allowExternalInvites: true, name: true } });
  if (!org.allowExternalInvites) {
    throw new AppError("FORBIDDEN", "This person isn't in your workspace, and external invitations are turned off. A workspace admin can enable them in Workspace settings.");
  }

  const token = generateToken();
  await db.meetingInvitation.updateMany({ where: { meetingId: meeting.id, inviteeEmail: email, status: "PENDING" }, data: { status: "REVOKED" } });
  await db.meetingInvitation.create({
    data: {
      meetingId: meeting.id,
      invitedById: ctx.userId,
      inviteeEmail: email,
      channel: "EMAIL",
      tokenHash: hashToken(token),
      expiresAt: new Date(Math.max(Date.now() + EXTERNAL_INVITE_TTL_MS, (meeting.scheduledEnd?.getTime() ?? 0) + 24 * 3600_000)),
    },
  });
  const inviteLink = appUrl(`/invite/${token}`);
  const emailStatus = await emailMeetingUpdate(meeting, [{ email, timezone: meeting.timezone, link: inviteLink }], {
    hostName: ctx.user.displayName,
    kind: "invite",
  });
  await audit({ action: "meeting.invite_external", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { email } });
  // The link is returned so the host can share it another way if email isn't available.
  return { kind: "external" as const, email, inviteLink, emailStatus: emailStatus[email] };
}

export async function respondToInvitation(ctx: Ctx, ref: string, response: "accept" | "decline") {
  const { meeting } = await getAccessibleMeeting(ctx, ref);
  const invitation = await db.meetingInvitation.findFirst({
    where: { meetingId: meeting.id, inviteeUserId: ctx.userId, status: { in: ["PENDING", "ACCEPTED", "DECLINED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!invitation) throw new AppError("NOT_FOUND", "You don't have an invitation to this meeting.");
  if (meeting.status === "CANCELED") throw new AppError("CONFLICT", "This meeting was cancelled.");
  const accepted = response === "accept";
  await db.$transaction([
    db.meetingInvitation.update({ where: { id: invitation.id }, data: { status: accepted ? "ACCEPTED" : "DECLINED", respondedAt: new Date() } }),
    db.calendarEvent.updateMany({
      where: { meetingId: meeting.id, userId: ctx.userId },
      data: accepted ? { status: "CONFIRMED", isBusy: true } : { status: "CANCELED", isBusy: false },
    }),
  ]);
  await notifyUsers([meeting.hostId], {
    type: accepted ? "meeting.invitation_accepted" : "meeting.invitation_declined",
    title: `${ctx.user.displayName} ${accepted ? "accepted" : "declined"} “${meeting.title}”`,
    link: `/meetings/${meeting.joinCode}`,
    data: { meetingId: meeting.id },
  });
  await audit({ action: `meeting.invitation_${response}`, actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
  return { status: accepted ? ("ACCEPTED" as const) : ("DECLINED" as const) };
}

// ─── External (guest) invitation links ─────────────────────────────────

async function loadExternalInvitation(token: string) {
  const inv = await db.meetingInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { meeting: { include: { host: { select: { displayName: true } }, organization: { select: { id: true, name: true } } } } },
  });
  if (!inv || !inv.inviteeEmail) throw new AppError("NOT_FOUND", "This invitation link is not valid.");
  if (inv.status === "REVOKED") throw new AppError("FORBIDDEN", "This invitation was withdrawn.");
  if (inv.status === "ACCEPTED") throw new AppError("CONFLICT", "This invitation link has already been used. Sign in to open the meeting.");
  if (inv.expiresAt && inv.expiresAt < new Date()) throw new AppError("FORBIDDEN", "This invitation has expired. Ask the host to invite you again.");
  if (inv.meeting.status === "CANCELED") throw new AppError("CONFLICT", "This meeting was cancelled.");
  return inv;
}

/** Public preview of an invitation link (no session needed). Reveals only what the invitee needs. */
export async function previewExternalInvitation(token: string) {
  const inv = await loadExternalInvitation(token);
  const hasAccount = !!(await db.user.findUnique({ where: { email: inv.inviteeEmail! }, select: { id: true } }));
  return {
    email: inv.inviteeEmail!,
    hasAccount,
    meeting: {
      title: inv.meeting.title,
      hostName: inv.meeting.host.displayName,
      workspaceName: inv.meeting.organization.name,
      scheduledStart: inv.meeting.scheduledStart,
      scheduledEnd: inv.meeting.scheduledEnd,
      timezone: inv.meeting.timezone,
    },
  };
}

async function grantGuestAccess(tx: Prisma.TransactionClient, invId: string, meeting: { id: string; organizationId: string; title: string; scheduledStart: Date | null; scheduledEnd: Date | null; invitedById?: string | null }, userId: string) {
  const membership = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: meeting.organizationId, userId } } });
  if (!membership) await tx.organizationMember.create({ data: { organizationId: meeting.organizationId, userId, role: "GUEST" } });
  const existing = await tx.meetingParticipant.findUnique({ where: { meetingId_userId: { meetingId: meeting.id, userId } } });
  // An invitation link never undoes a host's removal — only a fresh invitation from a moderator can.
  if (existing?.removedAt) throw new AppError("FORBIDDEN", "The host removed you from this meeting.");
  if (!existing) await tx.meetingParticipant.create({ data: { meetingId: meeting.id, userId, role: "ATTENDEE", invitedById: meeting.invitedById ?? null } });
  if (meeting.scheduledStart && meeting.scheduledEnd) {
    await tx.calendarEvent.upsert({
      where: { userId_meetingId: { userId, meetingId: meeting.id } },
      update: { status: "CONFIRMED", isBusy: true },
      create: { userId, meetingId: meeting.id, title: meeting.title, startsAt: meeting.scheduledStart, endsAt: meeting.scheduledEnd, status: "CONFIRMED" },
    });
  }
  await tx.meetingInvitation.update({ where: { id: invId }, data: { status: "ACCEPTED", inviteeUserId: userId, respondedAt: new Date() } });
}

/** Accept with an existing account (signed in as the invited email). Returns the org to switch to. */
export async function acceptExternalInvitation(ctx: { userId: string; user: { email: string } }, token: string) {
  const inv = await loadExternalInvitation(token);
  if (ctx.user.email !== inv.inviteeEmail) {
    throw new AppError("FORBIDDEN", `This invitation was sent to ${inv.inviteeEmail}. Sign in with that email to accept it.`);
  }
  await db.$transaction((tx) => grantGuestAccess(tx, inv.id, { ...inv.meeting, invitedById: inv.invitedById }, ctx.userId));
  await audit({ action: "meeting.invitation_external_accept", actorUserId: ctx.userId, organizationId: inv.meeting.organizationId, targetType: "Meeting", targetId: inv.meetingId });
  return { organizationId: inv.meeting.organizationId, joinCode: inv.meeting.joinCode };
}

const guestSignupSchema = z.object({ displayName: displayNameSchema, password: passwordSchema });

/** Create a guest account for the invited email (the email itself is taken from the invitation, never from input). */
export async function acceptExternalInvitationAsNewUser(token: string, raw: unknown) {
  const input = guestSignupSchema.parse(raw);
  const inv = await loadExternalInvitation(token);
  if (await db.user.findUnique({ where: { email: inv.inviteeEmail! }, select: { id: true } })) {
    throw new AppError("CONFLICT", "An account with this email already exists. Sign in to accept the invitation.");
  }
  const passwordHash = await hashPassword(input.password);
  const userId = await db.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email: inv.inviteeEmail!, displayName: input.displayName, passwordHash, timezone: inv.meeting.timezone } });
    await grantGuestAccess(tx, inv.id, { ...inv.meeting, invitedById: inv.invitedById }, user.id);
    return user.id;
  });
  await audit({ action: "auth.signup.guest", actorUserId: userId, organizationId: inv.meeting.organizationId, targetType: "Meeting", targetId: inv.meetingId });
  return { userId, organizationId: inv.meeting.organizationId, joinCode: inv.meeting.joinCode };
}

/** Pending invitations for the caller in the current workspace. */
export async function listMyPendingInvitations(ctx: { userId: string; organizationId: string }) {
  return db.meetingInvitation.findMany({
    where: { inviteeUserId: ctx.userId, status: "PENDING", meeting: { organizationId: ctx.organizationId, status: { in: ["SCHEDULED", "LIVE"] } } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      createdAt: true,
      invitedBy: { select: { displayName: true } },
      meeting: { select: { id: true, title: true, joinCode: true, status: true, scheduledStart: true, scheduledEnd: true } },
    },
  });
}

// ─── Workspace switching (users who belong to several workspaces, incl. as guests) ──

export async function listMyWorkspaces(ctx: { userId: string }) {
  const rows = await db.organizationMember.findMany({
    where: { userId: ctx.userId },
    include: { organization: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.organization.id, name: r.organization.name, role: r.role }));
}

export async function switchWorkspace(ctx: { userId: string; sessionId: string }, organizationId: string) {
  const member = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: ctx.userId } } });
  if (!member) throw new AppError("FORBIDDEN", "You are not a member of that workspace.");
  await db.session.update({ where: { id: ctx.sessionId }, data: { activeOrganizationId: organizationId } });
}

