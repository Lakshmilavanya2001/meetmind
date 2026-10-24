"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileUp, Loader2, Mic, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { EmptyState } from "@/components/common/empty-state";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RecordingUpload, TranscriptImport } from "./transcript-uploads";
import { DeliveryCard, SpeakersCard, speakerColor } from "./call-panels";
import { AskBox } from "@/components/transcripts/ask-box";

type Segment = { id: string; startMs: number; endMs: number; speakerLabel: string; speakerUserId: string | null; text: string; source: string };
type TranscriptData = {
  meeting: { id: string; title: string; joinCode: string; status: string; startedAt: string | null };
  canManage: boolean;
  isHost: boolean;
  transcript: { status: string; error: string | null; expiresAt: string | null } | null;
  processing: { pending: number; failed: number };
  segments: Segment[];
};
type Evidence = { segment: number; startMs: number; speaker: string };
type Summary = {
  id: string;
  createdAt: string;
  createdBy: string | null;
  stale: boolean;
  content: string;
  decisions: { text: string; evidence: Evidence[] }[];
  openIssues: { text: string; evidence: Evidence[] }[];
  actionItems: { id: string; description: string; owner: string | null; ownerIsUser: boolean; dueDate: string | null; status: "OPEN" | "DONE"; sourceStartMs: number | null }[];
} | null;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return <>{parts.map((p, i) => (p.toLowerCase() === q.toLowerCase() ? <mark key={i} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-500/40">{p}</mark> : p))}</>;
}

export function TranscriptWorkspace({ initial, initialSummary, userTimezone, sttConfigured, openSample = false }: { initial: TranscriptData; initialSummary: Summary; userTimezone: string; sttConfigured: boolean; openSample?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [summary, setSummary] = useState<Summary>(initialSummary);
  const [q, setQ] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [jumpTo, setJumpTo] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Deep links from citations: /meetings/<code>/transcript#t=<ms>
  useEffect(() => {
    const read = () => {
      const m = /^#t=(\d+)$/.exec(window.location.hash);
      if (m) setJumpTo(Number(m[1]));
    };
    const t = setTimeout(read, 0);
    window.addEventListener("hashchange", read);
    return () => {
      clearTimeout(t);
      window.removeEventListener("hashchange", read);
    };
  }, []);
  const ref = data.meeting.joinCode;
  const processing = data.transcript?.status === "PROCESSING" || data.processing.pending > 0;

  const reload = useCallback(async () => {
    try {
      setData(await api<TranscriptData>(`/api/meetings/${ref}/transcript`));
    } catch {
      /* keep */
    }
  }, [ref]);

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [processing, reload]);

  // After a call or recording, the summary is made automatically on the server: pick it up.
  useEffect(() => {
    if (summary || processing || data.segments.length === 0) return;
    let n = 0;
    const t = setInterval(async () => {
      if (++n > 30) return clearInterval(t);
      try {
        const r = await api<{ summary: Summary }>(`/api/meetings/${ref}/summary`);
        if (r.summary) {
          setSummary(r.summary);
          clearInterval(t);
        }
      } catch {
        /* keep polling */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [summary, processing, data.segments.length, ref]);
  const speakerLabels = useMemo(() => [...new Set(data.segments.map((s) => s.speakerLabel))], [data.segments]);

  useEffect(() => {
    if (jumpTo === null) return;
    // The segment containing the moment (last one starting at or before it).
    const seg = [...data.segments].reverse().find((s) => s.startMs <= jumpTo) ?? data.segments[0];
    if (seg) {
      document.getElementById(`seg-${seg.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      const t = setTimeout(() => setHighlightId(seg.id), 0);
      return () => clearTimeout(t);
    }
  }, [jumpTo, data.segments]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? data.segments.filter((s) => s.text.toLowerCase().includes(needle) || s.speakerLabel.toLowerCase().includes(needle)) : data.segments;
  }, [data.segments, q]);

  async function summarize() {
    setSummarizing(true);
    try {
      const res = await api<{ summary: Summary }>(`/api/meetings/${ref}/summary`, { method: "POST" });
      setSummary(res.summary);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not summarise");
    } finally {
      setSummarizing(false);
    }
  }

  async function toggleItem(id: string, done: boolean) {
    setSummary((s) => s && { ...s, actionItems: s.actionItems.map((a) => (a.id === id ? { ...a, status: done ? "DONE" : "OPEN" } : a)) });
    try {
      await api(`/api/meetings/${ref}/action-items/${id}`, { method: "PATCH", json: { status: done ? "DONE" : "OPEN" } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update");
    }
  }

  async function remove() {
    try {
      await api(`/api/meetings/${ref}/transcript`, { method: "DELETE" });
      toast.success("Transcript and summaries deleted");
      setSummary(null);
      await reload();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  }

  const TimeLink = ({ ms }: { ms: number }) => (
    <button type="button" onClick={() => setJumpTo(ms)} className="font-mono text-xs text-primary underline-offset-2 hover:underline">{clock(ms)}</button>
  );
  const hasSegments = data.segments.length > 0;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transcript</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {data.meeting.title}
            {data.transcript && (
              <Badge variant={data.transcript.status === "COMPLETED" ? "secondary" : data.transcript.status === "FAILED" ? "destructive" : "outline"}>
                {processing ? <><Loader2 className="size-3 animate-spin" aria-hidden /> Processing{data.processing.pending ? ` · ${data.processing.pending} pending` : ""}</> : data.transcript.status.toLowerCase()}
              </Badge>
            )}
            {data.transcript?.expiresAt && <span>· deleted automatically on {formatDateTime(data.transcript.expiresAt, userTimezone, { timeStyle: undefined })}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasSegments && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm"><Download aria-hidden /> Download</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(["txt", "vtt", "srt", "json"] as const).map((f) => (
                  <DropdownMenuItem key={f} asChild>
                    <a href={`/api/meetings/${ref}/transcript/export?format=${f}`} download>{f.toUpperCase()}</a>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {data.canManage && (
            <>
              <RecordingUpload meetingRef={ref} disabled={!sttConfigured} onDone={reload} openWithSample={openSample} />
              <TranscriptImport meetingRef={ref} hasExisting={hasSegments} onDone={reload} />
            </>
          )}
          {data.isHost && data.transcript && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive"><Trash2 aria-hidden /> Delete</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this transcript?</AlertDialogTitle>
                  <AlertDialogDescription>The transcript, its summaries and action items are permanently deleted for everyone. This can&apos;t be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={remove}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {data.transcript?.error && <Alert><AlertDescription>{data.transcript.error}</AlertDescription></Alert>}

      {hasSegments && <SpeakersCard meetingRef={ref} segments={data.segments} canManage={data.canManage} onRenamed={reload} />}

      {hasSegments && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ask about this meeting</CardTitle>
            <CardDescription>Answers come only from this transcript, with links to the moments they&apos;re based on.</CardDescription>
          </CardHeader>
          <CardContent>
            <AskBox meetings={[ref]} placeholder="e.g. What did Rahul say about the deadline?" />
          </CardContent>
        </Card>
      )}

      {hasSegments && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" aria-hidden /> Summary</CardTitle>
              <CardDescription>
                {summary ? <>Generated {formatDateTime(summary.createdAt, userTimezone)}{summary.createdBy ? ` by ${summary.createdBy}` : ""}. Every item links to the moment it was said.</> : "Generate a summary with decisions, action items and open issues."}
              </CardDescription>
            </div>
            <Button size="sm" variant={summary ? "outline" : "default"} onClick={summarize} disabled={summarizing}>
              {summarizing ? <Loader2 className="animate-spin" aria-hidden /> : summary ? <RefreshCw aria-hidden /> : <Sparkles aria-hidden />} {summary ? "Regenerate" : "Summarise"}
            </Button>
          </CardHeader>
          {summary && (
            <CardContent className="grid gap-5 text-sm">
              {(summary.stale || processing) && <p className="text-xs text-amber-700 dark:text-amber-400">The transcript has changed since this summary was made — regenerate to include the latest.</p>}
              <section>
                <h3 className="mb-2 font-semibold">Key discussion points</h3>
                <ul className="grid list-disc gap-1 pl-5">{summary.content.split("\n").map((l, i) => <li key={i}>{l.replace(/^-\s*/, "")}</li>)}</ul>
              </section>
              <section>
                <h3 className="mb-2 font-semibold">Decisions</h3>
                {summary.decisions.length === 0 ? <p className="text-muted-foreground">No explicit decisions were recorded.</p> : (
                  <ul className="grid gap-1.5">{summary.decisions.map((d, i) => <li key={i} className="flex gap-2"><span className="flex shrink-0 gap-1">{d.evidence.slice(0, 2).map((e) => <TimeLink key={e.segment} ms={e.startMs} />)}</span><span>{d.text}</span></li>)}</ul>
                )}
              </section>
              <section>
                <h3 className="mb-2 font-semibold">Action items</h3>
                {summary.actionItems.length === 0 ? <p className="text-muted-foreground">No action items were recorded.</p> : (
                  <ul className="grid gap-2">
                    {summary.actionItems.map((a) => (
                      <li key={a.id} className="flex items-start gap-2">
                        <input type="checkbox" className="mt-1 size-4 accent-primary" checked={a.status === "DONE"} onChange={(e) => toggleItem(a.id, e.target.checked)} aria-label={`Mark “${a.description}” done`} />
                        <span className={cn(a.status === "DONE" && "text-muted-foreground line-through")}>
                          {a.description}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {a.owner ? `${a.owner}${a.ownerIsUser ? "" : " (not matched to an account)"}` : "No owner"}
                            {a.dueDate ? ` · due ${formatDateTime(a.dueDate, userTimezone, { timeStyle: undefined })}` : ""}
                          </span>
                          {a.sourceStartMs !== null && <span className="ml-2"><TimeLink ms={a.sourceStartMs} /></span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {summary.openIssues.length > 0 && (
                <section>
                  <h3 className="mb-2 font-semibold">Open issues</h3>
                  <ul className="grid gap-1.5">{summary.openIssues.map((o, i) => <li key={i} className="flex gap-2"><span className="shrink-0"><TimeLink ms={o.evidence[0].startMs} /></span><span>{o.text}</span></li>)}</ul>
                </section>
              )}
              <p className="text-xs text-muted-foreground">AI-generated from the transcript. Items without supporting transcript lines are discarded automatically.</p>
            </CardContent>
          )}
        </Card>
      )}

      {hasSegments && <DeliveryCard meetingRef={ref} summaryId={summary?.id ?? null} userTimezone={userTimezone} />}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">Full transcript</CardTitle>
          {hasSegments && (
            <div className="relative sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this transcript" className="pl-8" aria-label="Search this transcript" />
            </div>
          )}
        </CardHeader>
        <CardContent>
          {!hasSegments ? (
            <EmptyState
              icon={processing ? Loader2 : Mic}
              title={processing ? "Transcribing…" : "No transcript yet"}
              description={processing ? "Text appears here as audio is processed." : data.canManage ? "Turn on transcription during the call, upload a recording, or import a transcript file." : "Nobody has transcribed this meeting."}
            />
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches “{q}”.</p>
          ) : (
            <ol className="grid gap-3" aria-label="Transcript">
              {filtered.map((s) => (
                <li key={s.id} id={`seg-${s.id}`} aria-current={highlightId === s.id ? "true" : undefined} className={cn("grid grid-cols-[3.5rem_1fr] gap-3 rounded-md px-1 py-0.5 transition-colors", highlightId === s.id && "bg-primary/10 ring-1 ring-primary/30")}>
                  <span className="pt-0.5 font-mono text-xs text-muted-foreground">{clock(s.startMs)}</span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><span className={cn("size-2 rounded-full", speakerColor(speakerLabels, s.speakerLabel))} aria-hidden />{s.speakerLabel}</p>
                    <p className="text-sm leading-relaxed"><Highlight text={s.text} q={q.trim()} /></p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><FileUp className="size-3.5" aria-hidden /> Speech is machine-transcribed and may contain errors. In calls, speaker names come from each participant&apos;s own microphone; in uploaded recordings, voices are separated automatically (Speaker 1, Speaker 2…) and can be renamed.</p>
    </>
  );
}
