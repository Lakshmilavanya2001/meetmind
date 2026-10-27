"use client";

import { useState } from "react";
import { AudioLines, Check, ChevronRight, Languages, Loader2, Timer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { useInterpreter } from "./use-interpreter";
import { VoicePicker, voiceLabel } from "./voice-picker";

type Interp = ReturnType<typeof useInterpreter>;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Footer control: turn the AI interpreter on (hosts), choose your language and how loud original voices stay. */
export function InterpreterControl({ interp }: { interp: Interp }) {
  const { state, enabled, myLanguage } = interp;
  const [picking, setPicking] = useState(false);
  if (!state?.available) return null;
  const name = state.languages.find((l) => l.code === myLanguage)?.name ?? myLanguage;
  const run = (p: Promise<unknown>) => p.catch((err) => toast.error(err instanceof Error ? err.message : "Couldn't change the interpreter"));
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={`AI interpreter: ${enabled ? `On, you hear ${name}` : "Off"}`}
          title="AI interpreter"
          className={cn("rounded-full text-white hover:text-white", enabled && "bg-[var(--call-ring)]! text-[var(--call-bg)]! hover:text-[var(--call-bg)]")}
        >
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top" className="max-h-[70vh] w-72 overflow-y-auto">
        <DropdownMenuLabel>AI interpreter</DropdownMenuLabel>
        <p className="px-2 pb-1.5 text-xs text-muted-foreground">
          Pick the language you speak. You&apos;ll hear everyone else in it, whatever they speak. Picking one sends your voice to the AI interpreter.
        </p>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">I speak and want to hear</DropdownMenuLabel>
        {state.languages.map((l) => (
          <DropdownMenuItem
            key={l.code}
            onSelect={() => run(interp.setLanguage(l.code).then(() => toast.success(`You'll hear everyone in ${l.name}.`)))}
          >
            <span className="flex-1">{l.name}</span>
            {state.chosen !== false && myLanguage === l.code && <Check aria-label="Selected" />}
          </DropdownMenuItem>
        ))}
        {enabled && state.myVoice && (
          <DropdownMenuItem onSelect={() => run(interp.stopMyVoice().then(() => toast.success("Your voice is no longer sent to the interpreter.")))}>
            <span className="flex-1 text-xs">Stop interpreting my voice</span>
          </DropdownMenuItem>
        )}
        {state.canManage && enabled && (
          <DropdownMenuItem onSelect={() => run(interp.setEnabled(false))}>
            <span className="flex-1 text-xs">Turn off for everyone (host)</span>
          </DropdownMenuItem>
        )}
        {!!state.voices?.length && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPicking(true)}>
              <AudioLines aria-hidden />
              <span className="flex-1">
                Your voice (how others hear you)
                <span className="block text-xs text-muted-foreground">{voiceLabel(state.myVoiceId ?? state.defaultVoice)}{!state.myVoiceId && " (default)"}</span>
              </span>
              <ChevronRight aria-hidden />
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Others&apos; original voices (when translated for you)</DropdownMenuLabel>
        {[{ v: 0, label: "Muted: hear only the translation" }, { v: 0.15, label: "Quiet underneath the translation" }, { v: 1, label: "Full volume" }].map((o) => (
          <DropdownMenuItem key={o.v} onSelect={() => interp.setOriginalVolume(o.v)}>
            <span className="flex-1">{o.label}</span>
            {interp.originalVolume === o.v && <Check aria-label="Selected" />}
          </DropdownMenuItem>
        ))}
        {state.engines?.indic && (
          <p className="border-t px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
            Indian languages: IndicConformer (AI4Bharat). Built with indic-translate and indic-speak from Bodhan AI / AI4Bharat.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    <VoicePicker interp={interp} open={picking} onOpenChange={setPicking} />
    </>
  );
}

/** Live view: what was said, its translation for me, and how long it took to reach my ears. */
export function InterpreterPanel({ interp, myUserId }: { interp: Interp; myUserId: string }) {
  const { enabled, lines, myLanguage, stats, agentPresent, state } = interp;
  if (!enabled) return null;
  const myName = state?.languages.find((l) => l.code === myLanguage)?.name ?? myLanguage;
  const recent = lines.slice(-3);
  return (
    <section aria-label="Live interpretation" className="mx-auto grid w-full max-w-3xl gap-2 px-4 pb-2 text-white">
      <header className="flex items-center justify-center gap-3 text-xs text-white/60">
        <span className="flex items-center gap-1.5 font-medium text-[var(--call-ring)]"><Languages className="size-3.5" aria-hidden /> AI interpreter · you hear {myName}</span>
        {stats.avgMs !== null && (
          <span className="flex items-center gap-1" title={`Average from end of speech to translated audio, over ${stats.count} line(s)`}>
            <Timer className="size-3.5" aria-hidden /> avg {secs(stats.avgMs)}
          </span>
        )}
      </header>
      {!agentPresent ? (
        <p className="flex items-center justify-center gap-2 text-center text-white/70"><Loader2 className="size-3.5 animate-spin" aria-hidden /> The interpreter is joining the call…</p>
      ) : recent.length === 0 ? (
        <p className="text-center text-white/55">Listening. Speak in your language; others hear you in theirs.</p>
      ) : (
        <ol className="grid gap-1.5" aria-live="polite">
          {recent.map((l, i) => {
            const latest = i === recent.length - 1;
            const mine = l.speakerId === myUserId;
            const translated = l.language !== myLanguage ? l.translations[myLanguage] : undefined;
            const lat = l.language !== myLanguage ? l.latency[myLanguage] : undefined;
            // For my own lines, show what the others heard.
            const others = mine ? Object.entries(l.translations) : [];
            return (
              <li key={l.id} className={cn("grid justify-items-center gap-0.5 text-center transition-opacity", !latest && "opacity-45")}>
                <span className="text-[11px] text-white/55">
                  {mine ? "You" : l.speaker} · {l.language}
                  {lat && (
                    <span title={`Speech recognition ${secs(lat.asrMs)} · translation ${secs(lat.mtMs)} · voice ${secs(lat.ttsMs)} · waiting ${secs(lat.queueMs)}`}>
                      {" · "}
                      {lat.spoken ? `heard after ${secs(lat.totalMs)}` : "text only"}
                    </span>
                  )}
                </span>
                {translated ? (
                  <>
                    <p lang={myLanguage} className={cn("leading-snug text-balance", latest ? "text-xl font-medium sm:text-2xl" : "text-base")}>{translated}</p>
                    <p lang={l.language} className="text-xs text-white/50">{l.text}</p>
                  </>
                ) : (
                  <p lang={l.language} className={cn("leading-snug text-balance", latest ? "text-lg sm:text-xl" : "text-base", l.language !== myLanguage && "text-white/70")}>
                    {l.text}
                    {l.language !== myLanguage && <span className="ml-1 text-xs text-white/40">translating…</span>}
                  </p>
                )}
                {others.map(([lang, text]) => (
                  <p key={lang} lang={lang} className="text-xs text-[var(--call-ring)]/80">→ {lang}: {text}</p>
                ))}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
