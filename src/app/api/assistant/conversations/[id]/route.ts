import { authed } from "@/server/http";
import { deleteConversation, getConversationMessages } from "@/server/ai/conversations";

type P = { id: string };

export const GET = authed<P>(async (_req, ctx, { id }) => getConversationMessages(ctx, id));
export const DELETE = authed<P>(async (_req, ctx, { id }) => {
  await deleteConversation(ctx, id);
  return { ok: true };
});
