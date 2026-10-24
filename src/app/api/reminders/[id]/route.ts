import { authed } from "@/server/http";
import { cancelReminder } from "@/server/services/reminders";

export const DELETE = authed<{ id: string }>(async (_req, ctx, { id }) => cancelReminder(ctx, id));
