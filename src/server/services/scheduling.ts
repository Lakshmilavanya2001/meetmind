import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { requireMember } from "../auth/permissions";
import { generateHumanCode } from "../auth/tokens";
import type { AuthContext } from "../auth/session";
import { findConflicts, type Conflict } from "./calendar";
import { getDirectoryUsers } from "./directory";
import { getAccessibleMeeting } from "./meetings";
import { notifyUsers } from "./notifications";
import { emailMeetingUpdate, type EmailStatus } from "./meeting-mail";
import { formatRangeInZone } from "@/lib/time";
import { timezoneSchema } from "@/lib/validation";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole"> & { user: { displayName: string; timezone: string } };

const isoInstant = z.iso.datetime({ offset: true, message: "Use an ISO 8601 date-time with a time zone offset" });

const timesSchema = z
  .object({ startTime: isoInstant, endTime: isoInstant, allowConflicts: z.boolean().default(false) })
  .transform((v) => ({ ...v, start: new Date(v.startTime), end: new Date(v.endTime) }))
  .superRefine((v, c) => {
    const mins = (v.end.getTime() - v.start.getTime()) / 60_000;
    if (mins < 5) c.addIssue({ code: "custom", path: ["endTime"], message: "Meetings must be at least 5 minutes long." });
    if (mins > 12 * 60) c.addIssue({ code: "custom", path: ["endTime"], message: "Meetings can be at most 12 hours long." });
    if (v.start.getTime() < Date.now() - 5 * 60_000) c.addIssue({ code: "custom", path: ["startTime"], message: "The start time is in the past." });
  });

export const scheduleMeetingSchema = z
  .object({
    title: z.string().trim().min(1, "Enter a title").max(120),
    description: z.string().trim().max(2000).optional(),
    timezone: timezoneSchema.optional(),
    participantIds: z.array(z.string().min(1)).max(50).default([]),
  })
  .and(timesSchema);

export const rescheduleSchema = timesSchema;

async function uniqueJoinCode() {
  for (let i = 0; i < 5; i++) {
    const code = generateHumanCode();
    if (!(await db.meeting.findUnique({ where: { joinCode: code }, select: { id: true } }))) return code;
  }
  throw new AppError("INTERNAL", "Could not allocate a meeting code.");
}

const serializeConflicts = (conflicts: Conflict[]) =>
  conflicts.map((c) => ({
    userId: c.userId,
    displayName: c.displayName,
    busy: c.busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString(), title: b.title })),
  }));

function conflictError(conflicts: Conflict[]) {
  const names = conflicts.map((c) => c.displayName).join(", ");
  return new AppError("CONFLICT", `Scheduling conflict: ${names} already ${conflicts.length === 1 ? "has" : "have"} something at that time.`, {
    conflicts: serializeConflicts(conflicts),
  });
}

export type ScheduleResult = {
  meeting: { id: string; title: string; joinCode: string; scheduledStart: Date; scheduledEnd: Date; timezone: string };
  invited: { userId: string; displayName: string; email: string; emailStatus: EmailStatus }[];
  conflicts: ReturnType<typeof serializeConflicts>;
};

/**
 * Schedule a meeting on the internal calendar and invite workspace members.
 * Conflicts block creation unless `allowConflicts` is set (the caller must have asked the user).
 */
export async function scheduleMeeting(ctx: Ctx, raw: unknown): Promise<ScheduleResult> {
  requireMember(ctx);
  const input = scheduleMeetingSchema.parse(raw);
  const timezone = input.timezone ?? ctx.user.timezone;

  const inviteeIds = [...new Set(input.participantIds)].filter((id) => id !== ctx.userId);
  const invitees = await getDirectoryUsers(ctx, inviteeIds);
  if (invitees.length !== inviteeIds.length) {
    const found = new Set(invitees.map((u) => u.id));
    throw new AppError("VALIDATION", "Some participants are not members of this workspace.", {
      unknownUserIds: inviteeIds.filter((id) => !found.has(id)),
    });
  }

  const conflicts = await findConflicts(ctx, [ctx.userId, ...inviteeIds], input.start, input.end);
  if (conflicts.length > 0 && !input.allowConflicts) throw conflictError(conflicts);

  const joinCode = await uniqueJoinCode();
  const meeting = await db.$transaction(async (tx) => {
    const m = await tx.meeting.create({
      data: {
        organizationId: ctx.organizationId,
        hostId: ctx.userId,
        title: input.title,
        description: input.description || null,
        joinCode,
        provider: "LIVEKIT",
        providerRoomId: `mm-${joinCode}`,
        scheduledStart: input.start,
        scheduledEnd: input.end,
        timezone,
        participants: {
          create: [
            { userId: ctx.userId, role: "HOST" as const },
            ...invitees.map((u) => ({ userId: u.id, role: "ATTENDEE" as const, invitedById: ctx.userId })),
          ],
        },
        invitations: {
          create: invitees.map((u) => ({ inviteeUserId: u.id, invitedById: ctx.userId, channel: "IN_APP" as const })),
        },
        calendarEvents: {
          create: [
            { userId: ctx.userId, title: input.title, startsAt: input.start, endsAt: input.end, status: "CONFIRMED" as const },
            ...invitees.map((u) => ({ userId: u.id, title: input.title, startsAt: input.start, endsAt: input.end, status: "TENTATIVE" as const })),
          ],
        },
      },
    });
    return m;
  });

  await notifyUsers(
    invitees.map((u) => u.id),
    {
      type: "meeting.invitation",
      title: `${ctx.user.displayName} invited you to “${meeting.title}”`,
      body: formatRangeInZone(input.start, input.end, timezone),
      link: `/meetings/${meeting.joinCode}`,
      data: { meetingId: meeting.id },
    },
  );
  const emailStatus = await emailMeetingUpdate(meeting, invitees.map((u) => ({ email: u.email, timezone: u.timezone })), {
    hostName: ctx.user.displayName,
    kind: "invite",
  });
  await audit({
    action: "meeting.schedule",
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    targetType: "Meeting",
    targetId: meeting.id,
    metadata: { invitees: inviteeIds, conflictsOverridden: conflicts.length > 0 },
  });

  return {
    meeting: { id: meeting.id, title: meeting.title, joinCode: meeting.joinCode, scheduledStart: input.start, scheduledEnd: input.end, timezone },
    invited: invitees.map((u) => ({ userId: u.id, displayName: u.displayName, email: u.email, emailStatus: emailStatus[u.email] })),
    conflicts: serializeConflicts(conflicts),
  };
}

async function activeParticipants(meetingId: string) {
  return db.meetingParticipant.findMany({
    where: { meetingId, removedAt: null },
    include: { user: { select: { id: true, email: true, timezone: true, displayName: true } } },
  });
}

export async function rescheduleMeeting(ctx: Ctx, ref: string, raw: unknown) {
  const input = rescheduleSchema.parse(raw);
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  if (myRole !== "HOST" && myRole !== "COHOST") throw new AppError("FORBIDDEN", "Only the host or a co-host can reschedule this meeting.");
  if (meeting.status !== "SCHEDULED") throw new AppError("CONFLICT", `A ${meeting.status.toLowerCase()} meeting can't be rescheduled.`);

  const participants = await activeParticipants(meeting.id);
  const conflicts = await findConflicts(ctx, participants.map((p) => p.userId), input.start, input.end, meeting.id);
  if (conflicts.length > 0 && !input.allowConflicts) throw conflictError(conflicts);

  const updated = await db.$transaction(async (tx) => {
    const m = await tx.meeting.update({ where: { id: meeting.id }, data: { scheduledStart: input.start, scheduledEnd: input.end } });
    await tx.calendarEvent.updateMany({ where: { meetingId: meeting.id }, data: { startsAt: input.start, endsAt: input.end } });
    return m;
  });

  const others = participants.filter((p) => p.userId !== ctx.userId);
  await notifyUsers(others.map((p) => p.userId), {
    type: "meeting.rescheduled",
    title: `“${meeting.title}” was moved`,
    body: formatRangeInZone(input.start, input.end, meeting.timezone),
    link: `/meetings/${meeting.joinCode}`,
    data: { meetingId: meeting.id },
  });
  const emailStatus = await emailMeetingUpdate(updated, others.map((p) => ({ email: p.user.email, timezone: p.user.timezone })), {
    hostName: ctx.user.displayName,
    kind: "reschedule",
  });
  await audit({
    action: "meeting.reschedule",
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    targetType: "Meeting",
    targetId: meeting.id,
    metadata: { from: meeting.scheduledStart?.toISOString() ?? null, to: input.start.toISOString() },
  });
  return {
    meeting: { id: updated.id, title: updated.title, joinCode: updated.joinCode, scheduledStart: input.start, scheduledEnd: input.end },
    notified: others.map((p) => ({ userId: p.userId, displayName: p.user.displayName, emailStatus: emailStatus[p.user.email] })),
    conflicts: serializeConflicts(conflicts),
  };
}

export async function cancelMeeting(ctx: Ctx, ref: string) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  if (myRole !== "HOST") throw new AppError("FORBIDDEN", "Only the host can cancel this meeting.");
  if (meeting.status !== "SCHEDULED") {
    throw new AppError("CONFLICT", meeting.status === "LIVE" ? "This meeting is in progress — end it instead of cancelling." : `This meeting is already ${meeting.status.toLowerCase()}.`);
  }
  const participants = await activeParticipants(meeting.id);
  const updated = await db.$transaction(async (tx) => {
    const m = await tx.meeting.update({ where: { id: meeting.id }, data: { status: "CANCELED" } });
    await tx.calendarEvent.updateMany({ where: { meetingId: meeting.id }, data: { status: "CANCELED", isBusy: false } });
    await tx.meetingInvitation.updateMany({ where: { meetingId: meeting.id, status: "PENDING" }, data: { status: "REVOKED" } });
    return m;
  });
  const others = participants.filter((p) => p.userId !== ctx.userId);
  await notifyUsers(others.map((p) => p.userId), {
    type: "meeting.canceled",
    title: `“${meeting.title}” was cancelled`,
    body: `${ctx.user.displayName} cancelled this meeting.`,
    link: `/meetings/${meeting.joinCode}`,
    data: { meetingId: meeting.id },
  });
  const emailStatus = await emailMeetingUpdate(updated, others.map((p) => ({ email: p.user.email, timezone: p.user.timezone })), {
    hostName: ctx.user.displayName,
    kind: "cancel",
  });
  await audit({ action: "meeting.cancel", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id });
  return {
    meeting: { id: meeting.id, title: meeting.title, joinCode: meeting.joinCode, status: "CANCELED" as const },
    notified: others.map((p) => ({ userId: p.userId, displayName: p.user.displayName, emailStatus: emailStatus[p.user.email] })),
  };
}
