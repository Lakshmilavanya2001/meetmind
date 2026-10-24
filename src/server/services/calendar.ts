import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import { getDirectoryUsers } from "./directory";
import { localClock, overlaps } from "@/lib/time";

type Ctx = { userId: string; organizationId: string };

export type BusyBlock = { start: Date; end: Date; title: string | null; meetingId: string | null };
export type Conflict = { userId: string; displayName: string; busy: BusyBlock[] };

const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * Busy blocks from the internal calendar. Titles are only revealed for the caller's own
 * events and for meetings the caller also participates in; everything else is just "busy".
 */
async function busyBlocks(ctx: Ctx, userIds: string[], start: Date, end: Date, excludeMeetingId?: string) {
  const events = await db.calendarEvent.findMany({
    where: {
      userId: { in: userIds },
      status: { not: "CANCELED" },
      isBusy: true,
      startsAt: { lt: end },
      endsAt: { gt: start },
      // Only this workspace's meetings (a user can belong to several workspaces).
      AND: [
        { OR: [{ meetingId: null }, { meeting: { organizationId: ctx.organizationId } }] },
        ...(excludeMeetingId ? [{ OR: [{ meetingId: null }, { meetingId: { not: excludeMeetingId } }] }] : []),
      ],
    },
    orderBy: { startsAt: "asc" },
    select: { userId: true, startsAt: true, endsAt: true, title: true, meetingId: true },
  });
  const meetingIds = [...new Set(events.map((e) => e.meetingId).filter((m): m is string => !!m))];
  const mine = new Set(
    (
      await db.meetingParticipant.findMany({
        where: { userId: ctx.userId, meetingId: { in: meetingIds }, removedAt: null },
        select: { meetingId: true },
      })
    ).map((p) => p.meetingId),
  );
  const byUser = new Map<string, BusyBlock[]>();
  for (const e of events) {
    const visible = e.userId === ctx.userId || (e.meetingId !== null && mine.has(e.meetingId));
    const list = byUser.get(e.userId) ?? [];
    list.push({ start: e.startsAt, end: e.endsAt, title: visible ? e.title : null, meetingId: visible ? e.meetingId : null });
    byUser.set(e.userId, list);
  }
  return byUser;
}

/** Participants (by id) who already have something in the internal calendar overlapping [start, end). */
export async function findConflicts(ctx: Ctx, userIds: string[], start: Date, end: Date, excludeMeetingId?: string): Promise<Conflict[]> {
  const users = await getDirectoryUsers(ctx, userIds, { includeGuests: true });
  const busy = await busyBlocks(ctx, users.map((u) => u.id), start, end, excludeMeetingId);
  return users
    .filter((u) => (busy.get(u.id)?.length ?? 0) > 0)
    .map((u) => ({ userId: u.id, displayName: u.displayName, busy: busy.get(u.id)! }));
}

function validateRange(start: Date, end: Date) {
  if (!(start < end)) throw new AppError("VALIDATION", "The end time must be after the start time.");
  if (end.getTime() - start.getTime() > MAX_RANGE_MS) throw new AppError("VALIDATION", "Availability can be checked for up to 31 days at a time.");
}

async function resolveUsersOrThrow(ctx: Ctx, userIds: string[]) {
  const ids = [...new Set(userIds)];
  const users = await getDirectoryUsers(ctx, ids, { includeGuests: true });
  if (users.length !== ids.length) {
    const found = new Set(users.map((u) => u.id));
    throw new AppError("VALIDATION", "Some people are not members of this workspace.", { unknownUserIds: ids.filter((i) => !found.has(i)) });
  }
  return users;
}

/** Busy times per person from MeetMind's internal calendar (external calendars are not connected). */
export async function getAvailability(ctx: Ctx, userIds: string[], start: Date, end: Date) {
  validateRange(start, end);
  const users = await resolveUsersOrThrow(ctx, userIds);
  const busy = await busyBlocks(ctx, users.map((u) => u.id), start, end);
  return {
    source: "internal_calendar" as const,
    note: "Based on meetings scheduled in MeetMind only. External calendars (Google/Outlook) are not connected, so other commitments are not visible.",
    users: users.map((u) => ({ userId: u.id, displayName: u.displayName, timezone: u.timezone, busy: busy.get(u.id) ?? [] })),
  };
}

export type FreeSlot = { start: Date; end: Date; local: { userId: string; displayName: string; timezone: string; start: string }[] };

/**
 * Find slots where everyone is free and inside their own working hours (local time, Mon–Fri).
 * Uses only the internal calendar.
 */
export async function findFreeSlots(
  ctx: Ctx,
  input: {
    userIds: string[];
    rangeStart: Date;
    rangeEnd: Date;
    durationMinutes: number;
    workdayStartMinutes?: number;
    workdayEndMinutes?: number;
    stepMinutes?: number;
    limit?: number;
  },
): Promise<{ slots: FreeSlot[]; note: string }> {
  const { rangeStart, rangeEnd, durationMinutes } = input;
  validateRange(rangeStart, rangeEnd);
  if (durationMinutes < 5 || durationMinutes > 8 * 60) throw new AppError("VALIDATION", "Duration must be between 5 minutes and 8 hours.");
  const users = await resolveUsersOrThrow(ctx, [ctx.userId, ...input.userIds]);
  const busy = await busyBlocks(ctx, users.map((u) => u.id), rangeStart, rangeEnd);
  const dayStart = input.workdayStartMinutes ?? 9 * 60;
  const dayEnd = input.workdayEndMinutes ?? 18 * 60;
  const step = (input.stepMinutes ?? 30) * 60_000;
  const dur = durationMinutes * 60_000;
  const limit = input.limit ?? 5;

  const slots: FreeSlot[] = [];
  const earliest = Math.max(rangeStart.getTime(), Date.now());
  for (let t = Math.ceil(earliest / step) * step; t + dur <= rangeEnd.getTime() && slots.length < limit; t += step) {
    const s = new Date(t);
    const e = new Date(t + dur);
    const ok = users.every((u) => {
      const a = localClock(s, u.timezone);
      const b = localClock(new Date(e.getTime() - 1), u.timezone); // last minute of the slot
      const inHours = a.weekday <= 5 && a.weekday === b.weekday && a.minutes >= dayStart && b.minutes < dayEnd;
      return inHours && !(busy.get(u.id) ?? []).some((x) => overlaps(s, e, x.start, x.end));
    });
    if (ok) {
      slots.push({
        start: s,
        end: e,
        local: users.map((u) => ({
          userId: u.id,
          displayName: u.displayName,
          timezone: u.timezone,
          start: new Intl.DateTimeFormat("en-GB", { timeZone: u.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(s),
        })),
      });
    }
  }
  return {
    slots,
    note: "Checked against MeetMind's internal calendar and each person's working hours (09:00–18:00 local, Mon–Fri). External calendars are not connected.",
  };
}

/** The caller's own calendar for a range (all their events, with titles). */
export async function listMyCalendar(ctx: Ctx, start: Date, end: Date) {
  validateRange(start, end);
  return db.calendarEvent.findMany({
    where: { userId: ctx.userId, startsAt: { lt: end }, endsAt: { gt: start }, meeting: { organizationId: ctx.organizationId } },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      status: true,
      meeting: { select: { id: true, joinCode: true, status: true, host: { select: { displayName: true } } } },
    },
  });
}
