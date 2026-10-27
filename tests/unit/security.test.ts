import { globSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { decryptJson, decryptSecret, encryptJson, encryptSecret } from "@/server/crypto";
import { clientIp } from "@/server/http";

describe("every API route is authenticated unless explicitly public", () => {
  // Anything added here must be deliberately unauthenticated (and protected some other way).
  const PUBLIC = new Map([
    ["src/app/api/auth/login/route.ts", "credentials + rate limits"],
    ["src/app/api/auth/signup/route.ts", "rate limited; join code required to join a workspace"],
    ["src/app/api/auth/logout/route.ts", "only deletes the caller's own session"],
    ["src/app/api/health/route.ts", "no data beyond up/down + configured flags"],
    ["src/app/api/invite/[token]/route.ts", "256-bit invite token, rate limited"],
    ["src/app/api/invite/[token]/signup/route.ts", "256-bit invite token; email taken from the invite"],
    ["src/app/api/livekit/webhook/route.ts", "LiveKit-signed JWT with body hash"],
    ["src/app/api/integrations/uber/callback/route.ts", "Uber redirects here: checks the session itself and a one-time state cookie bound to that user"],
  ]);

  it("wraps handlers with authed() or is on the public allowlist", () => {
    const routes = globSync("src/app/api/**/route.ts");
    expect(routes.length).toBeGreaterThan(30);
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      const handlers = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*(\w+)/g)];
      expect(handlers.length, file).toBeGreaterThan(0);
      for (const [, method, wrapper] of handlers) {
        if (PUBLIC.has(file)) expect(wrapper, `${method} ${file}`).toBe("open");
        else expect(wrapper, `${method} ${file} must use authed()`).toBe("authed");
      }
    }
  });
});

describe("secrets at rest", () => {
  const env = { ENCRYPTION_KEY: randomBytes(32).toString("base64") };

  it("round-trips with AES-256-GCM and a fresh IV each time", () => {
    const a = encryptSecret("client-secret-123", env);
    const b = encryptSecret("client-secret-123", env);
    expect(a).not.toBe(b);
    expect(a).not.toContain("client-secret");
    expect(decryptSecret(a, env)).toBe("client-secret-123");
    expect(decryptJson<{ token: string }>(encryptJson({ token: "t" }, env), env)).toEqual({ token: "t" });
  });

  it("detects tampering and wrong keys; refuses weak keys", () => {
    const enc = encryptSecret("x", env);
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), env)).toThrow(/decrypt/);
    expect(() => decryptSecret(enc, { ENCRYPTION_KEY: randomBytes(32).toString("base64") })).toThrow(/decrypt/);
    expect(() => encryptSecret("x", { ENCRYPTION_KEY: "short" })).toThrow(/32 random bytes/);
  });
});

describe("client IP for rate limiting", () => {
  const req = (xff: string) => new NextRequest("http://x/api", { headers: { "x-forwarded-for": xff } });

  it("ignores X-Forwarded-For unless the proxy is trusted, then uses the proxy-appended hop", () => {
    delete process.env.TRUST_PROXY;
    expect(clientIp(req("1.2.3.4"))).toBeNull();
    process.env.TRUST_PROXY = "true";
    // A client can prepend fake hops; our proxy appends the real address last.
    expect(clientIp(req("6.6.6.6, 10.0.0.7"))).toBe("10.0.0.7");
    delete process.env.TRUST_PROXY;
  });
});
