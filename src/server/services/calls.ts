import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { requireMember } from "../auth/permissions";
import type { AuthContext } from "../auth/session";
import { generateHumanCode } from "../auth/tokens";
import { getDirectoryUsers } from "./directory";
import { getAccessibleMeeting } from "./meetings";
import { notifyUsers } from "./notifications";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole"> & { user: { displayName: string } };

export const RING_TIMEOUT_MS = 45_000;

export const startCallSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1, "Choose someone to call").max(20),
  type: z.enum(["VOICE", "VIDEO"]).default("VOICE"),
});

/** Ring people for an existing (live) meeting. Skips anyone already ringing for it. */
export async function ringUsers(meetingId: string, callerId: string, calleeIds: string[]) {
  const ids = [...new Set(calleeIds)].filter((id) => id !== callerId);
  if (!ids.length) return [];
  const already = await db.callRing.findMany({
    where: { meetingId, calleeId: { in: ids }, status: "RINGING", expiresAt: { gt: new Date() } },
    select: { calleeId: true },
  });
  const skip = new Set(already.map((r) => r.calleeId));
  const expiresAt = new Date(Date.now() + RING_TIMEOUT_MS);
  const fresh = ids.filter((id) => !skip.has(id));
  if (fresh.length) await db.callRing.createMany({ data: fresh.map((calleeId) => ({ meetingId, callerId, calleeId, expiresAt })) });
  return fresh;
}

/** Call one or more workspace members: creates a live call (voice or video) and rings them. */
export async function startCall(ctx: Ctx, raw: unknown) {
  requireMember(ctx);
  const input = startCallSchema.parse(raw);
  const ids = [...new Set(input.userIds)].filter((id) => id !== ctx.userId);
  if (!ids.length) throw new AppError("VALIDATION", "You can't call yourself.");
  const people = await getDirectoryUsers(ctx, ids);
  if (people.length !== ids.length) throw new AppError("VALIDATION", "Some people are not members of this workspace.");

  const title = people.length === 1 ? `${input.type === "VOICE" ? "Voice" : "Video"} call: ${ctx.user.displayName} & ${people[0].displayName}` : `${ctx.user.displayName}'s group call`;
  let joinCode = "";
  for (let i = 0; i < 5 && !joinCode; i++) {
    const c = generateHumanCode();
    if (!(await db.meeting.findUnique({ where: { joinCode: c }, select: { id: true } }))) joinCode = c;
  }
  if (!joinCode) throw new AppError("INTERNAL", "Could not allocate a call code.");

  const meeting = await db.meeting.create({
    data: {
      organizationId: ctx.organizationId,
      hostId: ctx.userId,
      title,
      joinCode,
      provider: "LIVEKIT",
      providerRoomId: `mm-${joinCode}`,
      callType: input.type,
      isDirectCall: true,
      participants: {
        create: [{ userId: ctx.userId, role: "HOST" as const }, ...people.map((p) => ({ userId: p.id, role: "ATTENDEE" as const, invitedById: ctx.userId }))],
      },
      invitations: { create: people.map((p) => ({ inviteeUserId: p.id, invitedById: ctx.userId, channel: "IN_APP" as const })) },
    },
    select: { id: true, joinCode: true, title: true, callType: true },
  });
  await ringUsers(meeting.id, ctx.userId, people.map((p) => p.id));
  await audit({ action: "call.start", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { callees: ids, type: input.type } });
  return { meeting, callees: people.map((p) => ({ id: p.id, displayName: p.displayName })) };
}

/** Mark overdue rings as missed and tell the callee. Safe to call often (from the worker and on reads). */
export async function expireRings(now = new Date()) {
  const overdue = await db.callRing.findMany({
    where: { status: "RINGING", expiresAt: { lte: now } },
    include: { caller: { select: { displayName: true } }, meeting: { select: { joinCode: true, title: true, callType: true } } },
    take: 200,
  });
  for (const r of overdue) {
    const claimed = await db.callRing.updateMany({ where: { id: r.id, status: "RINGING" }, data: { status: "MISSED" } });
    if (claimed.count === 0) continue;
    await notifyUsers([r.calleeId], {
      type: "call.missed",
      title: `Missed ${r.meeting.callType === "VOICE" ? "voice" : "video"} call from ${r.caller.displayName}`,
      link: `/meetings/${r.meeting.joinCode}`,
      data: { meetingId: r.meetingId },
    });
  }
  return overdue.length;
}

/** Calls currently ringing for the caller (polled by every open page). */
export async function listIncomingCalls(ctx: { userId: string }) {
  await expireRings();
  const rings = await db.callRing.findMany({
    where: { calleeId: ctx.userId, status: "RINGING", expiresAt: { gt: new Date() }, meeting: { status: { in: ["LIVE", "SCHEDULED"] } } },
    orderBy: { createdAt: "desc" },
    take: 5,
    include: {
      caller: { select: { id: true, displayName: true, email: true } },
      meeting: { select: { id: true, joinCode: true, title: true, callType: true, isDirectCall: true, organization: { select: { name: true } } } },
    },
  });
  return rings.map((r) => ({
    id: r.id,
    expiresAt: r.expiresAt,
    caller: r.caller,
    meeting: { joinCode: r.meeting.joinCode, title: r.meeting.title, callType: r.meeting.callType, isDirectCall: r.meeting.isDirectCall, workspace: r.meeting.organization.name },
  }));
}

export async function respondToRing(ctx: { userId: string; organizationId: string }, ringId: string, response: "accept" | "decline") {
  const ring = await db.callRing.findFirst({
    where: { id: ringId, calleeId: ctx.userId },
    include: { meeting: { select: { joinCode: true, organizationId: true, status: true, participants: { where: { userId: ctx.userId }, select: { removedAt: true } } } } },
  });
  if (!ring) throw new AppError("NOT_FOUND", "That call is no longer available.");
  if (ring.status !== "RINGING" || ring.expiresAt <= new Date()) throw new AppError("CONFLICT", "That call has already ended or been answered.");
  // The call may have ended, or this person been removed, since the ring started.
  const member = await db.organizationMember.findFirst({ where: { organizationId: ring.meeting.organizationId, userId: ctx.userId }, select: { id: true } });
  if (response === "accept" && (ring.meeting.status !== "LIVE" || ring.meeting.participants[0]?.removedAt || !member)) {
    await db.callRing.updateMany({ where: { id: ring.id, status: "RINGING" }, data: { status: "CANCELED" } });
    throw new AppError("CONFLICT", "That call has ended.");
  }
  const claimed = await db.callRing.updateMany({ where: { id: ring.id, status: "RINGING" }, data: { status: response === "accept" ? "ACCEPTED" : "DECLINED", respondedAt: new Date() } });
  if (claimed.count === 0) throw new AppError("CONFLICT", "That call has already ended or been answered.");
  await audit({ action: `call.${response}`, actorUserId: ctx.userId, organizationId: ring.meeting.organizationId, targetType: "Meeting", targetId: ring.meetingId });
  // The callee may belong to the meeting's workspace under a different active workspace; the client switches if needed.
  return { joinCode: ring.meeting.joinCode, organizationId: ring.meeting.organizationId };
}

/** Only the host and current (not removed) participants see or trigger ringing. */
function assertInCall(meeting: { hostId: string; participants: { userId: string; removedAt: Date | null }[] }, userId: string) {
  if (meeting.hostId === userId) return;
  if (!meeting.participants.some((p) => p.userId === userId && !p.removedAt)) throw new AppError("FORBIDDEN", "Only people in this call can do that.");
}

/** Ring states for a call, for the caller's "Ringing… / Declined / No answer" banner. */
export async function getRingStates(ctx: Ctx, ref: string) {
  const { meeting } = await getAccessibleMeeting(ctx, ref);
  assertInCall(meeting, ctx.userId);
  await expireRings();
  const rings = await db.callRing.findMany({
    where: { meetingId: meeting.id },
    orderBy: { createdAt: "desc" },
    include: { callee: { select: { id: true, displayName: true } } },
  });
  const latest = new Map<string, (typeof rings)[number]>();
  for (const r of rings) if (!latest.has(r.calleeId)) latest.set(r.calleeId, r);
  return [...latest.values()].map((r) => ({ calleeId: r.calleeId, displayName: r.callee.displayName, status: r.status, expiresAt: r.expiresAt }));
}

/** Caller hangs up (or ends) before people answered: stop ringing them. */
export async function cancelRings(ctx: Ctx, ref: string) {
  const { meeting } = await getAccessibleMeeting(ctx, ref);
  const res = await db.callRing.updateMany({ where: { meetingId: meeting.id, callerId: ctx.userId, status: "RINGING" }, data: { status: "CANCELED" } });
  return { canceled: res.count };
}

/** Ring people again (the "Call again" button / assistant). Only moderators of the meeting may. */
export async function ringAgain(ctx: Ctx, ref: string, userIds: string[]) {
  const { meeting, myRole } = await getAccessibleMeeting(ctx, ref);
  assertInCall(meeting, ctx.userId);
  if (myRole === "ATTENDEE" && !meeting.isDirectCall) throw new AppError("FORBIDDEN", "Only the host or a co-host can ring people.");
  if (meeting.status === "ENDED" || meeting.status === "CANCELED") throw new AppError("CONFLICT", "This call has ended.");
  const allowed = new Set(meeting.participants.filter((p) => !p.removedAt).map((p) => p.userId));
  const ids = userIds.filter((id) => allowed.has(id));
  if (ids.length !== userIds.length) throw new AppError("VALIDATION", "You can only ring people who are part of this call. Invite them first.");
  return { rang: await ringUsers(meeting.id, ctx.userId, ids) };
}
