import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Phone verification via the dev SMS outbox, SMS reminders, and a sandbox table booking through the real assistant.
test.setTimeout(240_000);

test("verify phone → SMS reminder → sandbox table booking via the assistant → cancel", async ({ browser, baseURL }) => {
  const page = await signIn(browser, "hank@globex.test");
  const origin = { origin: baseURL! };

  // A fresh number each run (changing it clears any earlier verification).
  const phone = `+9198${String(Date.now()).slice(-8)}`;
  await page.goto("/settings/profile");
  await page.getByRole("textbox", { name: "Mobile number" }).fill(phone);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(`${phone} isn't verified yet.`)).toBeVisible();

  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText("the code is in your")).toBeVisible();
  const sms = await (await page.request.get("/api/profile/sms")).json();
  expect(sms.provider).toBe("outbox");
  const code = /(\d{6})/.exec(sms.messages[0].body)![1];
  await page.getByLabel(/Enter the 6-digit code/).fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(`${phone} is verified.`)).toBeVisible();
  await page.getByRole("switch", { name: /Text me reminders by default/ }).click();
  await expect(page.getByRole("switch", { name: /Text me reminders by default/ })).toBeChecked();

  // A reminder due now is delivered in-app and by SMS (dev outbox) by the worker.
  const text = `Call the bank ${Date.now().toString(36)}`;
  const res = await page.request.post("/api/reminders", { data: { text, dueAt: new Date(Date.now() + 2000).toISOString(), sms: true }, headers: origin });
  expect(res.ok()).toBeTruthy();
  await expect(async () => {
    await page.goto("/settings/messages");
    await expect(page.getByText(`MeetMind reminder: ${text}`)).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText("Development outbox").first()).toBeVisible();

  // Add a future reminder from the form, then cancel it.
  await page.goto("/tasks");
  await page.getByLabel("Remind me to…").fill("Water the plants");
  await page.getByRole("button", { name: "Add reminder" }).click();
  const upcoming = page.getByRole("list", { name: "Upcoming reminders" });
  await expect(upcoming).toContainText("Water the plants");
  await expect(upcoming).toContainText("SMS");
  await page.getByRole("button", { name: "Cancel reminder: Water the plants" }).click();
  await expect(page.getByRole("list", { name: "Upcoming reminders" }).getByText("Water the plants")).toHaveCount(0);

  // Ask the real assistant for a table; it confirms first and labels the sandbox.
  await page.goto("/assistant");
  const box = page.getByLabel("Message the assistant");
  await box.fill("Book a table for 2 at Dosa Corner the day after tomorrow at 1 pm");
  await box.press("Enter");
  await expect(page.getByText(/Reserve a table for 2 at Dosa Corner.*Sandbox — no real order/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Confirmed and done")).toBeVisible({ timeout: 60_000 });

  await page.goto("/tasks");
  const bookings = page.getByRole("list", { name: "Orders and bookings" });
  await expect(bookings).toContainText("Table for 2 at Dosa Corner");
  await expect(bookings.getByText("Sandbox").first()).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await bookings.getByRole("button", { name: "Cancel" }).first().click();
  await expect(bookings.getByText("Cancelled").first()).toBeVisible();
});
