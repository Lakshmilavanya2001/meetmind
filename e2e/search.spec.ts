import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.setTimeout(180_000);

test("ask across meetings → cited answer → jump to the moment in the transcript", async ({ browser }) => {
  const tag = `zephyr${Date.now().toString(36)}`;
  // A figure unique to this run, so earlier runs' meetings can't supply the answer.
  const amount = 10_000 + Math.floor(Math.random() * 89_000);
  const page = await signIn(browser, "aisha@acme.test");
  const { meeting } = await (await page.request.post("/api/meetings", { data: { title: `Launch planning ${tag}` } })).json();

  // Import a transcript (the manual fallback) through the UI.
  await page.goto(`/meetings/${meeting.joinCode}/transcript`);
  await page.getByRole("button", { name: "Import transcript" }).click();
  await page.getByLabel("Transcript file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`[00:05] Aisha Khan: welcome to the ${tag} launch planning\n[00:42] Priya Patel: we agreed the ${tag} launch budget is ${amount} dollars\n[01:10] Amit Kumar: i will prepare the rollout checklist`),
  });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("list", { name: "Transcript" })).toContainText(String(amount));

  // The background worker indexes this meeting for search within a few seconds.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/search?q=${tag}%20budget`)).json()).results ?? []).some((r: { meetingCode: string }) => r.meetingCode === meeting.joinCode), { timeout: 60_000, intervals: [2000] })
    .toBe(true);

  await page.goto(`/search?q=${encodeURIComponent(`What is the ${tag} launch budget?`)}`);
  const answer = page.getByRole("region", { name: "Answer" });
  const amountPattern = new RegExp(String(amount).replace(/(\d{2})(\d{3})$/, "$1,?$2"));
  await expect(answer).toContainText(amountPattern, { timeout: 90_000 });
  const source = answer.getByRole("list", { name: "Sources" }).getByRole("link").first();
  await expect(source).toContainText(`Launch planning ${tag}`);
  await expect(source).toContainText("00:42");

  // The citation opens the transcript at that moment, highlighted.
  await source.click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${meeting.joinCode}/transcript#t=42000`));
  await expect(page.locator('[aria-current="true"]')).toContainText(String(amount));
});
