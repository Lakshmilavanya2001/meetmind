import { describe, expect, it, vi } from "vitest";
import { createSmtpProvider, escapeHtml, isTransientSmtpError, readSmtpConfig } from "@/server/providers/email";

const config = { host: "smtp.test", port: 465, user: "u@test.dev", password: "x", from: "MeetMind <u@test.dev>" };
const fakeTransport = (sendMail: ReturnType<typeof vi.fn>) => ({ sendMail, verify: vi.fn() }) as never;

describe("email provider", () => {
  it("is not configured without host/user/password", () => {
    expect(readSmtpConfig({})).toBeNull();
    expect(readSmtpConfig({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASSWORD: "p" })).toMatchObject({ port: 465, from: "u" });
  });

  it("sends from the configured address", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<1@test>" });
    const p = createSmtpProvider(config, fakeTransport(sendMail), { backoffMs: 0 });
    await expect(p.send({ to: "a@b.dev", subject: "Hi", text: "Hello" })).resolves.toEqual({ messageId: "<1@test>" });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: config.from, to: "a@b.dev" }));
  });

  it("retries transient failures, then succeeds", async () => {
    const sendMail = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { responseCode: 421 }))
      .mockResolvedValue({ messageId: "<2@test>" });
    const p = createSmtpProvider(config, fakeTransport(sendMail), { backoffMs: 0 });
    await expect(p.send({ to: "a@b.dev", subject: "s", text: "t" })).resolves.toEqual({ messageId: "<2@test>" });
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("does not retry auth failures and returns a safe error", async () => {
    const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error("535 bad creds secret-detail"), { code: "EAUTH", responseCode: 535 }));
    const p = createSmtpProvider(config, fakeTransport(sendMail), { backoffMs: 0 });
    const err = await p.send({ to: "a@b.dev", subject: "s", text: "t" }).catch((e) => e);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(err.message).not.toContain("secret-detail");
  });

  it("stops contacting the server after an authentication failure", async () => {
    const sendMail = vi.fn().mockRejectedValue(Object.assign(new Error("535"), { code: "EAUTH", responseCode: 535 }));
    const p = createSmtpProvider(config, fakeTransport(sendMail), { backoffMs: 0 });
    await p.send({ to: "a@b.dev", subject: "s", text: "t" }).catch(() => {});
    await expect(p.send({ to: "c@d.dev", subject: "s", text: "t" })).rejects.toThrow(/temporarily disabled/);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid recipients before contacting the server", async () => {
    const sendMail = vi.fn();
    const p = createSmtpProvider(config, fakeTransport(sendMail));
    await expect(p.send({ to: "not-an-email\r\nBcc: x@y.z", subject: "s", text: "t" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("classifies errors and escapes HTML", () => {
    expect(isTransientSmtpError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientSmtpError({ responseCode: 550 })).toBe(false);
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
  });
});
