"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MessageSquarePlus, Trash2, Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Conv = { id: string; title: string; updatedAt: string; meeting: { title: string; joinCode: string } | null };

export function AssistantWorkspace({ initialId, conversations }: { initialId: string | null; conversations: Conv[] }) {
  const router = useRouter();
  const [active, setActive] = useState<string | null>(initialId);
  const [key, setKey] = useState(0);

  function open(id: string | null) {
    setActive(id);
    setKey((k) => k + 1);
    router.replace(id ? `/assistant?c=${id}` : "/assistant", { scroll: false });
  }

  async function remove(id: string) {
    try {
      await api(`/api/assistant/conversations/${id}`, { method: "DELETE" });
      if (active === id) open(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  }

  return (
    <div className="mx-auto grid h-[calc(100dvh-7.5rem)] max-w-6xl gap-4 md:grid-cols-[16rem_1fr]">
      <Card className="hidden min-h-0 flex-col gap-0 p-0 md:flex">
        <div className="border-b p-3">
          <Button className="w-full" variant="outline" onClick={() => open(null)}><MessageSquarePlus aria-hidden /> New conversation</Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Conversations">
          {conversations.length === 0 && <li className="px-2 py-4 text-sm text-muted-foreground">No conversations yet.</li>}
          {conversations.map((c) => (
            <li key={c.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => open(c.id)}
                aria-current={active === c.id ? "true" : undefined}
                className={cn("min-w-0 flex-1 rounded-md px-2 py-2 text-left text-sm hover:bg-muted", active === c.id && "bg-muted font-medium")}
              >
                <span className="block truncate">{c.title}</span>
                {c.meeting && <span className="flex items-center gap-1 truncate text-xs text-muted-foreground"><Video className="size-3" aria-hidden /> {c.meeting.title}</span>}
              </button>
              <Button size="icon-xs" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Delete conversation “${c.title}”`} onClick={() => remove(c.id)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="flex min-h-0 flex-col gap-0 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h1 className="text-base font-semibold">Assistant</h1>
          <Button size="sm" variant="ghost" className="md:hidden" onClick={() => open(null)}><MessageSquarePlus aria-hidden /> New</Button>
        </div>
        <AssistantChat
          key={key}
          conversationId={active}
          className="flex-1"
          onConversation={(id) => {
            setActive(id);
            router.replace(`/assistant?c=${id}`, { scroll: false });
            router.refresh();
          }}
        />
      </Card>
    </div>
  );
}
