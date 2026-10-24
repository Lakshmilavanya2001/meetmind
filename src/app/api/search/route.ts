import { z } from "zod";
import { authed } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { searchTranscripts } from "@/server/services/rag";

// GET /api/search?q=&from=&to= — transcript excerpts the caller may access, best match first.
export const GET = authed(async (req, ctx) => {
  rateLimit(`search:${ctx.userId}`, 60, 60_000);
  const { q, from, to } = z
    .object({ q: z.string().trim().min(1).max(300), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() })
    .parse(Object.fromEntries(req.nextUrl.searchParams));
  const results = await searchTranscripts(ctx, { query: q, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, limit: 12 });
  return { results };
});
