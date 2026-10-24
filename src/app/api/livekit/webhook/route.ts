import { open } from "@/server/http";
import { getCallingProvider } from "@/server/providers/calling";
import { handleCallingEvent } from "@/server/services/meetings";

// LiveKit → app events. Authenticated by LiveKit's signed JWT (sha256 of the body), not by cookie.
export const POST = open(async (req) => {
  const body = await req.text();
  const event = await getCallingProvider("LIVEKIT").parseWebhook(body, req.headers.get("authorization"));
  if (event) await handleCallingEvent("LIVEKIT", event);
  return { ok: true };
});
