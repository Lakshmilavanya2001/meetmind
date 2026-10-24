import type { Metadata } from "next";
import { requireAuth } from "@/server/auth/current";
import { listConversations } from "@/server/ai/conversations";
import { AssistantWorkspace } from "./assistant-workspace";

export const metadata: Metadata = { title: "Assistant" };

export default async function AssistantPage({ searchParams }: PageProps<"/assistant">) {
  const ctx = await requireAuth();
  const sp = await searchParams;
  const conversations = await listConversations(ctx);
  const initial = typeof sp.c === "string" && conversations.some((c) => c.id === sp.c) ? sp.c : null;
  return (
    <AssistantWorkspace
      initialId={initial}
      conversations={conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString(), meeting: c.meeting }))}
    />
  );
}
