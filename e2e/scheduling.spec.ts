import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("schedule with a same-name colleague, RSVP via notification, cancel", async ({ browser }) => {
  const title = `E2E review ${Date.now().toString(36)}`;
  const host = await signIn(browser, "aisha@acme.test");

  // Open the schedule dialog and fill it in.
  await host.getByRole("button", { name: "Schedule" }).first().click();
  const dialog = host.getByRole("dialog", { name: "Schedule a meeting" });
  await dialog.getByLabel("Title").fill(title);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Date").fill(tomorrow);
  await dialog.getByLabel("Start time").fill("10:00");

  // Two people are called "Rahul Sharma": both are listed with emails and flagged; we pick by email.
  await dialog.getByLabel("Participants").fill("Rahul Sharma");
  const options = dialog.getByRole("listbox", { name: "Matching people" }).getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(dialog.getByText("Same name")).toHaveCount(2);
  await options.filter({ hasText: "rahul.sharma@acme.test" }).click();
  await expect(dialog.getByRole("list", { name: "Selected people" })).toContainText("rahul.sharma@acme.test");

  await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
  // Leftover meetings from earlier runs may conflict — the UI asks before overriding.
  const anyway = dialog.getByRole("button", { name: "Schedule anyway" });
  const done = host.getByRole("heading", { name: "Meeting scheduled" }); // the dialog is renamed on success
  await expect(anyway.or(done)).toBeVisible();
  if (await anyway.isVisible()) await anyway.click();
  await expect(done).toBeVisible();
  const scheduled = host.getByRole("dialog", { name: "Meeting scheduled" });
  await expect(scheduled).toContainText("Rahul Sharma");
  await scheduled.getByRole("link", { name: "Open meeting" }).click();
  await expect(host.getByRole("heading", { name: title })).toBeVisible();
  const meetingUrl = host.url();

  // The invited Rahul gets a notification, opens it and accepts.
  const rahul = await signIn(browser, "rahul.sharma@acme.test");
  await rahul.getByRole("button", { name: /Notifications, \d+ unread/ }).click();
  await rahul.getByRole("button", { name: new RegExp(`invited you to “${title}”`) }).first().click();
  await expect(rahul).toHaveURL(meetingUrl);
  await rahul.getByRole("button", { name: "Accept" }).click();
  await expect(rahul.getByText("You accepted this invitation.")).toBeVisible();

  // It's in his calendar, confirmed.
  await rahul.goto(`/calendar?week=${tomorrow}`);
  await expect(rahul.getByRole("link", { name: new RegExp(title) })).toBeVisible();

  // The other Rahul Sharma was not invited.
  const otherRahul = await signIn(browser, "rahul.s@acme.test");
  await otherRahul.goto("/meetings");
  await expect(otherRahul.getByText(title)).toHaveCount(0);

  // Host sees the RSVP and cancels (with confirmation).
  await host.reload();
  await expect(host.getByText("Accepted").first()).toBeVisible();
  await host.getByRole("button", { name: "Cancel meeting" }).click();
  await host.getByRole("alertdialog").getByRole("button", { name: "Cancel meeting" }).click();
  await expect(host.getByText("Cancelled", { exact: true })).toBeVisible();

  await rahul.reload();
  await rahul.getByRole("button", { name: /Notifications/ }).click();
  await expect(rahul.getByText(`“${title}” was cancelled`)).toBeVisible();
});
