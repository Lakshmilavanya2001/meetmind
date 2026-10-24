import type { OrgRole } from "@/generated/prisma/enums";
import { AppError } from "../errors";
import type { AuthContext } from "./session";

const RANK: Record<OrgRole, number> = { GUEST: -1, MEMBER: 0, ADMIN: 1, OWNER: 2 };

export const hasOrgRole = (ctx: Pick<AuthContext, "orgRole">, min: OrgRole) =>
  RANK[ctx.orgRole] >= RANK[min];

/** Guests (external invitees) may only use meetings they were invited to. */
export function requireMember(ctx: Pick<AuthContext, "orgRole">) {
  if (ctx.orgRole === "GUEST") {
    throw new AppError("FORBIDDEN", "Guests can only access meetings they were invited to.");
  }
}

export function requireOrgRole(ctx: Pick<AuthContext, "orgRole">, min: OrgRole) {
  if (!hasOrgRole(ctx, min)) {
    throw new AppError("FORBIDDEN", `This action requires the ${min.toLowerCase()} role.`);
  }
}
