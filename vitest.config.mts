import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config({ quiet: true });

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // "server-only" throws outside a React Server environment; it's a no-op in tests.
    alias: { "server-only": new URL("./tests/server-only-stub.ts", import.meta.url).pathname },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      NODE_ENV: "test",
      // Never talk to a real mail server from tests.
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      APP_URL: "https://meet.test",
      // Tests never depend on the GPU host's Indic services; tests that need them set fakes.
      INDIC_ASR_URL: "",
      INDIC_TRANSLATE_URL: "",
      INDIC_TTS_URL: "",
    },
  },
});
