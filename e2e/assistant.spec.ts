import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Uses the real configured LLM through the running app.
test.setTimeout(180_000);

test("assistant: disambiguate a person, schedule, then confirm a cancellation", async ({ browser }) => {
  const page = await signIn(browser, "aisha@acme.test");
  await page.goto("/assistant");
  const title = `Assistant check ${Date.now().toString(36)}`;
  const box = page.getByLabel("Message the assistant");

  await box.fill(`Schedule a meeting called "${title}" with Rahul Sharma next Tuesday at 10 AM for 30 minutes`);
  await box.press("Enter");

  // The coordinator hands the request to the Meetings & calls specialist.
  await expect(page.getByText("Meetings & calls agent").first()).toBeVisible({ timeout: 60_000 });
  // Two Rahul Sharmas: the UI offers both as choices; nothing is scheduled yet.
  const choices = page.getByRole("group", { name: "Choose a person" });
  await expect(choices.getByRole("button")).toHaveCount(2, { timeout: 60_000 });
  await choices.getByRole("button", { name: /rahul\.sharma@acme\.test/ }).click();

  // Scheduling with invitees needs the user's confirmation, naming the exact person.
  await expect(page.getByText(/Schedule “.*and invite Rahul Sharma \(rahul\.sharma@acme\.test\)/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Confirm" }).click();
  // The meeting is created and linked.
  await expect(page.getByText(/Scheduled “/).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "open" }).last().click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const meetingUrl = page.url();
  await expect(page.getByText("rahul.sharma@acme.test")).toBeVisible();
  await page.goBack();

  // Cancelling needs explicit confirmation.
  await box.fill("Cancel that meeting");
  await box.press("Enter");
  const confirm = page.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeVisible({ timeout: 60_000 });
  await page.goto(meetingUrl);
  await expect(page.getByText("Cancelled", { exact: true })).toHaveCount(0); // not cancelled yet
  await page.goBack();
  await page.getByRole("button", { name: "Confirm" }).click();
  // Two cards are now "Confirmed and done" (the scheduling one and this one).
  await expect(page.getByText("Confirmed and done")).toHaveCount(2, { timeout: 30_000 });
  await page.goto(meetingUrl);
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
});

test("assistant panel is available inside a call", async ({ browser }) => {
  const page = await signIn(browser, "aisha@acme.test");
  await page.getByRole("button", { name: "Start a meeting" }).click();
  await page.getByRole("button", { name: "Join now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const box = page.getByLabel("Message the assistant");
  await box.fill("Who is in this meeting right now?");
  await box.press("Enter");
  await expect(page.getByText(/Checking participants/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Aisha/).last()).toBeVisible();
});
