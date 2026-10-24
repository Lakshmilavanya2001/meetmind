import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import { requireMember, requireOrgRole } from "../auth/permissions";
import type { AuthContext } from "../auth/session";
import { generateHumanCode } from "../auth/tokens";
import { memberRoleSchema, workspaceSettingsSchema } from "@/lib/validation";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole">;

export async function getWorkspace(ctx: Ctx) {
  requireMember(ctx);
  const org = await db.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    include: { _count: { select: { members: true } } },
  });
  const isAdmin = ctx.orgRole !== "MEMBER";
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    memberCount: org._count.members,
    // Only admins see the join code — it grants access to the workspace.
    joinCode: isAdmin ? org.joinCode : null,
    allowExternalInvites: org.allowExternalInvites,
    agentAutoExecute: org.agentAutoExecute,
    transcriptRetentionDays: org.transcriptRetentionDays,
    recordingRetentionDays: org.recordingRetentionDays,
  };
}

export async function updateWorkspaceSettings(ctx: Ctx, raw: unknown) {
  requireOrgRole(ctx, "ADMIN");
  const input = workspaceSettingsSchema.parse(raw);
  await db.organization.update({ where: { id: ctx.organizationId }, data: input });
  await audit({
    action: "workspace.settings_update",
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    metadata: input,
  });
  return getWorkspace(ctx);
}

export async function regenerateJoinCode(ctx: Ctx) {
  requireOrgRole(ctx, "ADMIN");
  const joinCode = generateHumanCode([4, 4]);
  await db.organization.update({ where: { id: ctx.organizationId }, data: { joinCode } });
  await audit({ action: "workspace.join_code_regenerate", actorUserId: ctx.userId, organizationId: ctx.organizationId });
  return joinCode;
}

async function getMemberOrThrow(ctx: Ctx, userId: string) {
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: ctx.organizationId, userId } },
  });
  if (!member) throw new AppError("NOT_FOUND", "That person is not a member of this workspace.");
  return member;
}

async function assertNotLastOwner(ctx: Ctx, userId: string) {
  const owners = await db.organizationMember.count({
    where: { organizationId: ctx.organizationId, role: "OWNER", userId: { not: userId } },
  });
  if (owners === 0) throw new AppError("CONFLICT", "A workspace must keep at least one owner.");
}

export async function changeMemberRole(ctx: Ctx, targetUserId: string, raw: unknown) {
  requireOrgRole(ctx, "ADMIN");
  const { role } = memberRoleSchema.parse(raw);
  const member = await getMemberOrThrow(ctx, targetUserId);
  // Only owners may create or demote owners.
  if ((role === "OWNER" || member.role === "OWNER") && ctx.orgRole !== "OWNER") {
    throw new AppError("FORBIDDEN", "Only owners can grant or remove the owner role.");
  }
  if (member.role === "OWNER" && role !== "OWNER") await assertNotLastOwner(ctx, targetUserId);

  await db.organizationMember.update({ where: { id: member.id }, data: { role } });
  await audit({
    action: "member.role_change",
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    targetType: "User",
    targetId: targetUserId,
    metadata: { from: member.role, to: role },
  });
}

export async function removeMember(ctx: Ctx, targetUserId: string) {
  requireOrgRole(ctx, "ADMIN");
  const member = await getMemberOrThrow(ctx, targetUserId);
  if (member.role === "OWNER") {
    if (ctx.orgRole !== "OWNER") throw new AppError("FORBIDDEN", "Only owners can remove an owner.");
    await assertNotLastOwner(ctx, targetUserId);
  }
  await db.$transaction([
    db.organizationMember.delete({ where: { id: member.id } }),
    // Withdraw their invitations (incl. emailed guest links) to this workspace's meetings.
    db.meetingInvitation.updateMany({ where: { inviteeUserId: targetUserId, meeting: { organizationId: ctx.organizationId }, status: { in: ["PENDING", "ACCEPTED"] } }, data: { status: "REVOKED" } }),
    // End their sessions in this workspace immediately.
    db.session.deleteMany({ where: { userId: targetUserId, activeOrganizationId: ctx.organizationId } }),
  ]);
  await audit({
    action: "member.remove",
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    targetType: "User",
    targetId: targetUserId,
  });
}
