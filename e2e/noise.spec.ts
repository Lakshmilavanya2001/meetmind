import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Demo 3: a noisy voice sample → three noise-suppression models in the browser → measured improvement.
test.setTimeout(180_000);

test("noise cancellation: before/after with measured improvement", async ({ browser }) => {
  const page = await signIn(browser, "hank@globex.test");
  await page.goto("/demos/noise");
  const table = page.getByRole("table", { name: "Noise cancellation results" });
  // All three models finish processing the office sample.
  await expect(table.getByRole("button", { name: /Play (RNNoise|GTCRN|Speex)/ })).toHaveCount(3, { timeout: 120_000 });
  const rows = await table.locator("tbody tr").allInnerTexts();
  console.log("[noise] office:\n" + rows.join("\n"));
  // RNNoise (the model used in calls) improves speech quality and removes background noise.
  const rn = rows.find((r) => r.startsWith("RNNoise"))!;
  const gain = Number(/([+-]\d+\.\d) dB/.exec(rn)![1]);
  const bg = Number(/−(\d+\.\d) dB/.exec(rn)![1]);
  expect(gain).toBeGreaterThan(3);
  expect(bg).toBeGreaterThan(10);
  await expect(page.getByRole("img", { name: /Spectrogram: Before/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Spectrogram: After/ })).toBeVisible();
  await page.getByRole("button", { name: /Play RNNoise/ }).click();
  await expect(page.getByRole("button", { name: /Stop RNNoise/ })).toBeVisible();
  await page.screenshot({ path: "test-results/noise.png", fullPage: true });

  for (const s of ["Street", "Café"]) {
    await page.getByRole("button", { name: new RegExp(`^${s}`) }).click();
    await expect(page.getByRole("button", { name: `Play Original: ${s}` })).toBeVisible({ timeout: 30_000 });
    await expect(table.getByRole("button", { name: /Play (RNNoise|GTCRN|Speex)/ })).toHaveCount(3, { timeout: 120_000 });
    console.log(`[noise] ${s}:\n` + (await table.locator("tbody tr").allInnerTexts()).join("\n"));
  }
});
