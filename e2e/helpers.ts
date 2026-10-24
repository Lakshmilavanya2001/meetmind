import { expect, type Browser } from "@playwright/test";

// Seeded development accounts (prisma/seed.ts).
export const PASSWORD = process.env.SEED_PASSWORD ?? "MeetMind#2026";

export async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return page;
}
