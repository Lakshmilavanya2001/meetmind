import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { changePassword, login, signup } from "@/server/services/auth";
import { createSession, destroySession, resolveSession } from "@/server/auth/session";
import { createOrg, createUser, loginAs, resetDb, TEST_PASSWORD } from "../helpers";

beforeEach(resetDb);

const newUser = { displayName: "Nina Ross", email: "nina@test.dev", password: "a-strong-password", timezone: "Europe/Berlin" };

describe("signup", () => {
  it("creates a workspace with the new user as owner", async () => {
    const { userId, organizationId } = await signup({ ...newUser, workspaceMode: "create", workspaceName: "Ross Labs" });
    const m = await db.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId, userId } } });
    expect(m.role).toBe("OWNER");
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.passwordHash).not.toContain("a-strong-password");
    expect(user.timezone).toBe("Europe/Berlin");
  });

  it("joins an existing workspace as member with a valid join code", async () => {
    const org = await createOrg();
    const { organizationId } = await signup({ ...newUser, workspaceMode: "join", joinCode: org.joinCode.toUpperCase() });
    expect(organizationId).toBe(org.id);
  });

  it("rejects an invalid join code and duplicate emails", async () => {
    await expect(signup({ ...newUser, workspaceMode: "join", joinCode: "nope-nope" })).rejects.toMatchObject({ code: "VALIDATION" });
    await signup({ ...newUser, workspaceMode: "create", workspaceName: "One" });
    await expect(signup({ ...newUser, email: "NINA@test.dev", workspaceMode: "create", workspaceName: "Two" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("login", () => {
  it("accepts correct credentials case-insensitively on email", async () => {
    const org = await createOrg();
    const u = await createUser(org.id, "Leo Park", { email: "leo@test.dev" });
    await expect(login({ email: "LEO@test.dev", password: TEST_PASSWORD })).resolves.toEqual({ userId: u.id, organizationId: org.id });
  });

  it("gives the same error for unknown email and wrong password", async () => {
    const org = await createOrg();
    await createUser(org.id, "Leo Park", { email: "leo@test.dev" });
    const a = await login({ email: "leo@test.dev", password: "wrong-password" }).catch((e) => e);
    const b = await login({ email: "ghost@test.dev", password: "wrong-password" }).catch((e) => e);
    expect(a.message).toBe(b.message);
    expect(a.code).toBe("UNAUTHENTICATED");
  });

  it("refuses deactivated users and rate-limits brute force", async () => {
    const org = await createOrg();
    await createUser(org.id, "Old Timer", { email: "old@test.dev", isActive: false });
    await expect(login({ email: "old@test.dev", password: TEST_PASSWORD })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    for (let i = 0; i < 7; i++) await login({ email: "old@test.dev", password: "x" }).catch(() => {});
    await expect(login({ email: "old@test.dev", password: "x" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("sessions", () => {
  it("resolves a valid session and stores only the token hash", async () => {
    const org = await createOrg();
    const u = await createUser(org.id, "Sam Wu", { role: "ADMIN" });
    const { token, ctx } = await loginAs(u.id, org.id);
    expect(ctx).toMatchObject({ userId: u.id, organizationId: org.id, orgRole: "ADMIN" });
    expect(await db.session.count({ where: { tokenHash: token } })).toBe(0);
  });

  it("rejects unknown, expired and logged-out sessions", async () => {
    const org = await createOrg();
    const u = await createUser(org.id, "Sam Wu");
    expect(await resolveSession("not-a-real-token")).toBeNull();
    const { token } = await createSession({ userId: u.id, organizationId: org.id });
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(token)).toBeNull();
    const second = await createSession({ userId: u.id, organizationId: org.id });
    await destroySession(second.token);
    expect(await resolveSession(second.token)).toBeNull();
  });

  it("stops working as soon as workspace membership is removed", async () => {
    const org = await createOrg();
    const u = await createUser(org.id, "Sam Wu");
    const { token } = await loginAs(u.id, org.id);
    await db.organizationMember.deleteMany({ where: { userId: u.id } });
    expect(await resolveSession(token)).toBeNull();
  });

  it("password change signs out other sessions only", async () => {
    const org = await createOrg();
    const u = await createUser(org.id, "Sam Wu");
    const current = await loginAs(u.id, org.id);
    const other = await loginAs(u.id, org.id);
    await expect(changePassword(current.ctx, { currentPassword: "wrong", newPassword: "another-long-pw" })).rejects.toMatchObject({ code: "VALIDATION" });
    await changePassword(current.ctx, { currentPassword: TEST_PASSWORD, newPassword: "another-long-pw" });
    expect(await resolveSession(current.token)).not.toBeNull();
    expect(await resolveSession(other.token)).toBeNull();
    await expect(login({ email: u.email, password: "another-long-pw" })).resolves.toBeTruthy();
  });
});
