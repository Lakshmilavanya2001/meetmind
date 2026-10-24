import { authed, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { createReminder, listReminders } from "@/server/services/reminders";

// GET ?include=all for history; POST { text, dueAt, sms? }
export const GET = authed(async (req, ctx) => ({ reminders: await listReminders(ctx, { include: req.nextUrl.searchParams.get("include") === "all" ? "all" : "upcoming" }) }));
export const POST = authed(async (req, ctx) => {
  rateLimit(`reminders:${ctx.userId}`, 30, 60_000);
  return { reminder: await createReminder(ctx, await readJson(req)) };
});
