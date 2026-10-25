import path from "node:path";
import { chromium, expect, test, type Browser } from "@playwright/test";
import { PASSWORD } from "./helpers";

// Two callers, each on their own browser with their own fake microphone:
// A speaks English ("Hello Priya. Can we move the launch review to Friday at three in the afternoon?"),
// B speaks Hindi ("हाँ, शुक्रवार दोपहर तीन बजे ठीक है। मैं टीम को बता दूँगी।"). The AI interpreter joins the call.
test.setTimeout(240_000);

const launch = (file: string) =>
  chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.resolve(file)}`, "--autoplay-policy=no-user-gesture-required"],
  });
async function signIn(browser: Browser, email: string, baseURL: string) {
  const page = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return page;
}

test("AI interpreter: English ↔ Hindi between two callers, with latency", async ({ baseURL }) => {
  const [ba, bb] = await Promise.all([launch("e2e/fixtures/caller-en.wav"), launch("e2e/fixtures/caller-hi.wav")]);
  try {
    const a = await signIn(ba, "aisha@acme.test", baseURL!);
    const b = await signIn(bb, "rahul.sharma@acme.test", baseURL!);

    await a.getByRole("button", { name: "Start a meeting" }).click();
    await expect(a).toHaveURL(/\/m\//);
    const code = a.url().split("/m/")[1];
    await a.getByRole("button", { name: "Join now" }).click();
    await b.goto(`/m/${code}`);
    await b.getByRole("button", { name: "Join now" }).click();
    for (const p of [a, b]) await expect(p.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();

    // Each caller just picks their language: that opts their voice in and switches the interpreter on.
    await a.getByRole("button", { name: /^AI interpreter/ }).click();
    await a.getByRole("menuitem", { name: "English" }).click();
    await b.getByRole("button", { name: /^AI interpreter/ }).click();
    await b.getByRole("menuitem", { name: /Hindi/ }).click();
    await expect(a.getByRole("button", { name: "AI interpreter: On, you hear English" })).toBeVisible();


    // The interpreter joins the call as a participant.
    const panelA = a.getByRole("region", { name: "Live interpretation" });
    const panelB = b.getByRole("region", { name: "Live interpretation" });
    await expect(panelB).toContainText("AI interpreter · you hear हिन्दी (Hindi)", { timeout: 30_000 });
    await expect(panelB).not.toContainText("joining", { timeout: 30_000 });

    // A's English reaches B in Hindi (spoken), and B's Hindi reaches A in English (spoken).
    await expect(panelB.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 90_000 });
    await expect(panelB.locator('p[lang="hi"]').first()).toContainText(/[ऀ-ॿ]{3}/);
    await expect(panelA.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 90_000 });
    await expect(panelA.locator('p[lang="en"]').first()).toContainText(/friday|three|team|okay|fine/i);

    // Latency report for the meeting.
    const report = await (await a.request.get(`/api/meetings/${code}/interpretation/latency`)).json();
    console.log("[latency]", JSON.stringify(report.overall), JSON.stringify(report.byPair.map((p: { pair: string; avgMs: number; count: number }) => [p.pair, p.avgMs, p.count])));
    expect(report.overall.count).toBeGreaterThan(0);
    expect(report.byPair.map((p: { pair: string }) => p.pair)).toEqual(expect.arrayContaining(["en→hi", "hi→en"]));
    // The same report appears on the meeting page.
    await a.goto(`/meetings/${code}`);
    await expect(a.getByText("AI interpreter latency")).toBeVisible();
    await expect(a.getByLabel("Latency summary")).toContainText(/Average\s*\d+\.\d\d s/);
    await a.screenshot({ path: "test-results/interpreter-report.png", fullPage: true });
    await a.screenshot({ path: "test-results/interpreter-a.png" });
    await b.screenshot({ path: "test-results/interpreter-b.png" });
  } finally {
    await Promise.all([ba.close(), bb.close()]);
  }
});

test("conference: one English speaker, Hindi and Spanish listeners each hear their own language", async ({ baseURL }) => {
  const [ba, bb, bc] = await Promise.all([launch("e2e/fixtures/caller-en.wav"), launch("e2e/fixtures/silence.wav"), launch("e2e/fixtures/silence.wav")]);
  try {
    const a = await signIn(ba, "rahul.verma@acme.test", baseURL!);
    const b = await signIn(bb, "rahul.s@acme.test", baseURL!);
    const c = await signIn(bc, "amit@acme.test", baseURL!);
    await a.getByRole("button", { name: "Start a meeting" }).click();
    await expect(a).toHaveURL(/\/m\//);
    const code = a.url().split("/m/")[1];
    await a.getByRole("button", { name: "Join now" }).click();
    for (const p of [b, c]) {
      await p.goto(`/m/${code}`);
      await p.getByRole("button", { name: "Join now" }).click();
    }
    for (const p of [a, b, c]) await expect(p.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
    for (const [p, lang] of [[a, "English"], [b, /Hindi/], [c, /Spanish/]] as const) {
      await p.getByRole("button", { name: /^AI interpreter/ }).click();
      await p.getByRole("menuitem", { name: lang }).click();
    }

    const panelB = b.getByRole("region", { name: "Live interpretation" });
    const panelC = c.getByRole("region", { name: "Live interpretation" });
    await expect(panelB.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 90_000 });
    await expect(panelB.locator('p[lang="hi"]').first()).toContainText(/[\u0900-\u097F]{3}/);
    await expect(panelC.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 90_000 });
    await expect(panelC.locator('p[lang="es"]').first()).toContainText(/viernes|tres|tarde|lanzamiento/i);
    const report = await (await a.request.get(`/api/meetings/${code}/interpretation/latency`)).json();
    console.log("[conference latency]", JSON.stringify(report.byPair.map((p: { pair: string; avgMs: number; count: number }) => [p.pair, p.avgMs, p.count])));
    expect(report.byPair.map((p: { pair: string }) => p.pair)).toEqual(expect.arrayContaining(["en→hi", "en→es"]));
  } finally {
    await Promise.all([ba.close(), bb.close(), bc.close()]);
  }
});

test("Hindi speaker heard in French (Parakeet recognition, Magpie voice)", async ({ baseURL }) => {
  const [ba, bb] = await Promise.all([launch("e2e/fixtures/caller-hi.wav"), launch("e2e/fixtures/silence.wav")]);
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
    await a.getByRole("menuitem", { name: /Hindi/ }).click(); // picking a language turns the interpreter on
    await b.getByRole("button", { name: /^AI interpreter/ }).click();
    await b.getByRole("menuitem", { name: /French/ }).click();

    const panelB = b.getByRole("region", { name: "Live interpretation" });
    await expect(panelB.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 90_000 });
    await expect(panelB.locator('p[lang="fr"]').first()).toContainText(/[a-zà-ÿ]{3}/i);
    await expect(panelB.locator('p[lang="hi"]').first()).toContainText(/[ऀ-ॿ]{3}/); // the Hindi original underneath
    const report = await (await a.request.get(`/api/meetings/${code}/interpretation/latency`)).json();
    console.log("[hindi→french latency]", JSON.stringify(report.byPair.map((p: { pair: string; avgMs: number; avgAsrMs: number; avgMtMs: number; avgTtsMs: number }) => [p.pair, p.avgMs, p.avgAsrMs, p.avgMtMs, p.avgTtsMs])));
    expect(report.byPair.map((p: { pair: string }) => p.pair)).toContain("hi→fr");
    await b.screenshot({ path: "test-results/interpreter-hindi-french.png" });
  } finally {
    await Promise.all([ba.close(), bb.close()]);
  }
});

