import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";

export async function audit(entry: {
  action: string;
  actorUserId?: string | null;
  organizationId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}) {
  try {
    await db.auditLog.create({ data: entry });
  } catch (err) {
    // Audit failures must never break the user-facing operation, but must be visible.
    console.error("[audit] failed to write", entry.action, err);
  }
}
