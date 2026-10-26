import "server-only";
import { INTERPRETER_IDENTITY, INTERPRETER_NAME } from "../interpreter/constants";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { generateHumanCode } from "../auth/tokens";
import { getCallingProvider } from "../providers/calling";
import type { CallingEvent } from "../providers/calling/types";
import type { OrgRole, ParticipantRole } from "@/generated/prisma/enums";
import { requireMember } from "../auth/permissions";
import { finalizeTranscriptIfIdle } from "./transcript-lifecycle";
import { Prisma } from "@/generated/prisma/client";

type Ctx = { userId: string; organizationId: string; orgRole?: OrgRole; user?: { displayName: string } };

const JOIN_TOKEN_TTL_SEC = 10 * 60; // LiveKit refreshes tokens for connected clients automatically

const JOIN_CODE_RE = /^[a-km-z]{3}-[a-km-z]{4}-[a-km-z]{3}$/;

/** Accept a bare meeting code, a meeting id, or a full meeting link and return the code/id. */
export function parseMeetingRef(input: string): string {
  const s = input.trim();
  const fromLink = /\/m\/([a-z-]+)(?:[/?#]|$)/i.exec(s);
  return (fromLink ? fromLink[1] : s).toLowerCase();
}

/** Meetings in the caller's workspace that the caller hosted or was a participant in. */
export async function listMyMeetings(
  ctx: Ctx,
  opts: { scope: "upcoming" | "recent" | "canceled"; limit?: number; q?: string },
) {
  const now = new Date();
  const access: Prisma.MeetingWhereInput = {
    OR: [{ hostId: ctx.userId }, { participants: { some: { userId: ctx.userId, removedAt: null } } }],
  };
  const byScope: Prisma.MeetingWhereInput =
    opts.scope === "upcoming"
      ? { OR: [{ status: "LIVE" }, { status: "SCHEDULED", scheduledEnd: { gte: now } }] }
      : { status: opts.scope === "recent" ? "ENDED" : "CANCELED" };
  const where: Prisma.MeetingWhereInput = {
    organizationId: ctx.organizationId,
    AND: [access, byScope, ...(opts.q ? [{ title: { contains: opts.q, mode: "insensitive" as const } }] : [])],
  };
  return db.meeting.findMany({
    where,
    orderBy: opts.scope === "upcoming" ? [{ status: "asc" }, { scheduledStart: "asc" }] : opts.scope === "recent" ? { startedAt: "desc" } : { scheduledStart: "desc" },
    take: opts.limit ?? 10,
    select: {
      id: true,
      title: true,
      status: true,
      joinCode: true,
      scheduledStart: true,
      scheduledEnd: true,
      startedAt: true,
      endedAt: true,
      host: { select: { id: true, displayName: true } },
      _count: { select: { participants: { where: { removedAt: null } } } },
    },
  });
}

/** Full details for the meeting page: participants with RSVP status, pending external invites. */
export async function getMeetingDetails(ctx: Ctx, ref: string) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  const invitations = await db.meetingInvitation.findMany({
    where: { meetingId: meeting.id },
    orderBy: { createdAt: "desc" },
    select: { inviteeUserId: true, inviteeEmail: true, status: true, channel: true, createdAt: true },
  });
  const latestByUser = new Map<string, (typeof invitations)[number]>();
  for (const inv of invitations) if (inv.inviteeUserId && !latestByUser.has(inv.inviteeUserId)) latestByUser.set(inv.inviteeUserId, inv);
  const isModerator = myRole === "HOST" || myRole === "COHOST";
  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      description: meeting.description,
      joinCode: meeting.joinCode,
      status: meeting.status,
      timezone: meeting.timezone,
      scheduledStart: meeting.scheduledStart,
      scheduledEnd: meeting.scheduledEnd,
      startedAt: meeting.startedAt,
      endedAt: meeting.endedAt,
      host: meeting.host,
      callType: meeting.callType,
      isDirectCall: meeting.isDirectCall,
    },
    myRole,
    myInvitationStatus: latestByUser.get(ctx.userId)?.status ?? null,
    participants: meeting.participants
      .filter((p) => !p.removedAt)
      .map((p) => ({
        userId: p.userId,
        displayName: p.user.displayName,
        email: p.user.email,
        role: (p.userId === meeting.hostId ? "HOST" : p.role) as ParticipantRole,
        rsvp: p.userId === meeting.hostId ? ("ACCEPTED" as const) : (latestByUser.get(p.userId)?.status ?? null),
        attended: !!p.firstJoinedAt,
      })),
    // Only moderators see outstanding external (email) invitations.
    externalInvites: isModerator
      ? invitations.filter((i) => i.inviteeEmail && !i.inviteeUserId && i.status === "PENDING").map((i) => ({ email: i.inviteeEmail!, createdAt: i.createdAt }))
      : [],
  };
}

async function uniqueJoinCode() {
  for (let i = 0; i < 5; i++) {
    const code = generateHumanCode();
    if (!(await db.meeting.findUnique({ where: { joinCode: code }, select: { id: true } }))) return code;
  }
  throw new AppError("INTERNAL", "Could not allocate a meeting code.");
}

/** Start an ad-hoc meeting hosted by the caller. */
export async function createInstantMeeting(ctx: Ctx, input: { title?: string } = {}) {
  if (ctx.orgRole) requireMember({ orgRole: ctx.orgRole });
  const title = input.title?.trim().slice(0, 120) || `${ctx.user?.displayName ?? "Instant"}'s meeting`;
  const joinCode = await uniqueJoinCode();
  const meeting = await db.meeting.create({
    data: {
      organizationId: ctx.organizationId,
      hostId: ctx.userId,
      title,
      joinCode,
      provider: "LIVEKIT",
      providerRoomId: `mm-${joinCode}`,
      participants: { create: { userId: ctx.userId, role: "HOST" } },
    },
    select: { id: true, joinCode: true, title: true },
  });
  await audit({ action: "meeting.create_instant", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
  return meeting;
}

/**
 * Load a meeting the caller may access, by id or join code.
 * Meetings in other workspaces are reported as NOT_FOUND so their existence isn't revealed.
 * Workspace members may join via link (like an internal meeting link); people removed by the host may not.
 */
export async function getAccessibleMeeting(ctx: Ctx, ref: string) {
  const key = parseMeetingRef(ref);
  const meeting = await db.meeting.findFirst({
    where: { organizationId: ctx.organizationId, ...(JOIN_CODE_RE.test(key) ? { joinCode: key } : { id: key }) },
    include: {
      host: { select: { id: true, displayName: true, email: true } },
      participants: { include: { user: { select: { id: true, displayName: true, email: true } } } },
    },
  });
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found. Check the link or meeting code.");
  const me = meeting.participants.find((p) => p.userId === ctx.userId);
  // Guests only see meetings they were explicitly invited to.
  if (ctx.orgRole === "GUEST" && !me) throw new AppError("NOT_FOUND", "Meeting not found. Check the link or meeting code.");
  if (me?.removedAt) throw new AppError("FORBIDDEN", "The host removed you from this meeting.");
  const myRole: ParticipantRole = meeting.hostId === ctx.userId ? "HOST" : (me?.role ?? "ATTENDEE");
  return { meeting, myRole };
}

const canModerate = (role: ParticipantRole) => role === "HOST" || role === "COHOST";

function requireModerator(role: ParticipantRole) {
  if (!canModerate(role)) throw new AppError("FORBIDDEN", "Only the host or a co-host can do that.");
}

export async function joinMeeting(ctx: Ctx & { user: { displayName: string } }, ref: string, opts: { publicUrl: string }) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  if (meeting.status === "CANCELED") throw new AppError("CONFLICT", "This meeting was cancelled.");
  // A finished meeting can only be reopened by people who were part of it — otherwise anyone holding
  // an old link could join afterwards and gain access to its transcript and summary.
  if (meeting.status === "ENDED" && meeting.hostId !== ctx.userId && !meeting.participants.some((p) => p.userId === ctx.userId)) {
    throw new AppError("FORBIDDEN", "This meeting has ended.");
  }
  if (meeting.provider !== "LIVEKIT" || !meeting.providerRoomId) {
    throw new AppError("NOT_CONFIGURED", "This meeting is hosted on an external provider and can't be joined here.");
  }

  const provider = getCallingProvider(meeting.provider);
  // Provider first: if the calling service is down we fail without changing any state.
  const room = await provider.ensureRoom(meeting.providerRoomId, { emptyTimeoutSec: 300 });
  const credentials = await provider.issueJoinCredentials(
    {
      roomId: meeting.providerRoomId,
      identity: ctx.userId,
      name: ctx.user.displayName,
      metadata: { role: myRole },
      canPublish: true,
      canPublishScreen: true,
      ttlSeconds: JOIN_TOKEN_TTL_SEC,
    },
    { publicUrl: opts.publicUrl },
  );

  const now = new Date();
  await db.$transaction([
    db.meetingParticipant.upsert({
      where: { meetingId_userId: { meetingId: meeting.id, userId: ctx.userId } },
      update: { providerIdentity: ctx.userId },
      create: { meetingId: meeting.id, userId: ctx.userId, role: myRole, providerIdentity: ctx.userId },
    }),
    db.meeting.update({
      where: { id: meeting.id },
      data: { status: "LIVE", startedAt: meeting.startedAt ?? now, endedAt: null },
    }),
  ]);
  await audit({ action: "meeting.join", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });

  return {
    meeting: { id: meeting.id, title: meeting.title, joinCode: meeting.joinCode, hostId: meeting.hostId },
    myRole,
    sessionStartedAt: (room.createdAt ?? now).toISOString(),
    ...credentials,
  };
}

/** Live participants (from the provider) annotated with their meeting roles (from our DB). */
export async function listLiveParticipants(ctx: Ctx, ref: string) {
  const { meeting } = await getAccessibleMeeting(ctx, ref);
  if (!meeting.providerRoomId) return [];
  const live = await getCallingProvider(meeting.provider).listParticipants(meeting.providerRoomId);
  const byUser = new Map(meeting.participants.map((p) => [p.userId, p]));
  return live.map((p) => {
    if (p.identity === INTERPRETER_IDENTITY) {
      return { userId: p.identity, displayName: INTERPRETER_NAME, email: null, role: "ATTENDEE" as ParticipantRole, joinedAt: p.joinedAt, micOn: p.isPublishingAudio, cameraOn: false, screenSharing: false, isAgent: true };
    }
    const row = byUser.get(p.identity);
    return {
      userId: p.identity,
      displayName: row?.user.displayName ?? p.name,
      email: row?.user.email ?? null,
      role: (meeting.hostId === p.identity ? "HOST" : (row?.role ?? "ATTENDEE")) as ParticipantRole,
      joinedAt: p.joinedAt,
      micOn: p.isPublishingAudio,
      cameraOn: p.isPublishingVideo,
      screenSharing: p.isScreenSharing,
    };
  });
}

async function targetParticipant(meetingId: string, hostId: string, userId: string) {
  const target = await db.meetingParticipant.findUnique({ where: { meetingId_userId: { meetingId, userId } } });
  if (!target) throw new AppError("NOT_FOUND", "That person is not a participant in this meeting.");
  return { target, isHost: hostId === userId };
}

export async function removeParticipant(ctx: Ctx, ref: string, userId: string) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  requireModerator(myRole);
  if (userId === ctx.userId) throw new AppError("VALIDATION", "Use Leave to leave the meeting yourself.");
  const { target, isHost } = await targetParticipant(meeting.id, meeting.hostId, userId);
  if (isHost) throw new AppError("FORBIDDEN", "The host can't be removed from their own meeting.");
  if (target.role === "COHOST" && myRole !== "HOST") throw new AppError("FORBIDDEN", "Only the host can remove a co-host.");

  // Mark removed first so the person cannot rejoin even if the provider call fails mid-way;
  // also withdraw any outstanding invitation (including emailed links) for this person.
  await db.$transaction([
    db.meetingParticipant.update({ where: { id: target.id }, data: { removedAt: new Date(), leftAt: new Date() } }),
    db.meetingInvitation.updateMany({ where: { meetingId: meeting.id, inviteeUserId: userId, status: { in: ["PENDING", "ACCEPTED"] } }, data: { status: "REVOKED" } }),
  ]);
  if (meeting.providerRoomId) await getCallingProvider(meeting.provider).removeParticipant(meeting.providerRoomId, userId);
  await audit({ action: "meeting.participant_remove", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { userId } });
}

export async function muteParticipant(ctx: Ctx, ref: string, userId: string) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  requireModerator(myRole);
  const { isHost } = await targetParticipant(meeting.id, meeting.hostId, userId);
  if (isHost && myRole !== "HOST") throw new AppError("FORBIDDEN", "Co-hosts can't mute the host.");
  if (!meeting.providerRoomId) return { muted: false };
  const muted = await getCallingProvider(meeting.provider).muteParticipantAudio(meeting.providerRoomId, userId);
  if (muted) await audit({ action: "meeting.participant_mute", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { userId } });
  return { muted };
}

export async function setParticipantRole(ctx: Ctx, ref: string, userId: string, role: "COHOST" | "ATTENDEE") {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  if (myRole !== "HOST") throw new AppError("FORBIDDEN", "Only the host can change participant roles.");
  const { target, isHost } = await targetParticipant(meeting.id, meeting.hostId, userId);
  if (isHost) throw new AppError("VALIDATION", "The host's role can't be changed.");
  await db.meetingParticipant.update({ where: { id: target.id }, data: { role } });
  await audit({ action: "meeting.participant_role", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { userId, role } });
}

export async function endMeeting(ctx: Ctx, ref: string) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  requireModerator(myRole);
  if (meeting.providerRoomId) await getCallingProvider(meeting.provider).endRoom(meeting.providerRoomId);
  const now = new Date();
  await db.$transaction([
    db.meeting.update({ where: { id: meeting.id }, data: { status: "ENDED", endedAt: now } }),
    db.meetingParticipant.updateMany({ where: { meetingId: meeting.id, leftAt: null }, data: { leftAt: now } }),
    db.callRing.updateMany({ where: { meetingId: meeting.id, status: "RINGING" }, data: { status: "CANCELED" } }),
  ]);
  await audit({ action: "meeting.end", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
  await finalizeTranscriptIfIdle(meeting.id);
}

/** Apply a verified provider webhook event to our records. Unknown rooms are ignored. */
export async function handleCallingEvent(provider: "LIVEKIT" | "MICROSOFT_TEAMS", event: CallingEvent) {
  const meeting = await db.meeting.findUnique({
    where: { provider_providerRoomId: { provider, providerRoomId: event.roomId } },
    select: { id: true, status: true },
  });
  if (!meeting) return;

  switch (event.type) {
    case "participant_joined": {
      // Tokens live for minutes; a removed person (or anyone, once the meeting ended) is kicked on arrival.
      // The server agent (interpreter) may stay only while interpretation or live transcription is on in a live meeting.
      if (event.identity === INTERPRETER_IDENTITY) {
        const m = await db.meeting.findUnique({ where: { id: meeting.id }, select: { interpretationEnabled: true, transcriptionEnabled: true } });
        if (meeting.status !== "LIVE" || !(m?.interpretationEnabled || m?.transcriptionEnabled)) await getCallingProvider(provider).removeParticipant(event.roomId, event.identity).catch(() => {});
        break;
      }
      const row = await db.meetingParticipant.findUnique({ where: { meetingId_userId: { meetingId: meeting.id, userId: event.identity } } });
      if (!row || row.removedAt || meeting.status !== "LIVE") {
        await getCallingProvider(provider).removeParticipant(event.roomId, event.identity).catch(() => {});
        await audit({ action: "meeting.kick_unauthorized", targetType: "Meeting", targetId: meeting.id, metadata: { identity: event.identity, reason: !row ? "not_a_participant" : row.removedAt ? "removed" : `meeting_${meeting.status.toLowerCase()}` } });
        break;
      }
      await db.meetingParticipant
        .update({
          where: { meetingId_userId: { meetingId: meeting.id, userId: event.identity } },
          data: { lastJoinedAt: event.at, leftAt: null, firstJoinedAt: undefined },
        })
        .catch(ignoreMissing);
      await db.meetingParticipant.updateMany({
        where: { meetingId: meeting.id, userId: event.identity, firstJoinedAt: null },
        data: { firstJoinedAt: event.at },
      });
      break;
    }
    case "participant_left":
      await db.meetingParticipant
        .update({ where: { meetingId_userId: { meetingId: meeting.id, userId: event.identity } }, data: { leftAt: event.at } })
        .catch(ignoreMissing);
      break;
    case "room_started":
      // Status is owned by joinMeeting (which checks access); a stale token re-creating the room must not reopen it.
      break;
    case "room_finished":
      if (meeting.status === "LIVE") {
        await db.$transaction([
          db.meeting.update({ where: { id: meeting.id }, data: { status: "ENDED", endedAt: event.at } }),
          db.meetingParticipant.updateMany({ where: { meetingId: meeting.id, leftAt: null }, data: { leftAt: event.at } }),
        ]);
        await finalizeTranscriptIfIdle(meeting.id);
      }
      break;
  }
}

function ignoreMissing(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return;
  throw err;
}

/**
 * A ready-made call record for the transcription demo: an ended "call" the user hosts, to which
 * the bundled sample recording (two synthetic voices) is uploaded and transcribed with speakers.
 */
export async function createSampleCall(ctx: Ctx) {
  const m = await createInstantMeeting(ctx, { title: "Sample call: 5G business plan upgrade" });
  const endedAt = new Date();
  await db.meeting.update({ where: { id: m.id }, data: { status: "ENDED", startedAt: new Date(endedAt.getTime() - 90_000), endedAt, description: "Sample customer call (synthetic voices) for the transcription and summary demo." } });
  return m;
}
