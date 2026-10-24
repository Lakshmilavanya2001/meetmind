"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePreviewTracks } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import { ArrowLeft, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/format";
import type { DeviceChoices, Me, MeetingInfo } from "./types";

export function Lobby(props: {
  meeting: MeetingInfo;
  me: Me;
  error?: string;
  joining: boolean;
  joiningIndicator: React.ReactNode;
  onJoin: (c: DeviceChoices) => void;
}) {
  const { meeting, me } = props;
  const [audioEnabled, setAudio] = useState(true);
  const [videoEnabled, setVideo] = useState(meeting.callType === "VIDEO");
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const options = useMemo(() => ({ audio: audioEnabled, video: videoEnabled }), [audioEnabled, videoEnabled]);
  const tracks = usePreviewTracks(options, (e) =>
    setDeviceError(
      e.name === "NotAllowedError"
        ? "Camera/microphone permission was denied. You can still join and enable devices later."
        : `Could not access your devices: ${e.message}`,
    ),
  );
  const videoTrack = tracks?.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
  const videoEl = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!videoEl.current || !videoTrack) return;
    const el = videoEl.current;
    videoTrack.attach(el);
    return () => {
      videoTrack.detach(el);
    };
  }, [videoTrack]);

  return (
    <main className="call-screen flex min-h-dvh flex-col">
      <header className="flex h-14 items-center px-4">
        <Button variant="ghost" asChild className="text-white/80 hover:bg-white/10 hover:text-white">
          <Link href="/dashboard"><ArrowLeft /> Dashboard</Link>
        </Button>
      </header>
      <div className="mx-auto grid w-full max-w-md flex-1 content-center justify-items-center gap-7 px-4 pb-12 text-center">
        <div className="grid justify-items-center gap-1.5">
          <p className="text-xs tracking-wide text-white/55 uppercase">{meeting.callType === "VOICE" ? "Voice call" : "Call"} · {meeting.status === "LIVE" ? "in progress" : "ready"}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{meeting.title}</h1>
          <p className="text-sm text-white/60">
            Hosted by {meeting.hostName} · <span className="font-mono">{meeting.joinCode}</span>
          </p>
        </div>

        <div className="call-avatar relative rounded-full">
          <div className="grid size-44 place-items-center overflow-hidden rounded-full bg-[var(--call-key)] ring-1 ring-white/15">
            {videoEnabled && videoTrack ? (
              <video ref={videoEl} className="size-full -scale-x-100 object-cover" muted playsInline aria-label="Your camera preview" />
            ) : (
              <Avatar className="size-full">
                <AvatarFallback className="bg-transparent text-5xl font-medium text-white/90">{initials(me.displayName)}</AvatarFallback>
              </Avatar>
            )}
          </div>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          <Badge variant="secondary" className="bg-white/10 text-white">Joining as {me.displayName}</Badge>
          {me.role !== "ATTENDEE" && <Badge className="bg-[var(--call-ring)] text-[var(--call-bg)]">{me.role === "HOST" ? "Host" : "Co-host"}</Badge>}
        </div>

        <div className="flex items-start justify-center gap-6">
          <div className="phone-key">
            <Button
              size="icon-lg"
              variant="ghost"
              className="text-white hover:text-white"
              onClick={() => setAudio((v) => !v)}
              aria-pressed={!audioEnabled}
              aria-label={audioEnabled ? "Turn microphone off" : "Turn microphone on"}
            >
              {audioEnabled ? <Mic /> : <MicOff />}
            </Button>
            <span className="phone-key-label" aria-hidden>{audioEnabled ? "Mic on" : "Mic off"}</span>
          </div>
          <div className="phone-key">
            <Button
              size="icon-lg"
              variant="ghost"
              className="text-white hover:text-white"
              onClick={() => setVideo((v) => !v)}
              aria-pressed={videoEnabled}
              aria-label={videoEnabled ? "Turn camera off" : "Turn camera on"}
            >
              {videoEnabled ? <Video /> : <VideoOff />}
            </Button>
            <span className="phone-key-label" aria-hidden>{videoEnabled ? "Camera on" : "Camera off"}</span>
          </div>
        </div>

        {(props.error || deviceError) && (
          <Alert variant={props.error ? "destructive" : "default"} className="border-white/15 bg-white/5 text-left text-white">
            <AlertDescription className="text-white/80">{props.error ?? deviceError}</AlertDescription>
          </Alert>
        )}
        <Button
          size="lg"
          disabled={props.joining}
          onClick={() => props.onJoin({ audioEnabled, videoEnabled })}
          className="h-14 w-full max-w-xs rounded-full bg-[var(--call-ring)] text-base font-semibold text-[var(--call-bg)] hover:bg-[var(--call-ring)]/90"
        >
          {props.joining && props.joiningIndicator}
          {props.joining ? "Joining…" : "Join now"}
        </Button>
      </div>
    </main>
  );
}
