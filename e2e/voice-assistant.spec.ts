import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// The fake microphone loops a speech sample (made with Qwen3-TTS): "Hey Mind, what meetings do I have this week?"
test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${path.resolve("e2e/fixtures/hey-mind.wav")}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});
test.setTimeout(180_000);

test("voice assistant mid-call: 'Hey Mind' → real STT → agent reply", async ({ browser }) => {
  const page = await signIn(browser, "priya@acme.test");
  await page.getByRole("button", { name: "Start a meeting" }).click();
  await expect(page).toHaveURL(/\/m\//);
  await page.getByRole("button", { name: "Join now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();

  // Wake listening is off until the user turns it on.
  const wake = page.getByRole("button", { name: "Listen for Hey Mind" });
  await expect(wake).toHaveAttribute("aria-pressed", "false");
  await wake.click();
  await expect(page.getByRole("button", { name: "Stop listening for Hey Mind" })).toHaveAttribute("aria-pressed", "true");

  // The assistant hears the command (wake phrase stripped) and answers.
  const card = page.getByRole("status").filter({ hasText: "You: “" });
  await expect(card).toContainText(/meetings/i, { timeout: 90_000 });
  await expect(card.locator("p").last()).not.toHaveText(/^You:/, { timeout: 90_000 });

  // Turning it off stops listening.
  await page.getByRole("button", { name: "Stop listening for Hey Mind" }).click();
  await expect(page.getByRole("button", { name: "Listen for Hey Mind" })).toBeVisible();
  await page.getByRole("button", { name: /^Leave/ }).first().click().catch(() => {});
});
