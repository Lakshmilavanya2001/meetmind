import { beforeEach, describe, expect, it } from "vitest";
import { getDirectoryUsers, resolveUser, searchDirectory } from "@/server/services/directory";
import { createOrg, createUser, resetDb } from "../helpers";

let acme: { id: string };
let globex: { id: string };
const ids: Record<string, string> = {};

beforeEach(async () => {
  await resetDb();
  acme = await createOrg("Acme");
  globex = await createOrg("Globex");
  ids.rahulA = (await createUser(acme.id, "Rahul Sharma", { email: "rahul.sharma@acme.test" })).id;
  ids.rahulB = (await createUser(acme.id, "Rahul Sharma", { email: "rahul.s@acme.test" })).id;
  ids.rahulV = (await createUser(acme.id, "Rahul Verma")).id;
  ids.priya = (await createUser(acme.id, "Priya Patel")).id;
  ids.amit = (await createUser(acme.id, "Amit Kumar")).id;
  ids.inactive = (await createUser(acme.id, "Priya Old", { isActive: false })).id;
  ids.globexRahul = (await createUser(globex.id, "Rahul Mehta")).id;
});

describe("searchDirectory", () => {
  it("matches on any name token or email, ranked by closeness", async () => {
    const res = await searchDirectory({ organizationId: acme.id }, "rahul");
    expect(res.map((u) => u.displayName)).toEqual(["Rahul Sharma", "Rahul Sharma", "Rahul Verma"]);
    expect((await searchDirectory({ organizationId: acme.id }, "acme.test")).length).toBe(2);
  });

  it("never returns people from another workspace or deactivated users", async () => {
    expect(await searchDirectory({ organizationId: acme.id }, "Mehta")).toEqual([]);
    expect(await searchDirectory({ organizationId: acme.id }, "Priya Old")).toEqual([]);
    const all = await searchDirectory({ organizationId: acme.id }, "");
    expect(all).toHaveLength(5);
  });
});

describe("resolveUser — never guesses between people", () => {
  const ctx = () => ({ organizationId: acme.id });

  it("resolves a unique name", async () => {
    const r = await resolveUser(ctx(), "Priya");
    expect(r).toMatchObject({ status: "resolved", user: { id: ids.priya } });
  });

  it("reports ambiguity when two people share the exact same name", async () => {
    const r = await resolveUser(ctx(), "rahul sharma");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates.map((c) => c.id).sort()).toEqual([ids.rahulA, ids.rahulB].sort());
  });

  it("reports ambiguity for a first name shared by several people", async () => {
    const r = await resolveUser(ctx(), "Rahul");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates).toHaveLength(3);
  });

  it("resolves an exact email even when the name is shared", async () => {
    const r = await resolveUser(ctx(), "rahul.s@acme.test");
    expect(r).toMatchObject({ status: "resolved", user: { id: ids.rahulB } });
  });

  it("returns typo suggestions but does not auto-select them", async () => {
    const r = await resolveUser(ctx(), "Pria Patell");
    expect(r.status).toBe("not_found");
    if (r.status === "not_found") expect(r.suggestions.map((s) => s.id)).toContain(ids.priya);
  });

  it("does not resolve people from other workspaces", async () => {
    const r = await resolveUser(ctx(), "Rahul Mehta");
    expect(r.status).not.toBe("resolved");
    if (r.status === "not_found") expect(r.suggestions.map((s) => s.id)).not.toContain(ids.globexRahul);
  });

  it("getDirectoryUsers drops ids outside the caller's workspace", async () => {
    const users = await getDirectoryUsers(ctx(), [ids.priya, ids.globexRahul, ids.inactive]);
    expect(users.map((u) => u.id)).toEqual([ids.priya]);
  });
});
