"use client";

import { useEffect, useRef, useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Track, type LocalAudioTrack } from "livekit-client";
import { AudioWaveform, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createRnnoiseProcessor, loadNoiseMode, NOISE_MODES, saveNoiseMode, type NoiseMode } from "@/lib/audio/noise";
import { cn } from "@/lib/utils";

/** "Voice cancellation": choose how much background noise is removed from your microphone. */
export function NoiseControl() {
  const { microphoneTrack } = useLocalParticipant();
  const track = microphoneTrack?.track as LocalAudioTrack | undefined;
  const [mode, setMode] = useState<NoiseMode>(() => (typeof window === "undefined" ? "standard" : loadNoiseMode()));
  const [applied, setApplied] = useState<NoiseMode | null>(null);
  // Changes are applied one at a time, in order; the label shows only what has really been applied.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const wanted = useRef(mode);
  const done = useRef<{ track: LocalAudioTrack; mode: NoiseMode } | null>(null);

  useEffect(() => {
    wanted.current = mode;
    if (!track || track.source !== Track.Source.Microphone) return;
    chain.current = chain.current.then(async () => {
      if (wanted.current !== mode) return; // superseded by a newer choice
      if (done.current?.track === track && done.current.mode === mode) return setApplied(mode);
      try {
        // Keep the microphone the user picked; echo cancellation always stays on so remote voices
        // played through speakers aren't heard as this user (e.g. by the voice assistant).
        const deviceId = track.mediaStreamTrack?.getSettings().deviceId;
        const dsp = mode !== "off";
        await track.restartTrack({ ...(deviceId ? { deviceId: { exact: deviceId } } : {}), noiseSuppression: dsp, autoGainControl: dsp, echoCancellation: true });
        if (mode === "enhanced") await track.setProcessor(createRnnoiseProcessor());
        else if (track.getProcessor()) await track.stopProcessor();
        done.current = { track, mode };
        if (wanted.current === mode) setApplied(mode);
      } catch (err) {
        done.current = null;
        toast.error(`Couldn't apply noise cancellation: ${(err as Error).message}`);
        setApplied(null);
      }
    });
  }, [track, mode]);

  const choose = (m: NoiseMode) => {
    saveNoiseMode(m);
    setMode(m);
  };
  // The label reports what is actually applied, not just what was chosen.
  const active = applied ?? "standard";
  const pending = applied !== mode;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={`Noise cancellation: ${pending ? "applying…" : NOISE_MODES.find((n) => n.mode === active)!.label}`}
          title="Noise cancellation"
          className={cn("rounded-full text-white hover:bg-white/10 hover:text-white", active === "enhanced" && "bg-emerald-600/70 hover:bg-emerald-600")}
        >
          <AudioWaveform />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top" className="w-72">
        <DropdownMenuLabel>Noise cancellation</DropdownMenuLabel>
        {NOISE_MODES.map((n) => (
          <DropdownMenuItem key={n.mode} onSelect={() => choose(n.mode)}>
            <span className="flex-1">
              <span className="block font-medium">{n.label}</span>
              <span className="block text-xs text-muted-foreground">{n.hint}</span>
            </span>
            {mode === n.mode && <Check aria-label="Selected" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
