import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers";

async function joinFromLobby(page: Page) {
  await expect(page.getByRole("button", { name: "Join now" })).toBeEnabled();
  await page.getByRole("button", { name: "Join now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
}

/** Number of <video> elements actually rendering frames (fake camera produces a test pattern). */
const playingVideos = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("video")].filter((v) => v.readyState >= 2 && v.videoWidth > 0).length);

test("two users hold a real call; host controls work", async ({ browser }) => {
  const host = await signIn(browser, "aisha@acme.test");
  await host.getByRole("button", { name: "Start a meeting" }).click();
  await expect(host).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  const meetingUrl = host.url();
  await joinFromLobby(host);

  const guest = await signIn(browser, "priya@acme.test");
  // Join via the dashboard "code or link" box, like a real user would.
  await guest.getByLabel("Meeting code or link").fill(meetingUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await joinFromLobby(guest);

  // Both see two people in the call and receive each other's live video over WebRTC.
  for (const page of [host, guest]) {
    await expect(page.getByRole("list", { name: "People in this call" }).getByRole("listitem")).toHaveCount(2);
    await expect.poll(() => playingVideos(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  }

  // Regression: the call view must fit the window (LiveKit's CSS once let the grid grow past it).
  for (const page of [host, guest]) {
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
    await expect(page.getByRole("button", { name: "Leave" })).toBeInViewport();
  }

  // Participants panel shows roles from the server.
  await host.getByRole("button", { name: "Participants" }).click();
  const panel = host.getByRole("complementary", { name: "participants panel" });
  await expect(panel.getByText("Priya Patel")).toBeVisible();
  await expect(panel.getByText(/^Host/)).toBeVisible();

  // Guest mutes themself; host sees the muted indicator.
  await guest.getByRole("button", { name: "Microphone" }).first().click();
  await expect(panel.getByLabel("Muted")).toBeVisible();

  // Host removes the guest (with confirmation); guest is disconnected and cannot rejoin.
  await panel.getByRole("button", { name: "Actions for Priya Patel" }).click();
  await host.getByRole("menuitem", { name: "Remove from meeting" }).click();
  await host.getByRole("button", { name: "Remove" }).click();
  await expect(guest.getByRole("heading", { name: "The host removed you from this meeting." })).toBeVisible();
  await guest.goto(meetingUrl);
  await expect(guest.getByText("The host removed you from this meeting.")).toBeVisible();
  await expect(host.getByRole("list", { name: "People in this call" }).getByRole("listitem")).toHaveCount(1);

  // Host ends the meeting.
  await host.getByRole("button", { name: "End for all" }).click();
  await host.getByRole("button", { name: "End meeting" }).click();
  await expect(host.getByRole("heading", { name: /ended the meeting|left the meeting/ })).toBeVisible();
});
