"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Pause, Play, Square, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { decodeTo48k, denoise, DENOISERS, RATE, type Denoiser } from "@/lib/audio/denoise";
import { backgroundReductionDb, bestLag, siSdr } from "@/lib/audio/quality";

const SAMPLES = [
  { id: "office", label: "Office", detail: "fan + keyboard, ~4 dB SNR" },
  { id: "street", label: "Street", detail: "traffic rumble + horns, ~2 dB SNR" },
  { id: "cafe", label: "Café", detail: "background chatter + cups, ~4.5 dB SNR" },
] as const;

type Source = { label: string; noisy: Float32Array; clean: Float32Array | null };
type Result = { model: Denoiser; output: Float32Array; ms: number; lag: number; sdrBefore: number | null; sdrAfter: number | null; bgDb: number };
const fetchAudio = async (url: string) => decodeTo48k(await (await fetch(url)).arrayBuffer());
const db = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`);

// ─── Playback (one clip at a time) ──────────────────────────────────────
let audioCtx: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;
function play(samples: Float32Array, onEnd: () => void) {
  audioCtx ??= new AudioContext({ sampleRate: RATE });
  void audioCtx.resume();
  playing?.stop();
  const buf = audioCtx.createBuffer(1, samples.length, RATE);
  buf.copyToChannel(new Float32Array(samples), 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.onended = () => {
    if (playing === src) playing = null;
    onEnd();
  };
  src.start();
  playing = src;
}
function stopPlayback() {
  playing?.stop();
  playing = null;
}

// ─── Spectrogram ────────────────────────────────────────────────────────
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
  }
}
function Spectrogram({ samples, label }: { samples: Float32Array; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // 16 kHz view (speech lives below 8 kHz): 512-point FFT, 50% overlap.
    const x = Float32Array.from({ length: Math.floor(samples.length / 3) }, (_, i) => (samples[i * 3] + samples[i * 3 + 1] + samples[i * 3 + 2]) / 3);
    const N = 512, hop = 256, bins = 192;
    const frames = Math.max(1, Math.floor((x.length - N) / hop));
    c.width = frames;
    c.height = bins;
    const g = c.getContext("2d")!;
    const img = g.createImageData(frames, bins);
    const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    for (let f = 0; f < frames; f++) {
      const re = new Float32Array(N), im = new Float32Array(N);
      for (let i = 0; i < N; i++) re[i] = x[f * hop + i] * win[i];
      fft(re, im);
      for (let b = 0; b < bins; b++) {
        const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
        const v = Math.max(0, Math.min(1, (20 * Math.log10(mag + 1e-9) + 60) / 70));
        const o = ((bins - 1 - b) * frames + f) * 4;
        // dark blue → violet → orange → yellow
        img.data[o] = Math.round(255 * Math.min(1, v * 1.6));
        img.data[o + 1] = Math.round(255 * Math.max(0, v - 0.45) * 1.8);
        img.data[o + 2] = Math.round(255 * (0.35 + 0.5 * Math.sin(Math.PI * Math.min(1, v * 1.3))));
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, [samples]);
  return (
    <figure className="grid gap-1">
      <canvas ref={ref} className="h-28 w-full rounded-md bg-[#0b1026] [image-rendering:pixelated]" role="img" aria-label={`Spectrogram: ${label}`} />
      <figcaption className="text-xs text-muted-foreground">{label} — time → , frequency ↑ (0–8 kHz). Noise shows as haze between and behind the voice.</figcaption>
    </figure>
  );
}

function PlayButton({ id, samples, label, nowPlaying, onToggle }: { id: string; samples: Float32Array; label: string; nowPlaying: string | null; onToggle: (id: string, s: Float32Array) => void }) {
  return (
    <Button size="sm" variant={nowPlaying === id ? "default" : "outline"} onClick={() => onToggle(id, samples)} aria-label={`${nowPlaying === id ? "Stop" : "Play"} ${label}`}>
      {nowPlaying === id ? <Pause aria-hidden /> : <Play aria-hidden />} {label}
    </Button>
  );
}

// ─── The lab ────────────────────────────────────────────────────────────
export function NoiseLab() {
  const [source, setSource] = useState<Source | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [view, setView] = useState<Denoiser>("rnnoise");
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);

  const run = useCallback(async (src: Source) => {
    stopPlayback();
    setNowPlaying(null);
    setSource(src);
    setResults([]);
    const out: Result[] = [];
    const before = src.clean ? siSdr(src.clean, src.noisy) : null;
    for (const d of DENOISERS) {
      setBusy(`Processing with ${d.name}…`);
      try {
        const { output, ms } = await denoise(src.noisy, d.id);
        const lag = src.clean ? bestLag(src.clean, output) : bestLag(src.noisy, output);
        out.push({ model: d.id, output, ms, lag, sdrBefore: before, sdrAfter: src.clean ? siSdr(src.clean, output, lag) : null, bgDb: backgroundReductionDb(src.noisy, output, { ref: src.clean ?? undefined, lag }) });
        setResults([...out]);
      } catch (err) {
        toast.error(`${d.name} failed: ${(err as Error).message}`);
      }
    }
    setBusy(null);
  }, []);

  const loadSample = useCallback(
    async (id: string, label: string) => {
      setBusy("Loading sample…");
      setResults([]);
      setSource(null);
      try {
        const [noisy, clean] = await Promise.all([fetchAudio(`/samples/noise/${id}.wav`), fetchAudio("/samples/noise/clean.wav")]);
        await run({ label, noisy, clean });
      } catch (err) {
        toast.error(`Couldn't load the sample: ${(err as Error).message}`);
        setBusy(null);
      }
    },
    [run],
  );

  useEffect(() => {
    const t = setTimeout(() => void loadSample("office", "Office"), 0);
    return () => clearTimeout(t);
  }, [loadSample]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setBusy("Decoding…");
    setResults([]);
    setSource(null);
    try {
      await run({ label: f.name, noisy: await decodeTo48k(await f.arrayBuffer()), clean: null });
    } catch {
      toast.error("That file couldn't be decoded. Try WAV, MP3, M4A or OGG.");
      setBusy(null);
    }
  }

  async function record() {
    if (recording) return recorder.current?.stop();
    try {
      // Raw microphone: the browser's own noise suppression is turned off so the demo shows real noise.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: false, echoCancellation: false, autoGainControl: false } });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setBusy("Decoding…");
        await run({ label: "Your microphone", noisy: await decodeTo48k(await new Blob(chunks).arrayBuffer()), clean: null });
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      setTimeout(() => rec.state === "recording" && rec.stop(), 8000);
    } catch {
      toast.error("Microphone access was blocked.");
    }
  }

  const toggle = (key: string, samples: Float32Array) => {
    if (nowPlaying === key) {
      stopPlayback();
      setNowPlaying(null);
      return;
    }
    play(samples, () => setNowPlaying((k) => (k === key ? null : k)));
    setNowPlaying(key);
  };
  const selected = results.find((r) => r.model === view);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Choose noisy audio</CardTitle>
          <CardDescription>Speech mixed with real-world noise, your own recording, or 8 seconds from your microphone (with the browser&apos;s own noise suppression switched off).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <Button key={s.id} variant={source?.label === s.label ? "default" : "outline"} onClick={() => loadSample(s.id, s.label)} disabled={!!busy} title={s.detail}>
              {s.label} <span className="text-xs opacity-70">{s.detail}</span>
            </Button>
          ))}
          <label className={cn("inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted", busy && "pointer-events-none opacity-50")}>
            <Upload className="size-4" aria-hidden /> Upload audio
            <input type="file" accept="audio/*" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Upload noisy audio" />
          </label>
          <Button variant={recording ? "destructive" : "outline"} onClick={record} disabled={!!busy && !recording}>
            {recording ? <><Square aria-hidden /> Stop recording</> : <><Mic aria-hidden /> Record 8 s</>}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Before and after</CardTitle>
          <CardDescription>
            Each model processes the clip in your browser. <strong>Speech quality</strong> is the improvement in SI-SDR against the clean original (the standard speech-enhancement measure; higher is better).
            <strong> Background</strong> is how much quieter the stretches without speech became.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {busy && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden /> {busy}</p>}
          {source && (
            <div className="flex flex-wrap gap-2">
              <PlayButton nowPlaying={nowPlaying} onToggle={toggle} id="noisy" samples={source.noisy} label={`Original: ${source.label}`} />
              {source.clean && <PlayButton nowPlaying={nowPlaying} onToggle={toggle} id="clean" samples={source.clean} label="Clean reference" />}
            </div>
          )}
          {results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Noise cancellation results">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="py-1.5 pr-3 font-medium">Model</th><th className="pr-3 font-medium">Speech quality</th><th className="pr-3 font-medium">Background</th><th className="pr-3 font-medium">Speed</th><th className="font-medium">Listen</th></tr>
                </thead>
                <tbody>
                  {DENOISERS.map((d) => {
                    const r = results.find((x) => x.model === d.id);
                    return (
                      <tr key={d.id} className={cn("border-t align-top", view === d.id && "bg-muted/40")}>
                        <td className="py-2 pr-3">
                          <button type="button" className="text-left" onClick={() => setView(d.id)}>
                            <span className="font-medium">{d.name}</span> {d.id === "rnnoise" && <Badge variant="secondary">in calls</Badge>}
                            <span className="block text-xs text-muted-foreground">{d.kind}</span>
                          </button>
                        </td>
                        <td className="pr-3 tabular-nums">{r ? (r.sdrAfter !== null && r.sdrBefore !== null ? <><strong>{db(r.sdrAfter - r.sdrBefore)}</strong><span className="block text-xs text-muted-foreground">{r.sdrBefore.toFixed(1)} → {r.sdrAfter.toFixed(1)} dB</span></> : "n/a (no clean reference)") : <Loader2 className="size-4 animate-spin" aria-label="Processing" />}</td>
                        <td className="pr-3 tabular-nums">{r ? <strong>−{Math.max(0, r.bgDb).toFixed(1)} dB</strong> : ""}</td>
                        <td className="pr-3 tabular-nums">{r ? `${((source!.noisy.length / RATE) * 1000 / r.ms).toFixed(0)}× real time` : ""}</td>
                        <td>{r && <PlayButton nowPlaying={nowPlaying} onToggle={toggle} id={d.id} samples={r.output} label={d.name} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">{DENOISERS.find((d) => d.id === view)?.note}</p>
            </div>
          )}
          {source && (
            <div className="grid gap-3 md:grid-cols-2">
              <Spectrogram samples={source.noisy} label={`Before: ${source.label}`} />
              {selected ? <Spectrogram samples={selected.output} label={`After: ${DENOISERS.find((d) => d.id === view)?.name}`} /> : <div className="grid h-28 place-items-center rounded-md border text-sm text-muted-foreground">Processing…</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
