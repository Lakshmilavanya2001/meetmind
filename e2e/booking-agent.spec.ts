import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

// Demo 4: the booking agent asks for anything missing, confirms, then submits to the (sandbox) partner site.
// Uses the real configured LLM, so the conversation can take a turn or two.
test.setTimeout(300_000);

async function chatUntilConfirm(page: Page, first: string, followUp: string) {
  const box = page.getByLabel("Message the assistant");
  const confirm = page.getByRole("button", { name: "Confirm" });
  await box.fill(first);
  await box.press("Enter");
  for (let turn = 0; turn < 4; turn++) {
    // Wait for the turn to finish: either a confirmation card or the box is usable again.
    await expect(confirm.or(box)).toBeVisible({ timeout: 90_000 });
    await expect(box).toBeEnabled({ timeout: 90_000 });
    if (await confirm.isVisible()) return confirm;
    await page.waitForTimeout(1500);
    if (await confirm.isVisible()) return confirm;
    await box.fill(followUp);
    await box.press("Enter");
  }
  await expect(confirm).toBeVisible({ timeout: 60_000 });
  return confirm;
}

test("pizza: the agent orders from Slice Republic and the restaurant sees it", async ({ browser }) => {
  const page = await signIn(browser, "rahul@globex.test");
  await page.goto("/assistant");
  const confirm = await chatUntilConfirm(
    page,
    "Order two medium Margherita pizzas and one garlic bread from Slice Republic, delivered to Globex office, 4th floor, Koramangala. Pay on delivery.",
    "Yes, that's everything — go ahead and prepare the order for my confirmation.",
  );
  await expect(page.getByText(/Slice Republic/).last()).toBeVisible();
  await confirm.click();
  await expect(page.getByText("Confirmed and done").last()).toBeVisible({ timeout: 60_000 });

  await page.goto("/partners/food?restaurant=r-slice-republic");
  const orders = page.getByRole("list", { name: "Incoming orders" });
  const first = orders.getByRole("listitem").first();
  await expect(first).toContainText("Margherita pizza (medium)", { timeout: 30_000 });
  await expect(first).toContainText("Garlic breadsticks");
  await expect(first.getByRole("list", { name: "Order progress" })).toContainText("Order received");
  await page.screenshot({ path: "test-results/partner-food.png", fullPage: true });
});

test("movie: the agent picks seats, confirms, and the cinema sees the booking", async ({ browser }) => {
  const page = await signIn(browser, "rahul@globex.test");
  await page.goto("/assistant");
  const confirm = await chatUntilConfirm(
    page,
    "Book 2 tickets for The Last Signal the day after tomorrow, the earliest evening show at any cinema, best available seats together.",
    "Yes, take the first evening show you found and the suggested seats.",
  );
  await expect(page.getByText(/Book 2 tickets for The Last Signal/).last()).toBeVisible();
  await confirm.click();
  await expect(page.getByText("Confirmed and done").last()).toBeVisible({ timeout: 60_000 });

  // Whichever cinema it chose, that cinema's box office now lists the booking.
  let found = false;
  for (const id of ["cn-galaxy-kor", "cn-starlight-wf", "cn-regal-mg"]) {
    await page.goto(`/partners/cinema?cinema=${id}`);
    const list = page.getByRole("list", { name: "Bookings" });
    await expect(list.or(page.getByText("No bookings yet"))).toBeVisible({ timeout: 30_000 });
    if (await list.getByText("The Last Signal").count()) {
      await expect(list.getByRole("listitem").first()).toContainText(/seats [A-J]\d+, [A-J]\d+/);
      found = true;
      break;
    }
  }
  expect(found).toBe(true);
  await page.screenshot({ path: "test-results/partner-cinema.png", fullPage: true });
});

test("demos hub links every POC demo", async ({ browser }) => {
  const page = await signIn(browser, "aisha@acme.test");
  await page.getByRole("link", { name: "Demos" }).first().click();
  await expect(page).toHaveURL(/\/demos$/);
  for (const t of ["Call transcription and summary", "Real-time voice translation", "Noise cancellation", "AI agent for ordering and booking"]) await expect(page.getByText(t).first()).toBeVisible();
});
