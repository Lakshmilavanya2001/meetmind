import { NextResponse } from "next/server";
import { authed, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { startCall } from "@/server/services/calls";

// POST /api/calls — { userIds[], type: "VOICE" | "VIDEO" } → starts a call and rings them.
export const POST = authed(async (req, ctx) => {
  rateLimit(`call:${ctx.userId}`, 30, 60 * 60_000);
  return NextResponse.json(await startCall(ctx, await readJson(req)), { status: 201 });
});
