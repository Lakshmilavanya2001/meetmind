"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Languages, Subtitles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { LANGUAGES } from "@/lib/validation";
import { cn } from "@/lib/utils";
import { useCallFeed, type FeedLine } from "./use-call-feed";

/** "off", "original" (as spoken), or a language code to translate into. */
export type CaptionChoice = string;

type Caption = { id: string; speakerLabel: string; isMe: boolean; text: string; original: string; spokenLanguage: string | null; translated: boolean; ageMs: number };
type CaptionsResponse = { language: string; translationAvailable: boolean; transcriptionEnabled: boolean; captions: Caption[] };
type Entry = Caption & { saidAt: number };

const KEY = "mm.captions";
const SHOW_MS = 12_000; // how long a line stays on screen
// Lines and the interpreter's translations are pushed live; this is only a safety net (it used to be the
// only source, every 1.5 s).
const FALLBACK_POLL_MS = 6000;
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
export function CaptionsOverlay({ meetingRef, choice, transcriptionEnabled, myUserId }: { meetingRef: string; choice: CaptionChoice; transcriptionEnabled: boolean; myUserId?: string }) {
  // Captions per language ("hi:<line id>"), so switching language never shows lines in the old one.
  const [entries, setEntries] = useState<Map<string, Entry>>(() => new Map());
  const [translationAvailable, setTranslationAvailable] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const on = choice !== "off";
  const lines = useRef(new Map<string, FeedLine>()); // pushed lines, for their speaker and original text
  const translatedPush = useRef(new Set<string>()); // "lang:id" the interpreter has sent a translation for
  const fetcher = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false });
  const choiceRef = useRef(choice);
  useEffect(() => {
    choiceRef.current = choice;
  }, [choice]);

  const upsert = useCallback((lang: string, e: Omit<Entry, "saidAt"> & { saidAt?: number }) => {
    setEntries((prev) => {
      const key = `${lang}:${e.id}`;
      const old = prev.get(key);
      const next = new Map(prev);
      next.set(key, { ...old, ...e, saidAt: old?.saidAt ?? e.saidAt ?? Date.now() } as Entry);
      // Keep the map small: drop what's long off screen.
      if (next.size > 200) for (const [k, v] of next) if (Date.now() - v.saidAt > 5 * SHOW_MS) next.delete(k);
      return next;
    });
    setNow(Date.now());
  }, []);

  // The server's captions (translated and cached there), fetched when a pushed line needs a translation the
  // interpreter isn't making, and every few seconds as a safety net. One request at a time.
  const fetchNow = useCallback(async () => {
    const f = fetcher.current;
    if (f.busy) {
      f.again = true; // asked again while a request is out: one more round when it's back
      return;
    }
    f.busy = true;
    try {
      do {
        f.again = false;
        try {
          const lang = choiceRef.current;
          const r = await api<CaptionsResponse>(`/api/meetings/${meetingRef}/captions?lang=${encodeURIComponent(lang)}`);
          setTranslationAvailable(r.translationAvailable);
          const t = Date.now();
          for (const c of r.captions) upsert(r.language, { ...c, saidAt: t - c.ageMs });
        } catch {
          /* keep the last captions */
        }
      } while (f.again);
    } finally {
      f.busy = false;
    }
  }, [meetingRef, upsert]);

  useCallFeed({
    onLine: (l) => {
      lines.current.set(l.id, l);
      const lang = choiceRef.current;
      if (lang === "off") return;
      const base = { id: l.id, speakerLabel: l.speaker, isMe: l.speakerId === myUserId, original: l.text, spokenLanguage: l.language };
      if (lang === "original" || l.language === lang) {
        upsert(lang, { ...base, text: l.text, translated: false, ageMs: 0 });
        return;
      }
      // Another language: the interpreter may already be translating into it (it pushes that); if nothing
      // arrives quickly, ask the server for this line now rather than at the next poll.
      setTimeout(() => {
        if (!translatedPush.current.has(`${lang}:${l.id}`)) void fetchNow();
      }, 400);
    },
    onTranslation: (id, language, text) => {
      translatedPush.current.add(`${language}:${id}`);
      if (language !== choiceRef.current) return;
      const l = lines.current.get(id);
      if (!l) return;
      upsert(language, { id, speakerLabel: l.speaker, isMe: l.speakerId === myUserId, original: l.text, spokenLanguage: l.language, text, translated: true, ageMs: 0 });
    },
  });

  useEffect(() => {
    if (!on || !transcriptionEnabled) return;
    const first = setTimeout(() => void fetchNow(), 0);
    const t = setInterval(() => void fetchNow(), FALLBACK_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [on, transcriptionEnabled, choice, fetchNow]);

  // Let lines expire even when no new ones arrive.
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);

  const shown = useMemo(
    () =>
      [...entries.entries()]
        .filter(([k, c]) => k.startsWith(`${choice}:`) && now - c.saidAt < SHOW_MS)
        .map(([, c]) => c)
        .sort((x, y) => x.saidAt - y.saidAt)
        .slice(-3),
    [entries, choice, now],
  );

  if (!on) return null;
  return (
    <div role="region" aria-label="Live captions" className="pointer-events-none fixed inset-x-0 bottom-52 z-30 flex justify-center px-4">
      <div aria-live="polite" className="grid max-w-3xl gap-1 text-center">
        {!transcriptionEnabled ? (
          <p className="rounded-lg bg-black/75 px-3 py-1.5 text-sm text-white/80">Captions appear when the host turns on transcription.</p>
        ) : (
          <>
            {!translationAvailable && <p className="rounded-lg bg-black/75 px-3 py-1 text-xs text-amber-200">Translation isn&apos;t available right now; showing captions as spoken.</p>}
            {shown.map((c) => (
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
