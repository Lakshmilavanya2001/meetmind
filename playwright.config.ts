import { defineConfig } from "@playwright/test";

// E2E tests drive the real app + LiveKit through the HTTPS proxy.
// Prerequisites: `docker compose --profile livekit up -d`, seeded DB, and the app on :3100 —
// preferably a production build (`npm run build && npm start`), which avoids dev-server hot reloads.
// The assistant tests use the real configured LLM.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://localhost:3443",
    ignoreHTTPSErrors: true, // self-signed dev certificate
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
    trace: "retain-on-failure",
  },
});
