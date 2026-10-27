import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { open } from "@/server/http";
import { resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import { isAppError } from "@/server/errors";
import { finishUberConnect, UBER_STATE_COOKIE } from "@/server/services/uber";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Uber sends the user back here after sign-in. The state must match the cookie set when they started, for the
// same signed-in user, so another site can't attach its own Uber account to this user.
export const GET = open(async (req: NextRequest) => {
  const back = (result: string) => {
    const res = NextResponse.redirect(new URL(`/settings/profile?uber=${result}`, process.env.APP_URL || req.nextUrl.origin));
    res.cookies.delete({ name: UBER_STATE_COOKIE, path: "/api/integrations/uber" });
    return res;
  };
  const ctx = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!ctx) return back("signin");
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return back("denied");
  const expected = req.cookies.get(UBER_STATE_COOKIE)?.value ?? "";
  const code = q.get("code");
  if (!code || !expected || !same(expected, `${ctx.userId}.${q.get("state") ?? ""}`)) return back("expired");
  try {
    await finishUberConnect(ctx, code);
    return back("connected");
  } catch (err) {
    if (!isAppError(err)) console.error("[uber] connect failed", err);
    return back("error");
  }
});
