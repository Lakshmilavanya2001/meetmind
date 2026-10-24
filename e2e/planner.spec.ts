import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// The real coordinator + Planner through the running app: one plan, one approval, executed.
test.setTimeout(240_000);

test("plan a team dinner → one plan card → approve → every step done", async ({ browser }) => {
  const page = await signIn(browser, "priya@acme.test");
  await page.goto("/assistant");
  // A different day each run: earlier runs leave a dinner in both calendars (a real conflict).
  const offset = 5 + (Math.floor(Date.now() / 1000) % 300);
  const day = new Date(Date.now() + offset * 86400_000).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const box = page.getByLabel("Message the assistant");
  await box.fill(`Plan a team dinner for Amit Kumar and me on ${day} around 8 pm at The Green Bowl`);
  await box.press("Enter");

  await expect(page.getByText("Planner agent").first()).toBeVisible({ timeout: 60_000 });
  const plan = page.getByRole("region", { name: /^Plan: / });
  await expect(plan).toBeVisible({ timeout: 120_000 });
  await expect(plan).toContainText("Waiting for your approval");
  await expect(plan).toContainText(/Schedule “.*” .*invite Amit Kumar \(amit@acme\.test\)/);
  await expect(plan).toContainText(/Reserve a table for 2 at The Green Bowl/);
  await expect(plan).toContainText("Sandbox");

  await plan.getByRole("button", { name: "Approve plan" }).click();
  await expect(plan).toContainText("Done", { timeout: 60_000 });
  await expect(plan.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
  await expect(page.getByText(/✓ Plan carried out: all \d steps done/)).toBeVisible();

  await page.goto("/tasks");
  await expect(page.getByRole("list", { name: "Orders and bookings" })).toContainText("Table for 2 at The Green Bowl");
});
