import { NextResponse } from "next/server";
import { authed, isHttps } from "@/server/http";
import { startUberConnect, UBER_STATE_COOKIE } from "@/server/services/uber";

// Top-level navigation from Settings: send the user to Uber's sign-in, remembering a one-time state.
export const GET = authed(async (req, ctx) => {
  const { url, state } = startUberConnect(ctx);
  const res = NextResponse.redirect(url);
  res.cookies.set(UBER_STATE_COOKIE, `${ctx.userId}.${state}`, { httpOnly: true, secure: isHttps(req), sameSite: "lax", path: "/api/integrations/uber", maxAge: 600 });
  return res;
});
