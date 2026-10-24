import "server-only";
import { db } from "../db";
import { audit } from "../audit";
import { profileUpdateSchema } from "@/lib/validation";

const PROFILE_SELECT = {
  id: true,
  email: true,
  displayName: true,
  title: true,
  department: true,
  timezone: true,
  preferredLanguage: true,
  phoneNumber: true,
  phoneVerifiedAt: true,
  smsReminders: true,
  summaryEmail: true,
  summarySms: true,
  phoneVerifiedVia: true,
  avatarUrl: true,
  createdAt: true,
} as const;

export const getProfile = (ctx: { userId: string }) =>
  db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: PROFILE_SELECT });

export async function updateProfile(ctx: { userId: string; organizationId: string }, raw: unknown) {
  const input = profileUpdateSchema.parse(raw);
  const current = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { phoneNumber: true } });
  const phone = input.phoneNumber === undefined ? undefined : input.phoneNumber || null;
  const user = await db.user.update({
    where: { id: ctx.userId },
    data: {
      displayName: input.displayName,
      title: input.title || null,
      department: input.department || null,
      timezone: input.timezone,
      ...(input.preferredLanguage ? { preferredLanguage: input.preferredLanguage } : {}),
      // Changing the number un-verifies it (SMS reminders need a verified number).
      ...(phone !== undefined && phone !== current.phoneNumber ? { phoneNumber: phone, phoneVerifiedAt: null, phoneVerifiedVia: null, smsReminders: false, summarySms: false } : {}),
    },
    select: PROFILE_SELECT,
  });
  await audit({ action: "profile.update", actorUserId: ctx.userId, organizationId: ctx.organizationId });
  return user;
}
