import "server-only";
import { db } from "../db";
import { generateToken, hashToken } from "./tokens";
import type { OrgRole } from "@/generated/prisma/enums";

export const SESSION_COOKIE = "mm_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export type AuthContext = {
  sessionId: string;
  userId: string;
  organizationId: string;
  orgRole: OrgRole;
  user: {
    id: string;
    email: string;
    displayName: string;
    timezone: string;
  };
};

export const sessionCookieOptions = (expires: Date, overHttps = false) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: overHttps || process.env.COOKIE_SECURE === "true",
  path: "/",
  expires,
});

export async function createSession(input: {
  userId: string;
  organizationId: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: input.userId,
      activeOrganizationId: input.organizationId,
      expiresAt,
      userAgent: input.userAgent?.slice(0, 300),
      ipAddress: input.ipAddress,
    },
  });
  return { token, expiresAt };
}

/**
 * Resolve a raw cookie token to an authenticated context.
 * Returns null for unknown/expired sessions, deactivated users, or lost org membership.
 */
export async function resolveSession(token: string | undefined | null): Promise<AuthContext | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: { select: { id: true, email: true, displayName: true, timezone: true, isActive: true } },
    },
  });
  if (!session || session.expiresAt <= new Date() || !session.user.isActive) return null;

  // Membership is re-checked on every request so role changes / removals apply immediately.
  const membership = session.activeOrganizationId
    ? await db.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: session.activeOrganizationId,
            userId: session.userId,
          },
        },
      })
    : await db.organizationMember.findFirst({
        where: { userId: session.userId },
        orderBy: { createdAt: "asc" },
      });
  if (!membership) return null;

  const now = Date.now();
  if (now - session.lastSeenAt.getTime() > REFRESH_AFTER_MS || !session.activeOrganizationId) {
    await db.session.update({
      where: { id: session.id },
      data: {
        lastSeenAt: new Date(now),
        expiresAt: new Date(now + SESSION_TTL_MS),
        activeOrganizationId: membership.organizationId,
      },
    });
  }

  const { id, email, displayName, timezone } = session.user;
  return {
    sessionId: session.id,
    userId: session.userId,
    organizationId: membership.organizationId,
    orgRole: membership.role,
    user: { id, email, displayName, timezone },
  };
}

export async function destroySession(token: string | undefined | null) {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}
