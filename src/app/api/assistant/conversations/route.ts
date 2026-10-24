import { authed } from "@/server/http";
import { listConversations } from "@/server/ai/conversations";

export const GET = authed(async (req, ctx) => ({
  conversations: await listConversations(ctx, { meetingRef: req.nextUrl.searchParams.get("meeting") ?? undefined }),
}));
