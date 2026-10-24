"use client";

import Link from "next/link";
import { useState } from "react";
import { Maximize2, MessageSquarePlus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AssistantChat } from "./assistant-chat";

/** Top-bar button that opens the assistant in a side panel from any page. */
export function AssistantLauncher() {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Sparkles className="text-primary" aria-hidden /> <span className="hidden sm:inline">Assistant</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="flex-row items-center justify-between border-b px-4 py-3 pr-12">
          <SheetTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" aria-hidden /> Assistant</SheetTitle>
          <div className="flex gap-1">
            <Button size="icon-sm" variant="ghost" aria-label="New conversation" onClick={() => { setConversationId(null); setKey((k) => k + 1); }}>
              <MessageSquarePlus />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Open full page" asChild>
              <Link href={conversationId ? `/assistant?c=${conversationId}` : "/assistant"} onClick={() => setOpen(false)}><Maximize2 /></Link>
            </Button>
          </div>
        </SheetHeader>
        <AssistantChat key={key} conversationId={conversationId} onConversation={setConversationId} className="flex-1" />
      </SheetContent>
    </Sheet>
  );
}
