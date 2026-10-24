import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { getTranscriptionState, setTranscription } from "@/server/services/transcripts";

type P = { ref: string };

export const GET = authed<P>(async (_req, ctx, { ref }) => getTranscriptionState(ctx, ref));

// POST — { enabled, consentSelf? } (host / co-host)
export const POST = authed<P>(async (req, ctx, { ref }) => {
  const input = z.object({ enabled: z.boolean(), consentSelf: z.boolean().optional() }).parse(await readJson(req));
  return setTranscription(ctx, ref, input);
});
