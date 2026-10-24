import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { notifyUsers } from "./notifications";
import { canTextUser, isSmsAvailable, sendSms } from "./sms";
import { formatInTimeZone } from "date-fns-tz";

type Ctx = { userId: string; organizationId: string };

const MAX_PENDING = 100;
export const reminderInputSchema = z.object({
  text: z.string().trim().min(1, "What should we remind you about?").max(300),
  dueAt: z.coerce.date(),
  sms: z.boolean().optional(), // default: the user's "text me reminders" setting
});

/** Validate a reminder without creating it (also used to describe it before the user confirms). */
export async function checkReminder(ctx: Ctx, raw: unknown) {
  const input = reminderInputSchema.parse(raw);
  const now = Date.now();
  if (input.dueAt.getTime() < now - 60_000) throw new AppError("VALIDATION", "That time has already passed.");
  if (input.dueAt.getTime() > now + 366 * 86400_000) throw new AppError("VALIDATION", "Reminders can be set up to a year ahead.");
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedVia: true, smsReminders: true, timezone: true } });
  const sms = input.sms ?? user.smsReminders;
  if (sms && !isSmsAvailable()) throw new AppError("VALIDATION", "Text messages aren't set up on this server. The reminder was not created; you can create it without SMS.");
  if (sms && !canTextUser(user)) throw new AppError("VALIDATION", "SMS reminders need a verified mobile number (Profile → Mobile number). The reminder was not created; you can create it without SMS.");
  const pending = await db.reminder.count({ where: { userId: ctx.userId, status: "PENDING" } });
  if (pending >= MAX_PENDING) throw new AppError("VALIDATION", `You already have ${MAX_PENDING} upcoming reminders.`);
  return { input, sms, phone: user.phoneNumber, timezone: user.timezone, when: formatInTimeZone(input.dueAt, user.timezone, "EEE d MMM yyyy, HH:mm") };
}

/** A personal reminder for yourself. In-app always; by SMS only to your own verified number. */
export async function createReminder(ctx: Ctx, raw: unknown, source: "user" | "assistant" = "user") {
  const { input, sms, timezone } = await checkReminder(ctx, raw);
  const r = await db.reminder.create({ data: { organizationId: ctx.organizationId, userId: ctx.userId, text: input.text, dueAt: input.dueAt, sms, source } });
  await audit({ action: "reminder.create", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Reminder", targetId: r.id, metadata: { sms, source } });
  return { ...view(r), when: formatInTimeZone(r.dueAt, timezone, "EEE d MMM yyyy, HH:mm") };
}

const view = (r: { id: string; text: string; dueAt: Date; sms: boolean; status: string; source: string; meetingId: string | null; sentAt: Date | null; smsStatus: string | null }) => ({
  id: r.id, text: r.text, dueAt: r.dueAt, sms: r.sms, status: r.status, source: r.source, meetingId: r.meetingId, sentAt: r.sentAt, smsStatus: r.smsStatus,
});

export async function listReminders(ctx: Ctx, opts: { include?: "upcoming" | "all" } = {}) {
  const rows = await db.reminder.findMany({
    where: { userId: ctx.userId, ...(opts.include === "all" ? {} : { status: { in: ["PENDING", "SENDING"] } }) },
    orderBy: opts.include === "all" ? { dueAt: "desc" } : { dueAt: "asc" },
    take: 100,
  });
  return rows.map(view);
}

export async function cancelReminder(ctx: Ctx, id: string) {
  const r = await db.reminder.updateMany({ where: { id, userId: ctx.userId, status: "PENDING" }, data: { status: "CANCELED" } });
  if (r.count === 0) throw new AppError("NOT_FOUND", "No upcoming reminder with that id.");
  return { canceled: true };
}

/** Worker: deliver due reminders. Each is claimed atomically, so several instances never double-send. */
export async function sendDueReminders(now = new Date()) {
  const due = await db.reminder.findMany({ where: { status: "PENDING", dueAt: { lte: now } }, orderBy: { dueAt: "asc" }, take: 50, select: { id: true } });
  let sent = 0;
  for (const { id } of due) {
    const claimed = await db.reminder.updateMany({ where: { id, status: "PENDING" }, data: { status: "SENDING", sentAt: new Date() } }); // sentAt = claim time until delivered
    if (!claimed.count) continue;
    const r = await db.reminder.findUniqueOrThrow({ where: { id }, include: { user: { select: { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedVia: true, isActive: true } } } });
    try {
      if (!r.user.isActive) {
        await db.reminder.update({ where: { id }, data: { status: "CANCELED", sentAt: null } });
        continue;
      }
      await notifyUsers([r.userId], { type: "reminder", title: "Reminder", body: r.text, link: "/tasks", data: { reminderId: r.id } });
      let smsStatus: string | null = null;
      if (r.sms) {
        if (!canTextUser(r.user)) smsStatus = "skipped: number not verified for SMS";
        else {
          // Action items come from meeting text other people control: text a fixed notice, not their words.
          const body = r.source === "action_item" ? "MeetMind: you have an action item due today. Open MeetMind → Tasks for details." : `MeetMind reminder: ${r.text}`.slice(0, 320);
          const s = await sendSms({ userId: r.userId, to: r.user.phoneNumber!, body, purpose: "reminder" });
          smsStatus = s.ok ? (s.status === "OUTBOX" ? "outbox" : "sent") : `failed: ${s.error}`;
        }
      }
      await db.reminder.update({ where: { id }, data: { status: "SENT", sentAt: new Date(), smsStatus } });
      sent++;
    } catch (err) {
      console.error("[reminders] delivery failed", (err as Error).message);
      await db.reminder.update({ where: { id }, data: { status: "FAILED", smsStatus: `failed: ${(err as Error).message.slice(0, 200)}` } });
    }
  }
  // Recover reminders claimed more than 5 minutes ago but never finished (a crash mid-delivery).
  await db.reminder.updateMany({ where: { status: "SENDING", sentAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { status: "PENDING", sentAt: null } });
  return sent;
}
