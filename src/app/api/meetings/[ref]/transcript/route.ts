import { z } from "zod";
import { authed } from "@/server/http";
import { deleteTranscript, getTranscript } from "@/server/services/transcripts";

type P = { ref: string };

// GET ?afterMs= for incremental live updates.
export const GET = authed<P>(async (req, ctx, { ref }) => {
  const { afterMs } = z.object({ afterMs: z.coerce.number().int().min(-1).optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
  return getTranscript(ctx, ref, { afterMs });
});

export const DELETE = authed<P>(async (_req, ctx, { ref }) => {
  await deleteTranscript(ctx, ref);
  return { ok: true };
});
