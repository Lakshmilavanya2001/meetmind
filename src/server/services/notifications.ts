import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db";

export type NotificationInput = { type: string; title: string; body?: string; link?: string; data?: Prisma.InputJsonValue };

export async function notifyUsers(userIds: string[], n: NotificationInput) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await db.notification.createMany({ data: ids.map((userId) => ({ userId, ...n })) });
}

export async function listNotifications(ctx: { userId: string }, opts: { limit?: number } = {}) {
  const [items, unread] = await Promise.all([
    db.notification.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: opts.limit ?? 20,
      select: { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true },
    }),
    db.notification.count({ where: { userId: ctx.userId, readAt: null } }),
  ]);
  return { items, unread };
}

/** Mark the caller's notifications as read (all, or the given ids). Other users' rows are never touched. */
export async function markNotificationsRead(ctx: { userId: string }, ids?: string[]) {
  await db.notification.updateMany({
    where: { userId: ctx.userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
}
