"use client";

import { useParticipants, useSpeakingParticipants } from "@livekit/components-react";
import { MicOff } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Audio-only layout: large avatars with a speaking ring (used for voice calls when no camera is on). */
export function VoiceStage() {
  const participants = useParticipants();
  const speaking = new Set(useSpeakingParticipants().map((p) => p.identity));
  return (
    <div className="grid h-full place-items-center">
      <ul className="flex flex-wrap items-center justify-center gap-10 p-6" aria-label="People in this call">
        {participants.map((p) => {
          const name = p.name || p.identity;
          const talking = speaking.has(p.identity);
          return (
            <li key={p.identity} className="grid justify-items-center gap-3">
              <div className={cn("rounded-full p-1 transition-shadow", talking ? "ring-4 ring-emerald-400" : "ring-2 ring-white/10")}>
                <Avatar className="size-28">
                  <AvatarFallback className="bg-white/10 text-3xl text-white">{initials(name)}</AvatarFallback>
                </Avatar>
              </div>
              <p className="flex items-center gap-1.5 text-sm">
                {name}
                {p.isLocal && <span className="text-white/50">(you)</span>}
                {!p.isMicrophoneEnabled && <MicOff className="size-3.5 text-red-400" aria-label="Muted" />}
              </p>
              <span className="sr-only">{talking ? "speaking" : ""}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
