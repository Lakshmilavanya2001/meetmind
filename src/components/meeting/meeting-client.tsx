"use client";

import "@livekit/components-styles";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IncomingCallWatcher } from "@/components/calls/incoming-call";
import { DisconnectReason } from "livekit-client";
import { Loader2, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api } from "@/lib/api";
import { Lobby } from "./lobby";
import { RoomView } from "./room-view";
import type { DeviceChoices, JoinResponse, Me, MeetingInfo } from "./types";

type Phase =
  | { kind: "lobby"; error?: string }
  | { kind: "joining"; choices: DeviceChoices }
  | { kind: "in-call"; join: JoinResponse; choices: DeviceChoices }
  | { kind: "left"; reason: string };

const LEFT_REASONS: Partial<Record<DisconnectReason, string>> = {
  [DisconnectReason.PARTICIPANT_REMOVED]: "The host removed you from this meeting.",
  [DisconnectReason.ROOM_DELETED]: "The host ended the meeting for everyone.",
  [DisconnectReason.DUPLICATE_IDENTITY]: "You joined this meeting from another tab or device.",
  [DisconnectReason.SERVER_SHUTDOWN]: "The calling server restarted. Please rejoin.",
  [DisconnectReason.JOIN_FAILURE]: "Could not connect to the calling server.",
};

const isSecure = () => window.isSecureContext;

export function MeetingClient({ meeting, me, autoJoin = false }: { meeting: MeetingInfo; me: Me; autoJoin?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: "lobby" });
  // Camera/mic APIs only exist on HTTPS or localhost.
  const secure = useSyncExternalStore(() => () => {}, isSecure, () => true);

  const join = useCallback(
    async (choices: DeviceChoices) => {
      setPhase({ kind: "joining", choices });
      try {
        const res = await api<JoinResponse>(`/api/meetings/${meeting.joinCode}/join`, { method: "POST" });
        setPhase({ kind: "in-call", join: res, choices });
      } catch (err) {
        setPhase({ kind: "lobby", error: err instanceof Error ? err.message : "Could not join the meeting." });
      }
    },
    [meeting.joinCode],
  );

  // Answering a call (or placing one) skips the lobby: voice calls start with the camera off.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!autoJoin || autoJoined.current) return;
    autoJoined.current = true;
    const t = setTimeout(() => join({ audioEnabled: true, videoEnabled: meeting.callType === "VIDEO" }), 0);
    return () => clearTimeout(t);
  }, [autoJoin, join, meeting.callType]);

  const onLeft = useCallback((reason?: DisconnectReason) => {
    // Hanging up a direct call stops ringing anyone who hasn't answered yet.
    if (meeting.isDirectCall) api(`/api/meetings/${meeting.joinCode}/rings/cancel`, { method: "POST" }).catch(() => {});
    const removed = reason === DisconnectReason.PARTICIPANT_REMOVED;
    setPhase({ kind: "left", reason: (reason !== undefined && LEFT_REASONS[reason]) || (removed ? "" : "You left the meeting.") });
  }, [meeting.isDirectCall, meeting.joinCode]);

  if (!secure) {
    const httpsUrl = typeof window !== "undefined" ? `https://${window.location.hostname}:3443${window.location.pathname}` : "";
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <Alert className="max-w-lg">
          <ShieldAlert aria-hidden />
          <AlertTitle>Calls need a secure (HTTPS) connection</AlertTitle>
          <AlertDescription>
            <p>Browsers only allow camera and microphone access on HTTPS pages. Open this meeting through the HTTPS address instead:</p>
            <a className="mt-2 block font-mono text-primary underline break-all" href={httpsUrl}>{httpsUrl}</a>
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  if (phase.kind === "in-call") {
    return (
      <>
        <RoomView meeting={meeting} me={me} join={phase.join} choices={phase.choices} onLeft={onLeft} />
        <IncomingCallWatcher />
      </>
    );
  }

  if (phase.kind === "left") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
        <LogOut className="size-10 text-muted-foreground" aria-hidden />
        <h1 className="text-xl font-semibold">{phase.reason || "You left the meeting."}</h1>
        <p className="text-sm text-muted-foreground">{meeting.title}</p>
        <div className="flex gap-2">
          {!phase.reason.includes("removed") && (
            <Button variant="outline" onClick={() => setPhase({ kind: "lobby" })}>Rejoin</Button>
          )}
          <Button asChild><Link href="/dashboard">Back to dashboard</Link></Button>
        </div>
      </main>
    );
  }

  return (
    <Lobby
      meeting={meeting}
      me={me}
      error={phase.kind === "lobby" ? phase.error : undefined}
      joining={phase.kind === "joining"}
      onJoin={join}
      joiningIndicator={<Loader2 className="animate-spin" aria-hidden />}
    />
  );
}
