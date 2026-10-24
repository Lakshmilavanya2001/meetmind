import { authed, readJson } from "@/server/http";
import { setSummaryPrefs } from "@/server/services/summary-delivery";

// PUT { email, sms } — how you receive call summaries (always in the app too).
export const PUT = authed(async (req, ctx) => setSummaryPrefs(ctx, await readJson(req)));
