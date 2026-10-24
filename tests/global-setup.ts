import { execSync } from "node:child_process";
import { config } from "dotenv";

export default function setup() {
  config({ quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !url.includes("test")) {
    throw new Error("TEST_DATABASE_URL must be set and point at a dedicated *test* database.");
  }
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
