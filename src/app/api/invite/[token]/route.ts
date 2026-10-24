import { open } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { clientIp } from "@/server/http";
import { previewExternalInvitation } from "@/server/services/invitations";

export const GET = open<{ token: string }>(async (req, { token }) => {
  rateLimit(`invite:preview:${clientIp(req) ?? "global"}`, clientIp(req) ? 60 : 600, 60_000);
  return previewExternalInvitation(token);
});
