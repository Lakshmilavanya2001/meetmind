import { describe, expect, it } from "vitest";
import { generateHumanCode, generateToken, hashToken } from "@/server/auth/tokens";
import { hasOrgRole, requireOrgRole } from "@/server/auth/permissions";
import { rateLimit } from "@/server/rate-limit";
import { isValidTimeZone, signupSchema, profileUpdateSchema } from "@/lib/validation";

describe("tokens", () => {
  it("generates unguessable, unique tokens and stable hashes", () => {
    const a = generateToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(generateToken()).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toContain(a);
  });

  it("formats human codes without ambiguous characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateHumanCode();
      expect(code).toMatch(/^[a-km-z]{3}-[a-km-z]{4}-[a-km-z]{3}$/);
    }
  });
});

describe("validation", () => {
  const base = { displayName: "Ann Lee", email: " Ann@Example.COM ", password: "long-enough-pw", timezone: "Asia/Kolkata" };

  it("normalises email and requires a workspace name when creating", () => {
    expect(signupSchema.safeParse({ ...base, workspaceMode: "create" }).success).toBe(false);
    const ok = signupSchema.parse({ ...base, workspaceMode: "create", workspaceName: "Acme" });
    expect(ok.email).toBe("ann@example.com");
  });

  it("requires a join code when joining", () => {
    const r = signupSchema.safeParse({ ...base, workspaceMode: "join" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["joinCode"]);
  });

  it("rejects short passwords and unknown time zones", () => {
    expect(signupSchema.safeParse({ ...base, password: "short", workspaceMode: "create", workspaceName: "A1" }).success).toBe(false);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(profileUpdateSchema.safeParse({ displayName: "Ann", timezone: "Nope/Zone" }).success).toBe(false);
  });
});

describe("permissions", () => {
  it("ranks roles OWNER > ADMIN > MEMBER", () => {
    expect(hasOrgRole({ orgRole: "OWNER" }, "ADMIN")).toBe(true);
    expect(hasOrgRole({ orgRole: "ADMIN" }, "ADMIN")).toBe(true);
    expect(hasOrgRole({ orgRole: "MEMBER" }, "ADMIN")).toBe(false);
    expect(() => requireOrgRole({ orgRole: "MEMBER" }, "ADMIN")).toThrow(/admin/);
  });
});

describe("rate limiter", () => {
  it("blocks after the limit within a window", () => {
    for (let i = 0; i < 3; i++) rateLimit("k", 3, 60_000);
    expect(() => rateLimit("k", 3, 60_000)).toThrow(/Too many requests/);
    expect(() => rateLimit("other", 3, 60_000)).not.toThrow();
  });
});
