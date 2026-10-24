"use client";

import { useSyncExternalStore } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { MeetingInfo, MeetingRole } from "./types";

const ROLE_LABEL: Record<MeetingRole, string> = { HOST: "Host", COHOST: "Co-host", ATTENDEE: "Attendee" };

export function DetailsPanel({ meeting, myRole }: { meeting: MeetingInfo; myRole: MeetingRole }) {
  const link = useSyncExternalStore(
    () => () => {},
    () => `${window.location.origin}/m/${meeting.joinCode}`,
    () => "",
  );
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error("Copy failed"));

  return (
    <dl className="grid gap-4 p-4 text-sm">
      <Row label="Title">{meeting.title}</Row>
      <Row label="Host">{meeting.hostName}</Row>
      <Row label="Your role">{ROLE_LABEL[myRole]}</Row>
      <Row label="Meeting code">
        <span className="flex items-center gap-2">
          <span className="font-mono">{meeting.joinCode}</span>
          <Button size="icon-xs" variant="ghost" className="text-white hover:bg-white/10" onClick={() => copy(meeting.joinCode, "Code")} aria-label="Copy meeting code"><Copy /></Button>
        </span>
      </Row>
      <Row label="Joining link">
        <span className="flex items-start gap-2">
          <span className="font-mono text-xs break-all text-white/80">{link}</span>
          <Button size="icon-xs" variant="ghost" className="shrink-0 text-white hover:bg-white/10" onClick={() => copy(link, "Link")} aria-label="Copy joining link"><Copy /></Button>
        </span>
        <p className="mt-1 text-xs text-white/50">Anyone in your workspace with this link can join.</p>
      </Row>
      <Row label="Transcription">{meeting.transcriptionEnabled ? "On" : "Off"}</Row>
      <Row label="Recording">{meeting.recordingEnabled ? "On" : "Off"}</Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-white/50 uppercase">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}
