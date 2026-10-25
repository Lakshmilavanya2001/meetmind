import path from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD } from "./helpers";

// A (English) says 8 sentences with short pauses (e2e/fixtures/monologue-en.wav, Magpie voice Jason); B listens in Hindi
// with original voices "Muted" (the default). B must receive only the interpreter's Hindi voice, not A's original —
// also after reloading mid-call — and each sentence must come out as one line (Parakeet can split sentences itself).
test.setTimeout(240_000);
const launch = (file: string) => chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.resolve(file)}`, "--autoplay-policy=no-user-gesture-required"] });
async function signIn(browser: Browser, email: string, baseURL: string) {
  const page = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return page;
}
// Audio the page is actually playing: one entry per <audio> element with a live track.
const playing = (p: Page) => p.evaluate(() => [...document.querySelectorAll("audio")].filter((a) => (a.srcObject as MediaStream | null)?.getAudioTracks().some((t) => t.readyState === "live")).length);

test("interpreter: the listener hears only the translation (also after a reload); each sentence is one line", async ({ baseURL }) => {
  const [ba, bb] = await Promise.all([launch("e2e/fixtures/monologue-en.wav"), launch("e2e/fixtures/silence.wav")]);
  try {
    const a = await signIn(ba, "priya@acme.test", baseURL!);
    const b = await signIn(bb, "amit@acme.test", baseURL!);
    await a.getByRole("button", { name: "Start a meeting" }).click();
    await expect(a).toHaveURL(/\/m\//);
    const code = a.url().split("/m/")[1];
    await a.getByRole("button", { name: "Join now" }).click();
    await b.goto(`/m/${code}`);
    await b.getByRole("button", { name: "Join now" }).click();
    for (const p of [a, b]) await expect(p.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
    await a.getByRole("button", { name: /^AI interpreter/ }).click();
    await a.getByRole("menuitem", { name: "English" }).click();
    await b.getByRole("button", { name: /^AI interpreter/ }).click();
    await b.getByRole("menuitem", { name: /Hindi/ }).click();
    const panelB = b.getByRole("region", { name: "Live interpretation" });
    await expect(panelB.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 90_000 });
    await b.waitForTimeout(3000);
    const before = await playing(b);
    console.log("[audio playing for B before reload]", before);

    // The listener reloads mid-call (the case where muting used to be lost).
    await b.reload();
    await b.getByRole("button", { name: "Join now" }).click();
    await expect(b.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
    // The interpreter was already in the call when B rejoined: the panel must show it (not "joining") and new lines.
    const panelAfter = b.getByRole("region", { name: "Live interpretation" });
    await expect(panelAfter.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 30_000 });
    await expect(panelAfter).not.toContainText("The interpreter is joining the call");
    await b.waitForTimeout(3000);
    const after = await playing(b);
    console.log("[audio playing for B after reload]", after);

    // Control: with "Full volume" the original voice is received too.
    await b.getByRole("button", { name: /^AI interpreter/ }).click();
    await b.getByRole("menuitem", { name: /Full volume/ }).click();
    await b.keyboard.press("Escape");
    await b.waitForTimeout(3000);
    const full = await playing(b);
    console.log("[audio playing for B with Full volume]", full);
    expect(full).toBe(2);
    await a.waitForTimeout(25_000); // let the monologue finish
    const t = await (await a.request.get(`/api/meetings/${code}/transcript`)).json();
    const mine = t.segments.filter((s: { speakerLabel: string }) => s.speakerLabel === "Priya Patel");
    expect(mine.length).toBeGreaterThanOrEqual(7);
    expect(mine.length).toBeLessThanOrEqual(9);
    expect(mine.every((s: { startMs: number; endMs: number }) => s.endMs - s.startMs >= 1000)).toBe(true); // no fragments with guessed times
    console.log("[lines from the monologue]", mine.length, JSON.stringify(mine.map((s: { startMs: number; endMs: number; text: string }) => [Math.round(s.startMs / 100) / 10, Math.round(s.endMs / 100) / 10, s.text.split(" ").length])));
    const lat = await (await a.request.get(`/api/meetings/${code}/interpretation/latency`)).json();
    console.log("[latency]", JSON.stringify(lat.overall));
    expect(before).toBe(1);
    expect(after).toBe(1);
  } finally {
    await Promise.all([ba.close(), bb.close()]);
  }
});
