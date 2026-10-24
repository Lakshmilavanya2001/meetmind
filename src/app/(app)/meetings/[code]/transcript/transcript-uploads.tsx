"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, ApiError } from "@/lib/api";
import { decodeTo16kMono, encodeWav, splitForTranscription, TARGET_RATE } from "@/lib/audio/wav";

const MAX_RECORDING_MS = 2 * 3600_000;

/** Post-meeting fallback: decode a recording in the browser, split it, upload WAV chunks. */
const SAMPLE_URL = "/samples/sample-call.wav";

export function RecordingUpload({ meetingRef, disabled, onDone, openWithSample = false }: { meetingRef: string; disabled: boolean; onDone: () => void; openWithSample?: boolean }) {
  const [open, setOpen] = useState(openWithSample);
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [language, setLanguage] = useState("en");
  const [sample, setSample] = useState(openWithSample);

  async function loadSample() {
    try {
      const blob = await (await fetch(SAMPLE_URL)).blob();
      setFile(new File([blob], "sample-call.wav", { type: "audio/wav" }));
      setSample(true);
      setConsent(true); // synthetic voices: no real person's consent is needed
      setLanguage("en");
    } catch {
      toast.error("Couldn't load the sample call");
    }
  }
  useEffect(() => {
    if (!openWithSample) return;
    const t = setTimeout(loadSample, 0);
    return () => clearTimeout(t);
  }, [openWithSample]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!file) return;
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      const { samples, durationMs } = await decodeTo16kMono(file);
      if (durationMs > MAX_RECORDING_MS) throw new Error("Recordings longer than 2 hours aren't supported in the browser uploader.");
      const parts = splitForTranscription(samples);
      const { recordingId } = await api<{ recordingId: string }>(`/api/meetings/${meetingRef}/recordings`, {
        method: "POST",
        json: { fileName: file.name, durationMs, consentConfirmed: true, chunks: parts.length, language },
      });
      setProgress({ done: 0, total: parts.length });
      let done = 0;
      let next = 0;
      const worker = async () => {
        while (next < parts.length) {
          const i = next++;
          const p = parts[i];
          const form = new FormData();
          form.append("audio", encodeWav(p.samples), `part-${i}.wav`);
          form.append("index", String(i));
          form.append("startMs", String(Math.round((p.start / TARGET_RATE) * 1000)));
          form.append("durationMs", String(Math.max(200, Math.round((p.samples.length / TARGET_RATE) * 1000))));
          for (let attempt = 0; ; attempt++) {
            const res = await fetch(`/api/meetings/${meetingRef}/recordings/${recordingId}/chunks`, { method: "POST", body: form });
            if (res.ok) break;
            if (attempt >= 2 || (res.status < 500 && res.status !== 429)) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
            }
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          }
          setProgress({ done: ++done, total: parts.length });
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      toast.success("Recording uploaded — transcribing and separating the speakers now.");
      setOpen(false);
      setFile(null);
      setConsent(false);
      setSample(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message.includes("decode") ? "This file couldn't be decoded. Try MP3, M4A, WAV, OGG or WebM audio." : err instanceof Error ? err.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !progress && setOpen(o)}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} title={disabled ? "Transcription isn't configured on this server" : undefined}><Upload aria-hidden /> Upload recording</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transcribe a recording</DialogTitle>
          <DialogDescription>The audio is converted in your browser and sent in short pieces. The whole call is then transcribed with the speakers told apart (Speaker 1, Speaker 2…), summarised, and the summary is delivered to you. The audio is discarded after transcription.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="grid gap-2">
          <input type="file" accept="audio/*,video/webm,.m4a,.mp3,.wav,.ogg,.webm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSample(false); }} aria-label="Recording file" className="text-sm" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button type="button" size="sm" variant="secondary" onClick={loadSample}>Use the sample call</Button>
            <span className="text-xs text-muted-foreground">A 90-second business call between two people (synthetic voices).</span>
          </div>
          {sample && file && (
            <audio controls src={SAMPLE_URL} className="w-full" aria-label="Sample call audio" />
          )}
          <label className="flex items-center gap-2 text-sm">
            Spoken language
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className="h-8 rounded-md border bg-transparent px-2 text-sm" aria-label="Spoken language">
              <option value="en">English</option>
              <option value="hi">हिन्दी (Hindi)</option>
              <option value="es">Español</option>
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          Everyone in this recording agreed to it being transcribed.
        </label>
        {progress && (
          <div className="grid gap-1 text-sm" aria-live="polite">
            <p>{progress.total ? `Uploading ${progress.done} of ${progress.total} pieces…` : "Decoding audio…"}</p>
            <div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 5}%` }} /></div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={start} disabled={!file || !consent || !!progress}>{progress && <Loader2 className="animate-spin" aria-hidden />} Transcribe</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manual fallback: import a VTT / SRT / text transcript. */
export function TranscriptImport({ meetingRef, hasExisting, onDone }: { meetingRef: string; hasExisting: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("File is too large (max 1 MB).");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await api<{ segments: number; approximateTimes: boolean }>(`/api/meetings/${meetingRef}/transcript/import`, {
        method: "POST",
        json: { content: await file.text(), fileName: file.name, replace },
      });
      toast.success(`Imported ${res.segments} lines${res.approximateTimes ? " (no timestamps in file — times are approximate)" : ""}`);
      setOpen(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><FileText aria-hidden /> Import transcript</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a transcript</DialogTitle>
          <DialogDescription>WebVTT (.vtt), SubRip (.srt), or plain text with one “Name: what they said” line per utterance. Speaker names are linked to participants only when the name matches exactly one person.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <input type="file" accept=".vtt,.srt,.txt,text/plain,text/vtt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Transcript file" className="text-sm" />
        {hasExisting && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace the existing transcript (it will be deleted).
          </label>
        )}
        <DialogFooter>
          <Button onClick={submit} disabled={!file || pending || (hasExisting && !replace)}>{pending && <Loader2 className="animate-spin" aria-hidden />} Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
