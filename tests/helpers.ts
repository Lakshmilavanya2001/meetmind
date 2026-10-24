import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { createSession, resolveSession, SESSION_COOKIE, type AuthContext } from "@/server/auth/session";
import type { OrgRole } from "@/generated/prisma/enums";

export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

let passwordHash: string | undefined;
export const TEST_PASSWORD = "correct-horse-battery";

export async function createOrg(name = "Acme") {
  const slug = `${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  return db.organization.create({ data: { name, slug, joinCode: `${slug}-code` } });
}

export async function createUser(
  orgId: string,
  displayName: string,
  opts: { email?: string; role?: OrgRole; isActive?: boolean; timezone?: string } = {},
) {
  passwordHash ??= await hashPassword(TEST_PASSWORD);
  const email = opts.email ?? `${displayName.toLowerCase().replace(/\W+/g, ".")}.${Math.random().toString(36).slice(2, 6)}@test.dev`;
  const user = await db.user.create({
    data: { email, displayName, passwordHash, isActive: opts.isActive ?? true, timezone: opts.timezone ?? "UTC" },
  });
  await db.organizationMember.create({ data: { organizationId: orgId, userId: user.id, role: opts.role ?? "MEMBER" } });
  return user;
}

/** Create a real session and return its cookie token plus resolved context. */
export async function loginAs(userId: string, organizationId: string) {
  const { token } = await createSession({ userId, organizationId });
  const ctx = (await resolveSession(token)) as AuthContext;
  return { token, ctx };
}

export function request(
  url: string,
  init: { method?: string; token?: string; json?: unknown; origin?: string } = {},
) {
  const headers = new Headers({ host: "localhost:3100" });
  if (init.token) headers.set("cookie", `${SESSION_COOKIE}=${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.origin) headers.set("origin", init.origin);
  return new NextRequest(new URL(url, "http://localhost:3100"), {
    method: init.method ?? "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
}

export const noParams = { params: Promise.resolve({}) } as { params: Promise<never> };
export const withParams = <P>(p: P) => ({ params: Promise.resolve(p) });
