import { authed, readJson } from "@/server/http";
import { rescheduleMeeting } from "@/server/services/scheduling";

// POST — { startTime, endTime, allowConflicts? }
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => rescheduleMeeting(ctx, ref, await readJson(req)));
