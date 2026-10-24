"use client";

import { FocusLayout, VideoTrack, useParticipants, useSpeakingParticipants, useTracks, type TrackReference } from "@livekit/components-react";
import { Track } from "livekit-client";
import { MicOff } from "lucide-react";
import { initials } from "@/lib/format";
import { INTERPRETER_IDENTITY } from "./use-interpreter";
import { cn } from "@/lib/utils";

/**
 * The call as a phone call: each person is a large circle (their camera inside it when it's on) with a
 * ring that pulses while they talk, their name, the language they chose and whether they're speaking.
 */
export function PhoneStage({ languageOf, languageName }: { languageOf: (identity: string) => string | undefined; languageName: (code: string) => string }) {
  const participants = useParticipants().filter((p) => p.identity !== INTERPRETER_IDENTITY);
  const speaking = new Set(useSpeakingParticipants().map((p) => p.identity));
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const screen = tracks.find((t) => t.source === Track.Source.ScreenShare && t.publication && !t.publication.isMuted);
  const cameraOf = (identity: string) =>
    tracks.find((t) => t.source === Track.Source.Camera && t.participant.identity === identity && t.publication && !t.publication.isMuted && t.publication.track) as TrackReference | undefined;

  const n = participants.length;
  const size = screen ? "size-20" : n <= 2 ? "size-36 sm:size-44" : n <= 4 ? "size-28 sm:size-32" : "size-20 sm:size-24";
  const names = participants.map((p) => (p.isLocal ? "You" : p.name || p.identity));

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-6 px-4 py-4">
      {!screen && n >= 2 && (
        <p className="call-title text-center text-lg font-medium tracking-tight text-white/90 sm:text-xl">
          {n === 2 ? (
            <>
              {names[0]} <span className="px-1.5 text-[var(--call-ring)]" aria-hidden>⇄</span>
              <span className="sr-only">and</span> {names[1]}
            </>
          ) : (
            `${names.slice(0, 3).join(", ")}${n > 3 ? ` +${n - 3}` : ""}`
          )}
        </p>
      )}

      {screen && (
        <div className="min-h-0 w-full max-w-5xl flex-1 overflow-hidden rounded-3xl border border-white/10 bg-black/40">
          <FocusLayout trackRef={screen} className="size-full" />
        </div>
      )}

      <ul className={cn("flex flex-wrap items-start justify-center", screen ? "gap-4" : n <= 2 ? "gap-12 sm:gap-20" : "gap-8")} aria-label="People in this call">
        {participants.map((p) => {
          const name = p.name || p.identity;
          const talking = speaking.has(p.identity);
          const cam = cameraOf(p.identity);
          const lang = languageOf(p.identity);
          return (
            <li key={p.identity} className="grid justify-items-center gap-2.5">
              <div className={cn("call-avatar relative rounded-full", talking && "is-speaking")}>
                <div className={cn(size, "relative grid place-items-center overflow-hidden rounded-full bg-[var(--call-key)] ring-1 ring-white/15")}>
                  {cam ? (
                    <VideoTrack trackRef={cam} className={cn("size-full object-cover", p.isLocal && "-scale-x-100")} />
                  ) : (
                    <span className={cn("font-medium text-white/90", n <= 2 && !screen ? "text-4xl sm:text-5xl" : "text-2xl")}>{initials(name)}</span>
                  )}
                </div>
                {!p.isMicrophoneEnabled && (
                  <span className="absolute right-1 bottom-1 grid size-8 place-items-center rounded-full bg-[var(--call-end)] text-white ring-4 ring-[var(--call-bg)]">
                    <MicOff className="size-4" aria-label="Muted" />
                  </span>
                )}
              </div>
              <p className="text-sm font-medium text-white sm:text-base">
                {name}
                {p.isLocal && <span className="font-normal text-white/50"> (you)</span>}
              </p>
              <div className="flex items-center gap-1.5 text-xs">
                {lang && <span className="rounded-full bg-white/10 px-2 py-0.5 text-white/85">{languageName(lang)}</span>}
                <span className={cn(talking ? "text-[var(--call-ring)]" : "text-white/45")}>{talking ? "speaking" : p.isMicrophoneEnabled ? "listening" : "muted"}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
