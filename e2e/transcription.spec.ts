import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// The fake microphone plays a speech sample (regenerated with Qwen3-TTS on 2026-10-24; originally espeak-ng): "Hi team, this is Rahul. I think we can
// finish the API integration by the fifteenth of November. Priya, can you review the database schema before Friday?"
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
test.setTimeout(240_000);

test("live transcription with consent → transcript → grounded summary", async ({ browser }) => {
  const page = await signIn(browser, "aisha@acme.test");
  await page.getByRole("button", { name: "Start a meeting" }).click();
  await expect(page).toHaveURL(/\/m\//);
  const code = page.url().split("/m/")[1];
  await page.getByRole("button", { name: "Join now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();

  // Host starts transcription; the confirmation explains consent.
  await page.getByRole("button", { name: "Start transcription" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("only transcribed after they choose “Allow”");
  await page.getByRole("button", { name: "Start transcription" }).last().click();
  await expect(page.getByText("Transcription is on for this meeting.")).toBeVisible();
  await expect(page.getByText(/Your microphone audio is being transcribed/)).toBeVisible();

  // Real audio → real speech-to-text → live transcript panel.
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByText(/api integration/i).first()).toBeVisible({ timeout: 90_000 });
  // Speech arrives in short chunks (for live captions); wait for the second sentence too.
  await expect(page.getByText(/schema/i).first()).toBeVisible({ timeout: 90_000 });

  // Withdrawing consent is immediate.
  await page.getByRole("button", { name: "Stop transcribing me" }).click();
  await expect(page.getByRole("button", { name: "Allow transcription of my audio" })).toBeVisible();

  // End the meeting, then review the transcript and summarise it.
  await page.getByRole("button", { name: "End for all" }).click();
  await page.getByRole("button", { name: "End meeting" }).click();
  await page.goto(`/meetings/${code}/transcript`);
  await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  const transcript = page.getByRole("list", { name: "Transcript" });
  await expect(transcript).toContainText("Aisha Khan");
  await expect(transcript).toContainText(/november/i);

  await page.getByRole("button", { name: "Summarise" }).click();
  await expect(page.getByRole("heading", { name: "Action items" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/schema/i).first()).toBeVisible();

  // Search highlights matches; download works.
  await page.getByLabel("Search this transcript").fill("schema");
  await expect(transcript.locator("mark").first()).toBeVisible();
  const res = await page.request.get(`/api/meetings/${code}/transcript/export?format=txt`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toMatch(/Aisha Khan: .*integration/i);
});
