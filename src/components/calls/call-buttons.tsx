"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Phone, Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

/** Voice / video call buttons for a person (directory, people lists). */
export function CallButtons({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"VOICE" | "VIDEO" | null>(null);
  async function call(type: "VOICE" | "VIDEO") {
    setPending(type);
    try {
      const res = await api<{ meeting: { joinCode: string } }>("/api/calls", { method: "POST", json: { userIds: [userId], type } });
      router.push(`/m/${res.meeting.joinCode}?join=1`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the call");
      setPending(null);
    }
  }
  return (
    <div className="flex gap-1">
      <Button size="icon-sm" variant="ghost" aria-label={`Voice call ${name}`} title="Voice call" onClick={() => call("VOICE")} disabled={!!pending}>
        {pending === "VOICE" ? <Loader2 className="animate-spin" /> : <Phone />}
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={`Video call ${name}`} title="Video call" onClick={() => call("VIDEO")} disabled={!!pending}>
        {pending === "VIDEO" ? <Loader2 className="animate-spin" /> : <Video />}
      </Button>
    </div>
  );
}
