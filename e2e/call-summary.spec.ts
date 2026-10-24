import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Demo 1: a recorded two-person call → speakers → automatic summary → delivery, through the real models.
test.setTimeout(240_000);

test("sample call: speakers identified, summary generated and delivered", async ({ browser }) => {
  const page = await signIn(browser, "hank@globex.test");
  await page.goto("/meetings");
  await page.getByRole("button", { name: "Try a sample call" }).click();
  await expect(page).toHaveURL(/\/transcript\?sample=1/);

  // The upload dialog opens with the sample loaded (synthetic voices, so consent is pre-ticked).
  const dialog = page.getByRole("dialog", { name: "Transcribe a recording" });
  await expect(dialog.getByLabel("Sample call audio")).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await dialog.getByRole("button", { name: "Transcribe" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // Speech → text, with the two voices told apart.
  const speakers = page.getByRole("list", { name: "Speakers" });
  await expect(speakers).toContainText("Speaker 1", { timeout: 120_000 });
  await expect(speakers).toContainText("Speaker 2");
  await expect(page.getByRole("list", { name: "Transcript" })).toContainText(/Rohan/);

  // The summary is made automatically after the call and shows key points, decisions and action items.
  await expect(page.getByText("Key discussion points")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "Action items" })).toBeVisible();
  await expect(page.getByText(/quote/i).first()).toBeVisible();

  // Delivery is shown: in the app (sent) and by email (development outbox).
  const delivery = page.getByRole("table", { name: "Summary delivery" });
  await expect(delivery).toContainText("Hank Scorpio", { timeout: 60_000 });
  await expect(delivery).toContainText("Sent");
  await expect(delivery).toContainText("Outbox");
  await page.screenshot({ path: "test-results/call-summary.png", fullPage: true });

  // Give Speaker 1 a real name.
  await page.getByRole("button", { name: "Rename Speaker 1" }).click();
  await page.getByLabel("New name for Speaker 1").fill("Rohan (account manager)");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("list", { name: "Transcript" })).toContainText("Rohan (account manager)");

  // The emailed summary is in the user's messages.
  await page.goto("/settings/messages");
  const emails = page.getByRole("list", { name: "Emails" });
  await expect(emails).toContainText("Call summary: Sample call: 5G business plan upgrade");
  await emails.getByText("Call summary: Sample call: 5G business plan upgrade").first().click();
  await expect(emails).toContainText("Key discussion points");
});
