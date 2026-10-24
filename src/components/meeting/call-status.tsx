"use client";

import { useCallback, useEffect, useState } from "react";
import { useParticipants } from "@livekit/components-react";
import { PhoneCall } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type Ring = { calleeId: string; displayName: string; status: "RINGING" | "ACCEPTED" | "DECLINED" | "MISSED" | "CANCELED" };

/** Caller-side banner for direct calls: "Ringing Rahul…", "Rahul declined", "No answer" + call again. */
export function CallStatusBanner({ meetingRef }: { meetingRef: string }) {
  const participants = useParticipants();
  const [rings, setRings] = useState<Ring[]>([]);
  const inCall = new Set(participants.map((p) => p.identity));

  const load = useCallback(async () => {
    try {
      setRings((await api<{ rings: Ring[] }>(`/api/meetings/${meetingRef}/rings`)).rings);
    } catch {
      /* keep */
    }
  }, [meetingRef]);

  // Fast while someone is ringing; slow otherwise (people can still be rung later from elsewhere).
  const ringing = rings.some((r) => r.status === "RINGING");
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, ringing ? 3000 : 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, ringing]);

  const pending = rings.filter((r) => !inCall.has(r.calleeId));
  if (pending.length === 0) return null;
  const label = (r: Ring) =>
    r.status === "RINGING" ? `Ringing ${r.displayName}…` : r.status === "DECLINED" ? `${r.displayName} declined` : r.status === "MISSED" ? `${r.displayName} didn't answer` : r.status === "ACCEPTED" ? `${r.displayName} is joining…` : `Stopped ringing ${r.displayName}`;
  const retry = pending.filter((r) => r.status === "DECLINED" || r.status === "MISSED" || r.status === "CANCELED").map((r) => r.calleeId);

  async function callAgain() {
    try {
      await api(`/api/meetings/${meetingRef}/rings`, { method: "POST", json: { userIds: retry } });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't ring again");
    }
  }

  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-3 border-b border-white/10 bg-white/5 px-4 py-2 text-sm">
      <PhoneCall className="size-4 animate-pulse text-emerald-400 motion-reduce:animate-none" aria-hidden />
      <span>{pending.map(label).join(" · ")}</span>
      {retry.length > 0 && (
        <Button size="sm" variant="secondary" className="h-7" onClick={callAgain}>Call again</Button>
      )}
    </div>
  );
}
