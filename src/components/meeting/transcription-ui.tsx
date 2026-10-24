"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CircleDot, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import type { CaptureStatus, TranscriptionState } from "./use-transcription";

/** Always-visible disclosure while transcription is on, with this participant's own consent control. */
export function TranscriptionBanner({ meetingRef, state, onChange, capture, interpreter = false }: { meetingRef: string; state: TranscriptionState; onChange: (s: TranscriptionState) => void; capture: CaptureStatus; interpreter?: boolean }) {
  const [busy, setBusy] = useState(false);
  if (!state.enabled) return null;
  async function consent(value: boolean) {
    setBusy(true);
    try {
      onChange(await api<TranscriptionState>(`/api/meetings/${meetingRef}/transcription/consent`, { method: "POST", json: { consent: value } }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update consent");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-red-500/30 bg-red-950/60 px-4 py-2 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <span className="size-2 animate-pulse rounded-full bg-red-500" aria-hidden /> Transcription is on for this meeting.
      </span>
      {state.myConsent ? (
        <>
          <span className="text-white/70">
            {interpreter ? "Your voice is being transcribed and interpreted by the AI interpreter." : <>Your microphone audio is being transcribed{capture.active ? "" : " (starting…)"}.</>}
            {capture.lastError && <span className="ml-1 text-amber-300">{capture.lastError}</span>}
          </span>
          <Button size="sm" variant="ghost" className="h-7 text-white hover:bg-white/10" onClick={() => consent(false)} disabled={busy}>Stop transcribing me</Button>
        </>
      ) : (
        <>
          <span className="text-white/70">Your audio is <strong>not</strong> being transcribed.</span>
          <Button size="sm" className="h-7" onClick={() => consent(true)} disabled={busy}>Allow transcription of my audio</Button>
        </>
      )}
    </div>
  );
}

/** Host / co-host switch with an explicit confirmation explaining what happens. */
export function TranscriptionToggle({ meetingRef, state, onChange }: { meetingRef: string; state: TranscriptionState; onChange: (s: TranscriptionState) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!state.canManage) return null;
  async function set(enabled: boolean) {
    setBusy(true);
    try {
      onChange(await api<TranscriptionState>(`/api/meetings/${meetingRef}/transcription`, { method: "POST", json: { enabled, consentSelf: enabled } }));
      toast.success(enabled ? "Transcription started" : "Transcription stopped");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change transcription");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label={state.enabled ? "Stop transcription" : "Start transcription"}
        title={state.enabled ? "Stop transcription" : state.sttConfigured ? "Start transcription" : "Transcription isn't configured on this server"}
        aria-pressed={state.enabled}
        disabled={busy || (!state.enabled && !state.sttConfigured)}
        onClick={() => (state.enabled ? set(false) : setOpen(true))}
        className={state.enabled ? "rounded-full bg-red-600/80 text-white hover:bg-red-600" : "rounded-full text-white hover:bg-white/10 hover:text-white"}
      >
        {busy ? <Loader2 className="animate-spin" /> : <CircleDot />}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start transcription?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                <p>Everyone in the call will see that transcription is on.</p>
                <p>Each person&apos;s audio is only transcribed after <strong>they</strong> choose “Allow”. Starting it also allows transcription of <strong>your</strong> microphone.</p>
                <p>Audio is converted to text and then discarded; the transcript is visible to meeting participants and kept according to your workspace&apos;s retention setting.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => set(true)}>Start transcription</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type Segment = { id: string; startMs: number; speakerLabel: string; text: string };
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Live transcript inside the call (polls for new segments). */
export function LiveTranscriptPanel({ meetingRef, enabled }: { meetingRef: string; enabled: boolean }) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api<{ segments: Segment[] }>(`/api/meetings/${meetingRef}/transcript`);
        if (!cancelled) {
          setSegments(res.segments);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load transcript");
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [meetingRef]);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup function.
    endRef.current?.scrollIntoView({ block: "end" });
  }, [segments.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-white/60">
        <span>{enabled ? "Updates every few seconds." : "Transcription is off."}</span>
        <Link href={`/meetings/${meetingRef}/transcript`} target="_blank" className="flex items-center gap-1 text-indigo-300 hover:underline">
          Full view <ExternalLink className="size-3" aria-hidden />
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : segments.length === 0 ? (
          <p className="text-sm text-white/60">{enabled ? "Nothing transcribed yet. Text appears a few seconds after people speak." : "Start transcription to see a live transcript here."}</p>
        ) : (
          <ol className="grid gap-3 text-sm">
            {segments.map((s) => (
              <li key={s.id}>
                <p className="text-xs text-white/50"><span className="font-medium text-white/80">{s.speakerLabel}</span> · {clock(s.startMs)}</p>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
