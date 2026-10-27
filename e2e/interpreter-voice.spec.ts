import path from "node:path";
import { config } from "dotenv";
import { RoomServiceClient } from "livekit-server-sdk";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD } from "./helpers";

// A speaks English (e2e/fixtures/monologue-en.wav) and picks "Jason · Happy" as their voice; B listens in Hindi
// and hears A's translations in Jason's voice (Hindi has Jason, without tones). Still one track per language.
config({ quiet: true });
test.setTimeout(240_000);
const launch = (file: string) => chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.resolve(file)}`, "--autoplay-policy=no-user-gesture-required"] });
async function signIn(browser: Browser, email: string, baseURL: string) {
  const page = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return page;
}
const playing = (p: Page) => p.evaluate(() => [...document.querySelectorAll("audio")].filter((a) => (a.srcObject as MediaStream | null)?.getAudioTracks().some((t) => t.readyState === "live")).length);
/** The interpreter's published tracks, and who receives each (from LiveKit itself). */
async function agentTracks(code: string) {
  const rooms = new RoomServiceClient(process.env.LIVEKIT_URL!.replace(/^ws/, "http"), process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
  const room = (await rooms.listRooms()).find((r) => r.name.includes(code.replace(/-/g, "")) || r.name.includes(code));
  if (!room) return [];
  const agent = (await rooms.listParticipants(room.name)).find((p) => p.identity === "agent-interpreter");
  return (agent?.tracks ?? []).map((t) => t.name).sort();
}

test("interpreter: a speaker picks a voice and tone, and listeners hear their translations in it", async ({ baseURL }) => {
  const [ba, bb] = await Promise.all([launch("e2e/fixtures/monologue-en.wav"), launch("e2e/fixtures/silence.wav")]);
  try {
    const a = await signIn(ba, "priya@acme.test", baseURL!);
    const b = await signIn(bb, "amit@acme.test", baseURL!);
    await a.getByRole("button", { name: "Start a meeting" }).click();
    await expect(a).toHaveURL(/\/m\//);
    const code = a.url().split("/m/")[1];
    await a.getByRole("button", { name: "Join now" }).click();
    await b.goto(`/m/${code}`);
    await b.getByRole("button", { name: "Join now" }).click();
    for (const p of [a, b]) await expect(p.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
    await a.getByRole("button", { name: /^AI interpreter/ }).click();
    await a.getByRole("menuitem", { name: "English" }).click();
    await b.getByRole("button", { name: /^AI interpreter/ }).click();
    await b.getByRole("menuitem", { name: /Hindi/ }).click();
    const panelB = b.getByRole("region", { name: "Live interpretation" });
    await expect(panelB.getByText(/heard after \d+\.\d s/).first()).toBeVisible({ timeout: 90_000 });

    // A opens the picker: every voice on offer, English (A's language) first, with tones.
    await a.getByRole("button", { name: /^AI interpreter/ }).click();
    await a.getByRole("menuitem", { name: /Your voice/ }).click();
    const dialog = a.getByRole("dialog", { name: "Your voice" });
    await expect(dialog.getByRole("radio", { name: /Louise.*default/ })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("radio", { name: /^Jason/ }).click();
    await dialog.getByRole("radio", { name: "Happy" }).click();
    await dialog.getByRole("button", { name: "Preview" }).click();
    await expect(dialog.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 }); // the sample plays
    await dialog.getByRole("button", { name: "Use this voice" }).click();
    await expect(a.getByText("Others will hear you as Jason · Happy.")).toBeVisible();

    // Still one voice track per language; B receives only the Hindi one, and A's lines keep being spoken to B.
    console.log("[agent tracks]", await agentTracks(code));
    expect(await agentTracks(code)).toEqual(["interpreter-en", "interpreter-hi"]);
    const spokenToHindi = async () => ((await (await a.request.get(`/api/meetings/${code}/interpretation/latency`)).json()).byPair as { pair: string; count: number }[]).find((p) => p.pair === "en→hi")?.count ?? 0;
    const before = await spokenToHindi();
    await expect.poll(spokenToHindi, { timeout: 30_000 }).toBeGreaterThan(before);
    expect(await playing(b)).toBe(1);

    // A's menu shows the choice; B's choice is B's own.
    await a.getByRole("button", { name: /^AI interpreter/ }).click();
    await expect(a.getByRole("menuitem", { name: /Your voice.*Jason · Happy/ })).toBeVisible();
    await a.keyboard.press("Escape");
    expect((await (await b.request.get(`/api/meetings/${code}/interpretation`)).json()).myVoiceId).toBeNull();
    const lat = await (await a.request.get(`/api/meetings/${code}/interpretation/latency`)).json();
    console.log("[latency]", JSON.stringify(lat.overall));
  } finally {
    await Promise.all([ba.close(), bb.close()]);
  }
});
