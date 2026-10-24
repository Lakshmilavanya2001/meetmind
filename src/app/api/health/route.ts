import { open } from "@/server/http";
import { db } from "@/server/db";
import { isEmailConfigured } from "@/server/providers/email";

export const GET = open(async () => {
  await db.$queryRaw`SELECT 1`;
  return { ok: true, database: "up", email: isEmailConfigured() ? "configured" : "not_configured" };
});
