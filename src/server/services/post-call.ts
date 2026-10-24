import "server-only";
import { db } from "../db";
import { isLlmConfigured } from "../ai/llm";
import { getLatestSummary, summarizeMeeting } from "./summaries";
import { notifyUsers } from "./notifications";
import { deliverSummary } from "./summary-delivery";
import { canTextUser } from "./sms";
import { formatInTimeZone } from "date-fns-tz";
import { zonedWallTimeToUtc } from "@/lib/time";

const RETRY_AFTER_MS = 10 * 60_000;
const LOOKBACK_MS = 24 * 3600_000;

/**
 * After a call ends and its transcript is final: summarise it automatically, tell the participants,
 * and set reminders for action items that have an owner (a participant) and a due date.
 * Each meeting is processed once (retried once after 10 min if the AI was unavailable).
 */
let running = false;
export async function runPostCallSummaries(now = new Date()) {
  if (!isLlmConfigured() || running) return 0;
  running = true;
  try {
    return await sweep(now);
  } finally {
    running = false;
  }
}

async function sweep(now: Date) {
  const candidates = await db.meeting.findMany({
    where: {
      status: "ENDED",
      endedAt: { gte: new Date(now.getTime() - LOOKBACK_MS) },
      transcript: { status: "COMPLETED" },
      segments: { some: {} },
      OR: [{ autoSummaryAt: null }, { autoSummaryAt: { lt: new Date(now.getTime() - RETRY_AFTER_MS) }, summaries: { none: {} }, endedAt: { gte: new Date(now.getTime() - 2 * 3600_000) } }],
    },
    select: { id: true, autoSummaryAt: true },
    take: 3,
  });
  let done = 0;
  for (const c of candidates) {
    const claimed = await db.meeting.updateMany({ where: { id: c.id, autoSummaryAt: c.autoSummaryAt }, data: { autoSummaryAt: now } });
    if (!claimed.count) continue;
    try {
      if (await summariseAndNotify(c.id, now)) done++;
    } catch (err) {
      console.error(`[post-call] meeting ${c.id} failed:`, (err as Error).message);
    }
  }
  return done;
}

async function summariseAndNotify(meetingId: string, now: Date) {
  const m = await db.meeting.findUniqueOrThrow({
    where: { id: meetingId },
    select: { id: true, title: true, joinCode: true, organizationId: true, timezone: true, hostId: true, host: { select: { displayName: true, isActive: true } }, participants: { where: { removedAt: null }, select: { userId: true } } },
  });
  const membership = await db.organizationMember.findFirst({ where: { organizationId: m.organizationId, userId: m.hostId }, select: { role: true } });
  if (!membership || !m.host.isActive) return false;
  // Runs with the host's permissions; the summary is visible only to the meeting's participants.
  const ctx = { userId: m.hostId, organizationId: m.organizationId, orgRole: membership.role, user: { displayName: m.host.displayName } };
  const existing = await getLatestSummary(ctx, m.joinCode);
  const summary = existing && !existing.stale ? existing : await summarizeMeeting(ctx, m.joinCode);

  const link = `/meetings/${m.joinCode}/transcript`;
  // In the app, by email and (if they asked) by SMS — each attempt is recorded for the delivery panel.
  await deliverSummary(m.id, { summaryId: summary.id });

  // Action items owned by a participant: tell them, and remind them on the due date.
  const items = await db.actionItem.findMany({
    where: { summaryId: summary.id, assigneeUserId: { not: null }, status: "OPEN" },
    select: { id: true, description: true, dueDate: true, assigneeUserId: true, assignee: { select: { smsReminders: true, phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedVia: true, timezone: true } } },
  });
  const byOwner = new Map<string, number>();
  for (const it of items) byOwner.set(it.assigneeUserId!, (byOwner.get(it.assigneeUserId!) ?? 0) + 1);
  for (const [userId, n] of byOwner) {
    await notifyUsers([userId], { type: "action_items.assigned", title: `${n} action item${n > 1 ? "s" : ""} for you`, body: `From “${m.title}”`, link, data: { meetingId: m.id } });
  }
  const reminders = items.flatMap((it) => {
    if (!it.dueDate || it.dueDate.getTime() <= now.getTime()) return [];
    // 09:00 on the due day, in the owner's own time zone (or in a minute, if that has passed).
    const dueDay = formatInTimeZone(it.dueDate, m.timezone, "yyyy-MM-dd");
    const nineAm = zonedWallTimeToUtc(dueDay, "09:00", it.assignee?.timezone ?? m.timezone);
    const dueAt = new Date(Math.max(nineAm.getTime(), now.getTime() + 60_000));
    return [{
      organizationId: m.organizationId,
      userId: it.assigneeUserId!,
      text: `Due today: ${it.description} (from “${m.title}”)`.slice(0, 300),
      dueAt,
      sms: !!(it.assignee?.smsReminders && canTextUser(it.assignee)),
      source: "action_item",
      meetingId: m.id,
      actionItemId: it.id,
    }];
  });
  if (reminders.length) await db.reminder.createMany({ data: reminders, skipDuplicates: true });
  return true;
}
