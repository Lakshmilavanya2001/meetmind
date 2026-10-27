"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { useInterpreter, VoiceOption } from "./use-interpreter";

type Interp = ReturnType<typeof useInterpreter>;

const TONE_LABEL: Record<string, string> = { PleasantSurprised: "Pleasantly surprised" };
export const toneLabel = (tone: string | null) => (tone ? (TONE_LABEL[tone] ?? tone) : "Standard");
/** "Sofia.Calm" → "Sofia · Calm"; a voice without a tone is just its name. */
export const voiceLabel = (id: string | null | undefined) => {
  if (!id) return "";
  const [speaker, tone] = id.split(".");
  return tone ? `${speaker} · ${toneLabel(tone)}` : speaker;
};

/**
 * Pick your voice: how everyone hears your translated speech. Each person picks their own, so you hear every
 * speaker in the voice they chose.
 */
export function VoicePicker({ interp, open, onOpenChange }: { interp: Interp; open: boolean; onOpenChange: (v: boolean) => void }) {
  const state = interp.state;
  const voices = useMemo(() => state?.voices ?? [], [state?.voices]);
  const current = state?.myVoiceId ?? state?.defaultVoice ?? null;
  const [picked, setPicked] = useState<string | null>(current);
  const [busy, setBusy] = useState<"save" | "preview" | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  // Speakers in the server's order; each with its tones ("Standard" = the voice without a tone).
  const speakers = useMemo(() => {
    const m = new Map<string, VoiceOption[]>();
    for (const v of voices) m.set(v.speaker, [...(m.get(v.speaker) ?? []), v]);
    return [...m.entries()].map(([speaker, list]) => ({ speaker, options: list.sort((a, b) => (a.tone === null ? -1 : b.tone === null ? 1 : 0)) }));
  }, [voices]);
  const pickedSpeaker = picked?.split(".")[0] ?? null;
  const tones = speakers.find((s) => s.speaker === pickedSpeaker)?.options ?? [];

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(false);
  };
  useEffect(() => stop, []);

  function change(next: boolean) {
    if (next) setPicked(current);
    else stop();
    onOpenChange(next);
  }

  async function preview() {
    if (playing) return stop();
    setBusy("preview");
    try {
      const blob = await interp.previewVoice(picked === state?.defaultVoice ? null : picked);
      stop();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => {
        URL.revokeObjectURL(url);
        setPlaying(false);
      };
      setPlaying(true);
      await a.play();
    } catch (err) {
      setPlaying(false);
      toast.error(err instanceof Error ? err.message : "Couldn't play the sample");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    try {
      await interp.setVoice(picked === state?.defaultVoice ? null : picked);
      toast.success(`Others will hear you as ${voiceLabel(picked)}.`);
      change(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change the voice");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Your voice</DialogTitle>
          <DialogDescription>
            How everyone hears your translated speech. Others choose their own, and you hear each person in theirs. Tones exist mainly in English: listeners
            whose language lacks the tone hear the same voice without it, or their language&apos;s default voice.
          </DialogDescription>
        </DialogHeader>
        {speakers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No voices to choose from right now.</p>
        ) : (
          <div className="grid gap-4">
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Voice</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Voice">
                {speakers.map((s) => {
                  const on = pickedSpeaker === s.speaker;
                  return (
                    <button
                      key={s.speaker}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setPicked(s.options[0].id)}
                      className={cn("flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent", on && "border-primary bg-primary/10")}
                    >
                      <span>
                        {s.speaker}
                        {s.speaker === state?.defaultVoice && <span className="block text-xs text-muted-foreground">default</span>}
                        {s.options.length > 1 && <span className="block text-xs text-muted-foreground">{s.options.length - (s.options[0].tone === null ? 1 : 0)} tones</span>}
                      </span>
                      {on && <Check className="size-4 text-primary" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {tones.length > 1 && (
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Tone</legend>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tone">
                  {tones.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={picked === t.id}
                      onClick={() => setPicked(t.id)}
                      className={cn("rounded-full border px-3 py-1 text-sm transition-colors hover:bg-accent", picked === t.id && "border-primary bg-primary/10")}
                    >
                      {toneLabel(t.tone)}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={preview} disabled={!picked || busy === "save" || busy === "preview"}>
            {busy === "preview" ? <Loader2 className="animate-spin" aria-hidden /> : playing ? <Square aria-hidden /> : <Play aria-hidden />}
            {playing ? "Stop" : "Preview"}
          </Button>
          <Button onClick={save} disabled={!picked || picked === current || !!busy}>
            {busy === "save" && <Loader2 className="animate-spin" aria-hidden />} Use this voice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
