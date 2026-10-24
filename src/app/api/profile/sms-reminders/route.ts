import { authed, readJson } from "@/server/http";
import { setSmsReminders } from "@/server/services/sms";

// PUT { enabled } — text reminders to your verified number by default.
export const PUT = authed(async (req, ctx) => setSmsReminders(ctx, await readJson(req)));
