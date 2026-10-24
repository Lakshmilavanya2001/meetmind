import { NextResponse } from "next/server";
import { clientIp, isHttps, open, readJson } from "@/server/http";
import { signup } from "@/server/services/auth";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import type { SignupInput } from "@/lib/validation";

export const POST = open(async (req) => {
  const ipAddress = clientIp(req);
  const { userId, organizationId } = await signup((await readJson(req)) as SignupInput, { ip: ipAddress });
  const { token, expiresAt } = await createSession({
    userId,
    organizationId,
    ipAddress,
    userAgent: req.headers.get("user-agent"),
  });
  const res = NextResponse.json({ ok: true }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt, isHttps(req)));
  return res;
});
