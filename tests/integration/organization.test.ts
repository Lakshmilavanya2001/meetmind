import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { changeMemberRole, getWorkspace, regenerateJoinCode, removeMember, updateWorkspaceSettings } from "@/server/services/organization";
import { resolveSession } from "@/server/auth/session";
import { createOrg, createUser, loginAs, resetDb } from "../helpers";

beforeEach(resetDb);

async function setup() {
  const org = await createOrg();
  const owner = await createUser(org.id, "Olive Owner", { role: "OWNER" });
  const admin = await createUser(org.id, "Adam Admin", { role: "ADMIN" });
  const member = await createUser(org.id, "Mia Member");
  const ctx = (u: { id: string }, orgRole: "OWNER" | "ADMIN" | "MEMBER") => ({ userId: u.id, organizationId: org.id, orgRole });
  return { org, owner, admin, member, ctx };
}

describe("workspace administration", () => {
  it("hides the join code from members", async () => {
    const { owner, member, ctx } = await setup();
    expect((await getWorkspace(ctx(member, "MEMBER"))).joinCode).toBeNull();
    expect((await getWorkspace(ctx(owner, "OWNER"))).joinCode).toBeTruthy();
  });

  it("members cannot change settings, roles or the join code", async () => {
    const { admin, member, ctx } = await setup();
    const m = ctx(member, "MEMBER");
    await expect(updateWorkspaceSettings(m, { allowExternalInvites: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(changeMemberRole(m, admin.id, { role: "MEMBER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(regenerateJoinCode(m)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admins cannot grant or remove the owner role", async () => {
    const { owner, admin, member, ctx } = await setup();
    await expect(changeMemberRole(ctx(admin, "ADMIN"), member.id, { role: "OWNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(changeMemberRole(ctx(admin, "ADMIN"), owner.id, { role: "MEMBER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await changeMemberRole(ctx(admin, "ADMIN"), member.id, { role: "ADMIN" });
  });

  it("keeps at least one owner", async () => {
    const { owner, ctx } = await setup();
    await expect(changeMemberRole(ctx(owner, "OWNER"), owner.id, { role: "ADMIN" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("removing a member ends their sessions", async () => {
    const { org, admin, member, ctx } = await setup();
    const { token } = await loginAs(member.id, org.id);
    await removeMember(ctx(admin, "ADMIN"), member.id);
    expect(await resolveSession(token)).toBeNull();
    expect(await db.auditLog.count({ where: { action: "member.remove" } })).toBe(1);
  });

  it("cannot act on users from another workspace", async () => {
    const { owner, ctx } = await setup();
    const other = await createOrg("Other");
    const outsider = await createUser(other.id, "Out Sider");
    await expect(changeMemberRole(ctx(owner, "OWNER"), outsider.id, { role: "ADMIN" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(removeMember(ctx(owner, "OWNER"), outsider.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
