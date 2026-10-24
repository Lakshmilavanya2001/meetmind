import { NextResponse } from "next/server";
import { clientIp, isHttps, open, readJson } from "@/server/http";
import { login } from "@/server/services/auth";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";

export const POST = open(async (req) => {
  const ipAddress = clientIp(req);
  const { userId, organizationId } = await login(await readJson(req), { ip: ipAddress });
  const { token, expiresAt } = await createSession({
    userId,
    organizationId,
    ipAddress,
    userAgent: req.headers.get("user-agent"),
  });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt, isHttps(req)));
  return res;
});
