"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog as Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";
import { startRingtone } from "./ringtone";

type IncomingCall = {
  id: string;
  expiresAt: string;
  caller: { id: string; displayName: string; email: string };
  meeting: { joinCode: string; title: string; callType: "VOICE" | "VIDEO"; isDirectCall: boolean; workspace: string };
};

/** Watches for incoming calls on every page and shows a full-screen incoming-call prompt. */
export function IncomingCallWatcher() {
  const router = useRouter();
  const pathname = usePathname();
  const [call, setCall] = useState<IncomingCall | null>(null);
  const [busy, setBusy] = useState(false);
  const dismissed = useRef(new Set<string>());

  const poll = useCallback(async () => {
    try {
      const { calls } = await api<{ calls: IncomingCall[] }>("/api/calls/incoming");
      // Don't ring for the call you're already in.
      const next = calls.find((c) => !dismissed.current.has(c.id) && !pathname.startsWith(`/m/${c.meeting.joinCode}`)) ?? null;
      setCall((cur) => (cur?.id === next?.id ? cur : next));
    } catch {
      /* transient */
    }
  }, [pathname]);

  // Poll while the tab is visible; check immediately when it becomes visible again.
  useEffect(() => {
    const first = setTimeout(poll, 0);
    const t = setInterval(() => {
      if (!document.hidden) poll();
    }, 3000);
    const onVisible = () => !document.hidden && poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  useEffect(() => {
    if (!call) return;
    const stop = startRingtone();
    const left = new Date(call.expiresAt).getTime() - Date.now();
    const timeout = setTimeout(() => setCall(null), Math.max(0, left));
    return () => {
      stop();
      clearTimeout(timeout);
    };
  }, [call]);

  async function respond(response: "accept" | "decline") {
    if (!call) return;
    setBusy(true);
    dismissed.current.add(call.id);
    try {
      const res = await api<{ joinCode: string }>(`/api/calls/rings/${call.id}`, { method: "POST", json: { response } });
      setCall(null);
      if (response === "accept") router.push(`/m/${res.joinCode}?join=1`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That call has ended");
      setCall(null);
    } finally {
      setBusy(false);
    }
  }

  if (!call) return null;
  const voice = call.meeting.callType === "VOICE";
  // Radix alert dialog: focus is trapped inside, the page behind is inert, and Escape declines.
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            if (!busy) respond("decline");
          }}
          className="fixed top-1/2 left-1/2 z-[101] grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 justify-items-center gap-4 rounded-2xl bg-neutral-900 p-8 text-center text-white shadow-2xl outline-none"
        >
          <div className="relative">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/40 motion-reduce:animate-none" aria-hidden />
            <Avatar className="relative size-20">
              <AvatarFallback className="bg-white/10 text-2xl text-white">{initials(call.caller.displayName)}</AvatarFallback>
            </Avatar>
          </div>
          <div>
            <Dialog.Title className="text-xl font-semibold">{call.caller.displayName}</Dialog.Title>
            <Dialog.Description className="mt-1 flex items-center justify-center gap-1.5 text-sm text-white/70">
              {voice ? <Phone className="size-4" aria-hidden /> : <Video className="size-4" aria-hidden />}
              {call.meeting.isDirectCall ? `Incoming ${voice ? "voice" : "video"} call` : `Asking you to join “${call.meeting.title}”`}
            </Dialog.Description>
            <p className="mt-1 text-xs text-white/50">{call.caller.email} · {call.meeting.workspace}</p>
          </div>
          <div className="mt-2 flex gap-10">
            <div className="grid justify-items-center gap-1.5">
              <Button size="icon-lg" className="size-14 rounded-full bg-red-600 text-white hover:bg-red-700" onClick={() => respond("decline")} disabled={busy} aria-label="Decline call">
                <PhoneOff />
              </Button>
              <span className="text-xs text-white/70" aria-hidden>Decline</span>
            </div>
            <div className="grid justify-items-center gap-1.5">
              <Button size="icon-lg" className="size-14 rounded-full bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => respond("accept")} disabled={busy} aria-label="Accept call" autoFocus>
                {voice ? <Phone /> : <Video />}
              </Button>
              <span className="text-xs text-white/70" aria-hidden>Accept</span>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
