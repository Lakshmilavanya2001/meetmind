import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.setTimeout(120_000);

test("voice call from the directory: ring, accept, voice layout, noise cancellation; decline flow", async ({ browser }) => {
  const aisha = await signIn(browser, "aisha@acme.test");
  // Accounts no other spec uses, so parallel tests aren't interrupted by these rings.
  const rahul = await signIn(browser, "amit@acme.test");
  const priya = await signIn(browser, "rahul.verma@acme.test");

  // Aisha voice-calls Amit from the directory.
  await aisha.goto("/directory");
  await aisha.getByLabel("Search directory").fill("amit@acme.test");
  await expect(aisha.getByRole("row")).toHaveCount(2);
  await aisha.getByRole("button", { name: "Voice call Amit Kumar" }).click();
  await expect(aisha).toHaveURL(/\/m\/[a-z-]+\?join=1/);
  await expect(aisha.getByRole("status").filter({ hasText: "Connected" })).toBeVisible({ timeout: 30_000 });
  await expect(aisha.getByText(/Ringing Amit Kumar/)).toBeVisible();

  // Amit sees the incoming call on whatever page he's on and accepts.
  const incoming = rahul.getByRole("alertdialog", { name: "Aisha Khan" });
  await expect(incoming).toBeVisible({ timeout: 15_000 });
  await expect(incoming).toContainText("Incoming voice call");
  await incoming.getByRole("button", { name: "Accept call" }).click();
  await expect(rahul).toHaveURL(/\?join=1/);
  await expect(rahul.getByRole("status").filter({ hasText: "Connected" })).toBeVisible({ timeout: 30_000 });

  // Voice layout with both people; the ringing banner goes away once he's in.
  for (const page of [aisha, rahul]) {
    const people = page.getByRole("list", { name: "People in this call" });
    await expect(people.getByRole("listitem")).toHaveCount(2, { timeout: 20_000 });
  }
  await expect(aisha.getByText(/Ringing Amit Kumar/)).toHaveCount(0);

  // Voice cancellation: switch to the RNNoise-based enhanced mode.
  await aisha.getByRole("button", { name: /Noise cancellation/ }).click();
  await aisha.getByRole("menuitem", { name: /Enhanced/ }).click();
  await expect(aisha.getByRole("button", { name: "Noise cancellation: Enhanced" })).toBeVisible({ timeout: 15_000 });
  await expect(aisha.getByText(/Couldn't apply noise cancellation/)).toHaveCount(0);

  // A second call: Rahul Verma declines; Aisha is told and can call again.
  await aisha.getByRole("button", { name: "Leave" }).click();
  await aisha.goto("/directory");
  await aisha.getByLabel("Search directory").fill("rahul.verma");
  await aisha.getByRole("button", { name: "Video call Rahul Verma" }).click();
  await expect(aisha.getByRole("status").filter({ hasText: "Connected" })).toBeVisible({ timeout: 30_000 });
  const ring = priya.getByRole("alertdialog", { name: "Aisha Khan" });
  await expect(ring).toContainText("Incoming video call", { timeout: 15_000 });
  await ring.getByRole("button", { name: "Decline call" }).click();
  await expect(aisha.getByText("Rahul Verma declined")).toBeVisible({ timeout: 10_000 });
  await expect(aisha.getByRole("button", { name: "Call again" })).toBeVisible();
});
