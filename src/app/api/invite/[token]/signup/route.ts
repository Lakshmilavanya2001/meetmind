import { NextResponse } from "next/server";
import { clientIp, isHttps, open, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { acceptExternalInvitationAsNewUser } from "@/server/services/invitations";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";

// Create a guest account for the invited email and sign in.
export const POST = open<{ token: string }>(async (req, { token }) => {
  const ipAddress = clientIp(req);
  if (ipAddress) rateLimit(`signup:${ipAddress}`, 10, 60 * 60 * 1000);
  else rateLimit("signup:global", 200, 60 * 60 * 1000);
  const res = await acceptExternalInvitationAsNewUser(token, await readJson(req));
  const { token: sessionToken, expiresAt } = await createSession({
    userId: res.userId,
    organizationId: res.organizationId,
    ipAddress,
    userAgent: req.headers.get("user-agent"),
  });
  const out = NextResponse.json({ joinCode: res.joinCode }, { status: 201 });
  out.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions(expiresAt, isHttps(req)));
  return out;
});
