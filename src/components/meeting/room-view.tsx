"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutContextProvider, LiveKitRoom, RoomAudioRenderer, StartAudio, useConnectionState, useParticipants, useRoomContext } from "@livekit/components-react";
import { ConnectionState, DisconnectReason } from "livekit-client";
import { FileText, Info, MessageSquare, PhoneOff, Sparkles, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { ParticipantsPanel } from "./participants-panel";
import { CameraKey, MicKey, ShareKey } from "./media-controls";
import { Key } from "./phone-key";
import { NoiseControl } from "./noise-control";
import { CallStatusBanner } from "./call-status";
import { PhoneStage } from "./phone-stage";
import { VoiceAssistant, playSpeech } from "./voice-assistant";
import { CaptionsControl, CaptionsOverlay, loadCaptionChoice } from "./captions";
import { useInterpreter } from "./use-interpreter";
import { InterpreterControl, InterpreterPanel } from "./interpreter-ui";
import { PanelBoundary } from "./panel-boundary";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { useTranscriptionCapture, useTranscriptionState } from "./use-transcription";
import { LiveTranscriptPanel, TranscriptionBanner, TranscriptionToggle } from "./transcription-ui";
import { ChatPanel } from "./chat-panel";
import { DetailsPanel } from "./details-panel";
import type { DeviceChoices, JoinResponse, Me, MeetingInfo } from "./types";

type Panel = "participants" | "chat" | "details" | "assistant" | "transcript" | null;

export function RoomView(props: {
  meeting: MeetingInfo;
  me: Me;
  join: JoinResponse;
  choices: DeviceChoices;
  onLeft: (reason?: DisconnectReason) => void;
}) {
  const { join, choices, onLeft } = props;
  return (
    <LiveKitRoom
      serverUrl={join.serverUrl}
      token={join.token}
      connect
      audio={choices.audioEnabled}
      video={choices.videoEnabled}
      options={{ adaptiveStream: true, dynacast: true }}
      onDisconnected={(reason) => onLeft(reason)}
      onError={(e) => toast.error(`Call error: ${e.message}`)}
      onMediaDeviceFailure={() => toast.error("Could not access your camera or microphone.")}
      data-lk-theme="default"
      // Inline style on purpose: LiveKit's unlayered `.lk-room-container { height: 100% }` overrides
      // Tailwind's layered utilities, which let the video grid grow past the viewport.
      style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
      className="call-screen overflow-hidden text-white"
    >
      <LayoutContextProvider>
        <InCall {...props} />
      </LayoutContextProvider>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function useElapsed(since: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

const CONNECTION_LABEL: Record<ConnectionState, { text: string; tone: string }> = {
  [ConnectionState.Connected]: { text: "Connected", tone: "bg-emerald-500" },
  [ConnectionState.Connecting]: { text: "Connecting…", tone: "bg-amber-400" },
  [ConnectionState.Reconnecting]: { text: "Reconnecting…", tone: "bg-amber-400" },
  [ConnectionState.SignalReconnecting]: { text: "Reconnecting…", tone: "bg-amber-400" },
  [ConnectionState.Disconnected]: { text: "Disconnected", tone: "bg-red-500" },
};

function InCall({ meeting, me, join }: { meeting: MeetingInfo; me: Me; join: JoinResponse }) {
  const room = useRoomContext();
  const connection = useConnectionState();
  const participants = useParticipants();
  const elapsed = useElapsed(join.sessionStartedAt);
  const [panel, setPanel] = useState<Panel>(null);
  const [myRole, setMyRole] = useState(join.myRole);
  const { state: tState, setState: setTState } = useTranscriptionState(meeting.joinCode);
  const interp = useInterpreter(meeting.joinCode);
  // The server agent (the AI interpreter process) transcribes everyone live from the call itself whenever it's in the
  // room (interpretation or transcription on). Only without it does the browser upload its own audio in pieces.
  const capturing = !!tState?.enabled && !!tState?.myConsent && !interp.agentPresent && connection === ConnectionState.Connected;
  const capture = useTranscriptionCapture(meeting.joinCode, capturing);

  // Spoken disclosure (as on phone networks): everyone hears it when transcription is switched on.
  const announced = useRef<boolean | null>(null);
  useEffect(() => {
    if (!tState) return;
    if (announced.current === null) {
      announced.current = tState.enabled; // already on when I joined → the banner covers it
      if (!tState.enabled) return;
    }
    if (tState.enabled && !announced.current) {
      announced.current = true;
      api<{ speech: { text: string; language: string; audioBase64?: string; mimeType?: string } }>("/api/voice/announcement")
        .then((r) => playSpeech(r.speech))
        .catch(() => {});
    }
    if (!tState.enabled) announced.current = false;
  }, [tState]);
  const [captions, setCaptions] = useState(() => (typeof window === "undefined" ? "off" : loadCaptionChoice()));
  // Keep the in-call assistant conversation while the panel is closed and reopened.
  const [assistantConv, setAssistantConv] = useState<string | null>(null);
  const isModerator = myRole === "HOST" || myRole === "COHOST";
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  const languageName = (code: string) => {
    const full = interp.state?.languages.find((l) => l.code === code)?.name ?? code;
    return full.match(/\(([^)]+)\)$/)?.[1] ?? full; // "తెలుగు (Telugu)" → "Telugu"
  };
  const languageOf = (identity: string) => (interp.enabled ? interp.roster.languages[identity] : undefined);

  const endForAll = useCallback(async () => {
    try {
      await api(`/api/meetings/${meeting.joinCode}/end`, { method: "POST" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not end the meeting");
    }
  }, [meeting.joinCode]);

  const conn = CONNECTION_LABEL[connection];

  return (
    <>
      <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-white/70" role="status">
            <span className={cn("size-2 rounded-full", conn.tone)} aria-hidden /> {conn.text}
          </span>
        </div>
        <div className="grid justify-items-center leading-tight">
          <h1 className="max-w-[50vw] truncate text-xs text-white/60">{meeting.title}</h1>
          <span className="font-mono text-base font-medium text-white tabular-nums" aria-label="Meeting duration">{elapsed}</span>
        </div>
        <div className="flex items-center justify-end gap-2">
          {meeting.callType === "VOICE" && <Badge variant="secondary" className="hidden sm:inline-flex">Voice call</Badge>}
          {tState?.enabled && <Badge variant="destructive">Transcribing</Badge>}
          {meeting.recordingEnabled && <Badge variant="destructive">Recording</Badge>}
          <Badge variant="secondary" className="hidden bg-white/10 text-white sm:inline-flex">
            <Users className="size-3" aria-hidden /> {participants.length}
          </Badge>
        </div>
      </header>

      {meeting.isDirectCall && <CallStatusBanner meetingRef={meeting.joinCode} />}
      {tState && <TranscriptionBanner meetingRef={meeting.joinCode} state={tState} onChange={setTState} capture={capture} interpreter={interp.enabled} live={interp.agentPresent} />}

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <PhoneStage languageOf={languageOf} languageName={languageName} />
          </div>
          <InterpreterPanel interp={interp} myUserId={me.id} />
        </div>

        {panel && (
          <aside
            className="absolute inset-0 z-20 flex flex-col bg-[var(--call-bg)] md:static md:m-3 md:w-80 md:shrink-0 md:overflow-hidden md:rounded-3xl md:border md:border-white/10 md:bg-white/[0.04]"
            aria-label={`${panel} panel`}
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-4">
              <h2 className="text-sm font-semibold capitalize">{panel === "details" ? "Meeting details" : panel}</h2>
              <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10" onClick={() => setPanel(null)} aria-label="Close panel">
                <X />
              </Button>
            </div>
            <div className={cn("min-h-0 flex-1", panel === "assistant" || panel === "transcript" ? "flex flex-col" : "overflow-y-auto")}>
              <PanelBoundary key={panel} name={panel}>
              {panel === "participants" && (
                <ParticipantsPanel meetingRef={meeting.joinCode} meId={me.id} onMyRole={setMyRole} myRole={myRole} />
              )}
              {panel === "chat" && <ChatPanel />}
              {panel === "details" && <DetailsPanel meeting={meeting} myRole={myRole} />}
              {panel === "transcript" && <LiveTranscriptPanel meetingRef={meeting.joinCode} enabled={!!tState?.enabled} />}
              {panel === "assistant" && (
                <AssistantChat dark meetingRef={meeting.joinCode} conversationId={assistantConv} onConversation={setAssistantConv} className="h-full" />
              )}
              </PanelBoundary>
            </div>
          </aside>
        )}
      </div>

      <CaptionsOverlay meetingRef={meeting.joinCode} choice={captions} transcriptionEnabled={!!tState?.enabled} myUserId={me.id} />
      <footer className="grid shrink-0 justify-items-center gap-4 px-3 pt-2 pb-5">
        {/* Main keys, like a phone's in-call screen, with the big End key in the middle. */}
        <div className="flex items-start justify-center gap-2 sm:gap-6">
          <MicKey />
          <CameraKey />
          <Key label="Language">
            <InterpreterControl interp={interp} />
          </Key>
          <div className="phone-key">
            <Button onClick={() => room.disconnect()} aria-label="Leave" title="Leave the call" className="phone-key-end size-16! rounded-full bg-[var(--call-end)] text-white shadow-lg shadow-black/30 hover:bg-[var(--call-end-hover)]">
              <PhoneOff className="size-6!" />
            </Button>
            <span className="phone-key-label" aria-hidden>End</span>
          </div>
          <Key label="Captions">
            <CaptionsControl choice={captions} onChange={setCaptions} myLanguage={me.language} />
          </Key>
          <Key label="Noise">
            <NoiseControl />
          </Key>
        </div>
        {/* Everything else, smaller. */}
        <div className="flex max-w-full flex-wrap items-start justify-center gap-x-2 gap-y-2 sm:gap-x-3">
          <PanelKey active={panel === "participants"} onClick={() => toggle("participants")} label="Participants" short="People" icon={<Users />} />
          <PanelKey active={panel === "chat"} onClick={() => toggle("chat")} label="Chat" short="Chat" icon={<MessageSquare />} />
          <PanelKey active={panel === "transcript"} onClick={() => toggle("transcript")} label="Transcript" short="Transcript" icon={<FileText />} />
          <PanelKey active={panel === "assistant"} onClick={() => toggle("assistant")} label="Assistant" short="Assistant" icon={<Sparkles />} />
          <Key label="Ask by voice" small>
            <div className="flex gap-2">
              <VoiceAssistant meetingRef={meeting.joinCode} conversationId={assistantConv} onConversation={setAssistantConv} />
            </div>
          </Key>
          {tState && (
            <Key label="Transcribe" small>
              <TranscriptionToggle meetingRef={meeting.joinCode} state={tState} onChange={setTState} />
            </Key>
          )}
          <ShareKey small />
          <PanelKey active={panel === "details"} onClick={() => toggle("details")} label="Meeting details" short="Details" icon={<Info />} />
          {isModerator && (
            <AlertDialog>
              <Key label="End for all" small>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" aria-label="End for all" className="text-[var(--call-end)] hover:text-white">
                    <PhoneOff />
                  </Button>
                </AlertDialogTrigger>
              </Key>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>End the meeting for everyone?</AlertDialogTitle>
                  <AlertDialogDescription>All {participants.length} participants will be disconnected.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={endForAll}>End meeting</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <StartAudio label="Click to enable audio" className="lk-button" />
      </footer>
    </>
  );
}

function PanelKey({ active, onClick, label, short, icon }: { active: boolean; onClick: () => void; label: string; short: string; icon: React.ReactNode }) {
  return (
    <Key label={short} small>
      <Button variant="ghost" onClick={onClick} aria-label={label} aria-pressed={active} title={label} className="text-white hover:text-white">
        {icon}
      </Button>
    </Key>
  );
}
