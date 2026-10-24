import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { PASSWORD } from "./helpers";

// An interpreted call: A picked Telugu, B picked Malayalam. A's fake microphone says (made with indic-speak):
// "హే మైండ్. ఈ కాల్‌లో ఎవరెవరు ఉన్నారు?" — "Hey Mind. Who is in this call?"
// The assistant must understand Telugu, answer A in Telugu, and the interpreter must NOT pass the command on to B.
test.setTimeout(240_000);

const launch = (file: string) =>
  chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.resolve(file)}`, "--autoplay-policy=no-user-gesture-required"],
  });

test("Hey Mind in Telugu during an interpreted call: answered in Telugu, not translated to the other caller", async ({ baseURL }) => {
  const [ba, bb] = await Promise.all([launch("e2e/fixtures/caller-te-heymind.wav"), launch("e2e/fixtures/silence.wav")]);
  try {
    const signIn = async (b: typeof ba, email: string) => {
      const page = await (await b.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/dashboard/);
      return page;
    };
    const a = await signIn(ba, "priya@acme.test");
    const b = await signIn(bb, "amit@acme.test");
    await a.getByRole("button", { name: "Start a meeting" }).click();
    await expect(a).toHaveURL(/\/m\//);
    const code = a.url().split("/m/")[1];
    await a.getByRole("button", { name: "Join now" }).click();
    await b.goto(`/m/${code}`);
    await b.getByRole("button", { name: "Join now" }).click();
    for (const p of [a, b]) await expect(p.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();

    // A listens for "Hey Mind" from the start (before that, A's speech is ordinary call speech and is translated).
    await a.getByRole("button", { name: "Listen for Hey Mind" }).click();

    // Each picks a language; that switches the interpreter on.
    await b.getByRole("button", { name: /^AI interpreter/ }).click();
    await b.getByRole("menuitem", { name: /Malayalam/ }).click();
    await a.getByRole("button", { name: /^AI interpreter/ }).click();
    await a.getByRole("menuitem", { name: /Telugu/ }).click();
    await expect(b.getByRole("region", { name: "Live interpretation" })).toContainText("AI interpreter", { timeout: 30_000 });

    // The assistant heard the Telugu command (wake phrase removed) and replied (in Telugu script).
    const card = a.getByRole("status").filter({ hasText: "You: “" });
    await expect(card).toContainText(/[ఀ-౿]{3}/, { timeout: 120_000 });
    await expect(card.locator("p").last()).not.toHaveText(/^You:/, { timeout: 120_000 });
    const reply = (await card.locator("p").last().textContent()) ?? "";
    console.log("[telugu reply]", reply);
    expect(reply).toMatch(/[ఀ-౿]/);
    await a.getByRole("button", { name: "Stop listening for Hey Mind" }).click();

    // B never got A's command translated into Malayalam.
    const panelB = b.getByRole("region", { name: "Live interpretation" });
    await expect(panelB).not.toContainText(/ఎవరెవరు|ആരൊക്കെ|ആരെല്ലാം/);
  } finally {
    await Promise.all([ba.close(), bb.close()]);
  }
});

test("ordinary speech from someone listening for Hey Mind is still translated (briefly held, then sent)", async ({ baseURL }) => {
  // A speaks English ("Hello Priya. Can we move the launch review to Friday at three in the afternoon?"), B listens in Hindi.
  const [ba, bb] = await Promise.all([launch("e2e/fixtures/caller-en.wav"), launch("e2e/fixtures/silence.wav")]);
  try {
    const signIn = async (b: typeof ba, email: string) => {
      const page = await (await b.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/dashboard/);
      return page;
    };
    const a = await signIn(ba, "rahul.verma@acme.test");
    const b = await signIn(bb, "priya@acme.test");
    await a.getByRole("button", { name: "Start a meeting" }).click();
    await expect(a).toHaveURL(/\/m\//);
    const code = a.url().split("/m/")[1];
    await a.getByRole("button", { name: "Join now" }).click();
    await b.goto(`/m/${code}`);
    await b.getByRole("button", { name: "Join now" }).click();
    for (const p of [a, b]) await expect(p.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
    await a.getByRole("button", { name: "Listen for Hey Mind" }).click();
    await b.getByRole("button", { name: /^AI interpreter/ }).click();
    await b.getByRole("menuitem", { name: /Hindi/ }).click();
    await a.getByRole("button", { name: /^AI interpreter/ }).click();
    await a.getByRole("menuitem", { name: "English" }).click();

    const panelB = b.getByRole("region", { name: "Live interpretation" });
    await expect(panelB.locator('p[lang="hi"]').first()).toContainText(/[ऀ-ॿ]{3}/, { timeout: 90_000 });
    // The assistant stayed quiet: nothing was addressed to it.
    await expect(a.getByRole("status").filter({ hasText: "You: “" })).toHaveCount(0);
  } finally {
    await Promise.all([ba.close(), bb.close()]);
  }
});
