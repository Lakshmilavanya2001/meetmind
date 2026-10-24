import { NextResponse } from "next/server";
import { authed, readJson } from "@/server/http";
import { scheduleMeeting } from "@/server/services/scheduling";
import { rateLimit } from "@/server/rate-limit";

// POST /api/meetings/schedule — { title, description?, startTime, endTime, timezone?, participantIds[], allowConflicts? }
export const POST = authed(async (req, ctx) => {
  rateLimit(`meeting:create:${ctx.userId}`, 120, 60 * 60 * 1000);
  return NextResponse.json(await scheduleMeeting(ctx, await readJson(req)), { status: 201 });
});
