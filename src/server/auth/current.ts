import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveSession, SESSION_COOKIE } from "./session";

/** Session lookup for Server Components, de-duplicated per request. */
export const getAuth = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return resolveSession(token);
});

export async function requireAuth() {
  const ctx = await getAuth();
  if (!ctx) redirect("/login");
  return ctx;
}
