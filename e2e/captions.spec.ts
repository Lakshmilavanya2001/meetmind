import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// English speech on the fake microphone (see transcription.spec.ts); the viewer reads it in Hindi.
test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${path.resolve("e2e/fixtures/speech.wav")}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});
test.setTimeout(180_000);

test("live captions translated into Hindi", async ({ browser }) => {
  const page = await signIn(browser, "rahul.s@acme.test");
  await page.getByRole("button", { name: "Start a meeting" }).click();
  await expect(page).toHaveURL(/\/m\//);
  await page.getByRole("button", { name: "Join now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();

  // Captions are off by default; choosing Hindi before transcription explains what's needed.
  await page.getByRole("button", { name: "Live captions: Off" }).click();
  await page.getByRole("menuitem", { name: /Hindi/ }).click();
  const region = page.getByRole("region", { name: "Live captions" });
  await expect(region).toContainText("Captions appear when the host turns on transcription.");

  await page.getByRole("button", { name: "Start transcription" }).click();
  await page.getByRole("button", { name: "Start transcription" }).last().click();
  await expect(page.getByText("Transcription is on for this meeting.")).toBeVisible();

  // Real STT → real LLM translation → Devanagari captions, marked as translated.
  await expect(region).toContainText(/[ऀ-ॿ]{4}/, { timeout: 90_000 });
  await expect(region).toContainText("translated");
  await expect(region).toContainText("You:");

  // Switch to "as spoken": the English original comes back.
  await page.getByRole("button", { name: "Live captions: Hindi (हिन्दी)" }).click();
  await page.getByRole("menuitem", { name: /As spoken/ }).click();
  await expect(region).toContainText(/[a-z]{4}/i, { timeout: 30_000 });
  await expect(region).not.toContainText("translated");
});
