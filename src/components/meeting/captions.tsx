"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Languages, Subtitles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { LANGUAGES } from "@/lib/validation";
import { cn } from "@/lib/utils";

/** "off", "original" (as spoken), or a language code to translate into. */
export type CaptionChoice = string;

type Caption = { id: string; speakerLabel: string; isMe: boolean; text: string; original: string; spokenLanguage: string | null; translated: boolean; ageMs: number };
type CaptionsResponse = { language: string; translationAvailable: boolean; transcriptionEnabled: boolean; captions: Caption[] };
type Shown = Omit<CaptionsResponse, "captions"> & { captions: (Caption & { saidAt: number })[] };

const KEY = "mm.captions";
const SHOW_MS = 12_000; // how long a line stays on screen
const POLL_MS = 1500;
const nameOf = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

export function loadCaptionChoice(): CaptionChoice {
  try {
    return localStorage.getItem(KEY) ?? "off";
  } catch {
    return "off";
  }
}

export function CaptionsControl({ choice, onChange, myLanguage }: { choice: CaptionChoice; onChange: (c: CaptionChoice) => void; myLanguage: string }) {
  const set = (c: CaptionChoice) => {
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* preference only */
    }
    onChange(c);
  };
  const label = choice === "off" ? "Off" : choice === "original" ? "As spoken" : nameOf(choice);
  // Your own language first, then the rest.
  const ordered = [...LANGUAGES].sort((a, b) => Number(b.code === myLanguage) - Number(a.code === myLanguage));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={`Live captions: ${label}`}
          title="Live captions & translation"
          className={cn("rounded-full text-white hover:bg-white/10 hover:text-white", choice !== "off" && "bg-sky-600/70 hover:bg-sky-600")}
        >
          <Subtitles />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top" className="max-h-96 w-64 overflow-y-auto">
        <DropdownMenuLabel>Live captions</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => set("off")}>
          <span className="flex-1">Off</span>
          {choice === "off" && <Check aria-label="Selected" />}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => set("original")}>
          <span className="flex-1">
            <span className="block">As spoken</span>
            <span className="block text-xs text-muted-foreground">No translation</span>
          </span>
          {choice === "original" && <Check aria-label="Selected" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
          <Languages className="size-3.5" aria-hidden /> Translate into
        </DropdownMenuLabel>
        {ordered.map((l) => (
          <DropdownMenuItem key={l.code} onSelect={() => set(l.code)}>
            <span className="flex-1">{l.name}</span>
            {l.code === myLanguage && <span className="text-xs text-muted-foreground">your language</span>}
            {choice === l.code && <Check aria-label="Selected" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Subtitles over the call: the last few lines, translated for this viewer. */
export function CaptionsOverlay({ meetingRef, choice, transcriptionEnabled }: { meetingRef: string; choice: CaptionChoice; transcriptionEnabled: boolean }) {
  const [data, setData] = useState<Shown | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef(new Map<string, number>()); // id → when it was said (client clock)
  const on = choice !== "off";

  useEffect(() => {
    if (!on || !transcriptionEnabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // Sequential polling: a slow translation never stacks up requests.
    const tick = async () => {
      try {
        const r = await api<CaptionsResponse>(`/api/meetings/${meetingRef}/captions?lang=${encodeURIComponent(choice)}`);
        if (stopped) return;
        const t = Date.now();
        for (const c of r.captions) if (!seen.current.has(c.id)) seen.current.set(c.id, t - c.ageMs);
        setData({ ...r, captions: r.captions.map((c) => ({ ...c, saidAt: seen.current.get(c.id)! })) });
        setNow(t);
      } catch {
        /* keep the last captions */
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [meetingRef, choice, on, transcriptionEnabled]);

  // Let lines expire even when no new ones arrive.
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);

  const lines = useMemo(
    () => (data?.language === choice ? data.captions.filter((c) => now - c.saidAt < SHOW_MS).slice(-3) : []),
    [data, choice, now],
  );

  if (!on) return null;
  return (
    <div role="region" aria-label="Live captions" className="pointer-events-none fixed inset-x-0 bottom-52 z-30 flex justify-center px-4">
      <div aria-live="polite" className="grid max-w-3xl gap-1 text-center">
        {!transcriptionEnabled ? (
          <p className="rounded-lg bg-black/75 px-3 py-1.5 text-sm text-white/80">Captions appear when the host turns on transcription.</p>
        ) : (
          <>
            {data && !data.translationAvailable && <p className="rounded-lg bg-black/75 px-3 py-1 text-xs text-amber-200">Translation isn&apos;t available right now; showing captions as spoken.</p>}
            {lines.map((c) => (
              <p key={c.id} lang={c.translated ? choice : (c.spokenLanguage ?? undefined)} title={c.translated ? `Original: ${c.original}` : undefined} className="rounded-lg bg-black/75 px-3 py-1.5 text-base leading-snug text-white shadow">
                <span className="font-semibold text-sky-200">{c.isMe ? "You" : c.speakerLabel}: </span>
                {c.text}
                {c.translated && <span className="ml-1.5 align-middle text-[10px] uppercase tracking-wide text-white/50">translated</span>}
              </p>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
