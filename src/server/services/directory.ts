import "server-only";
import { db } from "../db";
import type { OrgRole } from "@/generated/prisma/enums";

export type DirectoryUser = {
  id: string;
  displayName: string;
  email: string;
  title: string | null;
  department: string | null;
  timezone: string;
  role: OrgRole;
};

type Ctx = { organizationId: string };

const tokenize = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);

/** Lower is better. Exact full-name match < name starts with query < word-prefix match < substring. */
function rank(user: { displayName: string; email: string }, q: string) {
  const name = user.displayName.toLowerCase();
  const query = q.toLowerCase().trim();
  if (name === query || user.email === query) return 0;
  if (name.startsWith(query)) return 1;
  const words = name.split(/\s+/);
  if (tokenize(query).every((t) => words.some((w) => w.startsWith(t)))) return 2;
  return 3;
}

/**
 * Search the caller's workspace directory. Only active members of the caller's
 * organization are ever returned — this is the only directory the agent can see.
 */
export async function searchDirectory(
  ctx: Ctx,
  q: string,
  limit = 20,
  opts: { includeGuests?: boolean } = {},
): Promise<DirectoryUser[]> {
  const tokens = tokenize(q);
  const members = await db.organizationMember.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(opts.includeGuests ? {} : { role: { not: "GUEST" as const } }),
      user: {
        isActive: true,
        // Every word must match the name, email, job title or department ("rahul backend").
        AND: tokens.map((t) => ({
          OR: [
            { displayName: { contains: t, mode: "insensitive" as const } },
            { email: { contains: t, mode: "insensitive" as const } },
            { title: { contains: t, mode: "insensitive" as const } },
            { department: { contains: t, mode: "insensitive" as const } },
          ],
        })),
      },
    },
    include: {
      user: {
        select: { id: true, displayName: true, email: true, title: true, department: true, timezone: true },
      },
    },
    take: 200,
    orderBy: { user: { displayName: "asc" } },
  });
  return members
    .map((m) => ({ ...m.user, role: m.role }))
    .sort((a, b) => (q ? rank(a, q) - rank(b, q) : 0) || a.displayName.localeCompare(b.displayName))
    .slice(0, limit);
}

export type ResolveResult =
  | { status: "resolved"; user: DirectoryUser }
  | { status: "ambiguous"; candidates: DirectoryUser[] }
  | { status: "not_found"; suggestions: DirectoryUser[] };

/**
 * Resolve a spoken/typed name (or email) to exactly one workspace member.
 * Never guesses: several plausible matches → "ambiguous" so the caller must ask the user,
 * no match → "not_found" with fuzzy *suggestions* that must not be auto-selected.
 */
export async function resolveUser(ctx: Ctx, query: string): Promise<ResolveResult> {
  const q = query.trim();
  if (!q) return { status: "not_found", suggestions: [] };

  const matches = await searchDirectory(ctx, q, 25);
  const exact = matches.filter((u) => rank(u, q) === 0);

  if (exact.length === 1) return { status: "resolved", user: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };
  if (matches.length === 1) return { status: "resolved", user: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches.slice(0, 10) };

  // Typo-tolerant suggestions via pg_trgm — offered to the user, never auto-selected.
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT u."id" FROM "User" u
    JOIN "OrganizationMember" m ON m."userId" = u."id"
    WHERE m."organizationId" = ${ctx.organizationId} AND u."isActive" AND m."role" <> 'GUEST'
      AND similarity(u."displayName", ${q}) > 0.25
    ORDER BY similarity(u."displayName", ${q}) DESC
    LIMIT 5`;
  if (rows.length === 0) return { status: "not_found", suggestions: [] };
  const suggestions = await getDirectoryUsers(ctx, rows.map((r) => r.id));
  return { status: "not_found", suggestions };
}

/** Fetch users by id, silently dropping any that are not active (non-guest) members of the caller's workspace. */
export async function getDirectoryUsers(ctx: Ctx, ids: string[], opts: { includeGuests?: boolean } = {}): Promise<DirectoryUser[]> {
  if (ids.length === 0) return [];
  const members = await db.organizationMember.findMany({
    where: {
      organizationId: ctx.organizationId,
      userId: { in: ids },
      user: { isActive: true },
      ...(opts.includeGuests ? {} : { role: { not: "GUEST" as const } }),
    },
    include: {
      user: {
        select: { id: true, displayName: true, email: true, title: true, department: true, timezone: true },
      },
    },
  });
  const byId = new Map(members.map((m) => [m.userId, { ...m.user, role: m.role }]));
  return ids.map((id) => byId.get(id)).filter((u): u is DirectoryUser => !!u);
}

/** Active (non-guest) members whose department matches, e.g. "Platform" for "the platform team". */
export async function listByDepartment(ctx: Ctx, department: string, limit = 50): Promise<DirectoryUser[]> {
  const members = await db.organizationMember.findMany({
    where: {
      organizationId: ctx.organizationId,
      role: { not: "GUEST" },
      user: { isActive: true, department: { contains: department.trim(), mode: "insensitive" } },
    },
    include: {
      user: { select: { id: true, displayName: true, email: true, title: true, department: true, timezone: true } },
    },
    orderBy: { user: { displayName: "asc" } },
    take: limit,
  });
  return members.map((m) => ({ ...m.user, role: m.role }));
}
