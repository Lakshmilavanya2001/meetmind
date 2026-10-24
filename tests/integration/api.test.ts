import { beforeEach, describe, expect, it } from "vitest";
import { GET as searchUsers } from "@/app/api/users/route";
import { GET as resolveUsers } from "@/app/api/users/resolve/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { PATCH as patchMember } from "@/app/api/workspace/members/[userId]/route";
import { createOrg, createUser, loginAs, noParams, request, resetDb, TEST_PASSWORD, withParams } from "../helpers";

beforeEach(resetDb);

describe("REST API", () => {
  it("rejects unauthenticated requests with 401 JSON", async () => {
    const res = await searchUsers(request("/api/users?q=a"), noParams);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("login sets an httpOnly session cookie that authenticates later requests", async () => {
    const org = await createOrg();
    await createUser(org.id, "Zoe Quinn", { email: "zoe@test.dev" });
    const res = await loginRoute(request("/api/auth/login", { method: "POST", json: { email: "zoe@test.dev", password: TEST_PASSWORD } }), noParams);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/mm_session=/);
    expect(cookie.toLowerCase()).toContain("httponly");
    const token = /mm_session=([^;]+)/.exec(cookie)![1];
    const search = await searchUsers(request("/api/users?q=zoe", { token }), noParams);
    expect((await search.json()).users[0].email).toBe("zoe@test.dev");
  });

  it("returns field-level validation errors", async () => {
    const res = await signupRoute(request("/api/auth/signup", { method: "POST", json: { email: "bad", password: "x", workspaceMode: "create" } }), noParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.fields).toHaveProperty("email");
    expect(body.error.fields).toHaveProperty("password");
  });

  it("rejects cross-origin state-changing requests", async () => {
    const org = await createOrg();
    const u = await createUser(org.id, "Zoe Quinn");
    const { token } = await loginAs(u.id, org.id);
    const res = await patchProfile(
      request("/api/profile", { method: "PATCH", token, origin: "https://evil.example", json: { displayName: "Hacked", timezone: "UTC" } }),
      noParams,
    );
    expect(res.status).toBe(403);
  });

  it("enforces roles server-side regardless of UI", async () => {
    const org = await createOrg();
    const owner = await createUser(org.id, "Olive Owner", { role: "OWNER" });
    const member = await createUser(org.id, "Mia Member");
    const { token } = await loginAs(member.id, org.id);
    const res = await patchMember(request(`/api/workspace/members/${owner.id}`, { method: "PATCH", token, json: { role: "MEMBER" } }), withParams({ userId: owner.id }));
    expect(res.status).toBe(403);
  });

  it("resolve endpoint surfaces ambiguity instead of picking someone", async () => {
    const org = await createOrg();
    const me = await createUser(org.id, "Me Myself");
    await createUser(org.id, "Rahul Sharma");
    await createUser(org.id, "Rahul Sharma");
    const { token } = await loginAs(me.id, org.id);
    const res = await resolveUsers(request("/api/users/resolve?name=Rahul%20Sharma", { token }), noParams);
    const body = await res.json();
    expect(body.status).toBe("ambiguous");
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].email).not.toBe(body.candidates[1].email);
  });

  it("does not leak internal errors", async () => {
    const org = await createOrg();
    const u = await createUser(org.id, "Zoe Quinn");
    const { token } = await loginAs(u.id, org.id);
    const res = await patchProfile(request("/api/profile", { method: "PATCH", token, json: { displayName: "Zoe", timezone: "Bad/Zone" } }), noParams);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/prisma|stack|at \w+ \(/i);
  });
});
