import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { setConsent } from "@/server/services/transcripts";

// POST — { consent: boolean } for the caller's own audio.
export const POST = authed<{ ref: string }>(async (req, ctx, { ref }) => {
  const { consent } = z.object({ consent: z.boolean() }).parse(await readJson(req));
  return setConsent(ctx, ref, consent);
});
