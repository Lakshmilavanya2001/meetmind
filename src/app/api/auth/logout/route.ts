import { NextResponse } from "next/server";
import { open } from "@/server/http";
import { destroySession, SESSION_COOKIE } from "@/server/auth/session";

export const POST = open(async (req) => {
  await destroySession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
