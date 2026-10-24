import { authed } from "@/server/http";
import { db } from "@/server/db";
import { transcriptionAnnouncement } from "@/server/services/voice";

const cache = new Map<string, Awaited<ReturnType<typeof transcriptionAnnouncement>>>();

// GET — the spoken "this call is being transcribed" notice in the caller's language (cached).
export const GET = authed(async (_req, ctx) => {
  const { preferredLanguage } = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { preferredLanguage: true } });
  const cached = cache.get(preferredLanguage);
  if (cached) return { speech: cached };
  const speech = await transcriptionAnnouncement(preferredLanguage);
  if (speech?.audioBase64) cache.set(preferredLanguage, speech); // only cache real audio; retry synthesis otherwise
  return { speech };
});
