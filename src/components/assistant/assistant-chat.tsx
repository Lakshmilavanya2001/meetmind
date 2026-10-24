"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Mic, MicOff, Volume2, VolumeX, Bot, ListChecks, Car, CheckCircle2, CircleSlash, Clock, Loader2, MessagesSquare, ShieldQuestion, Sparkles, UtensilsCrossed, BellRing, CalendarClock, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { useAssistant, type Item, type PlanView } from "./use-assistant";
import { useVoiceIO } from "./use-voice-io";
import { classifyYesNo } from "@/lib/voice-commands";
import { api } from "@/lib/api";
import { CitationList } from "@/components/transcripts/citations";

const SUGGESTIONS = [
  "Order two medium Margherita pizzas and garlic bread from Slice Republic",
  "Book 2 tickets for The Last Signal tomorrow evening",
  "Show my upcoming meetings",
  "Schedule a 30-minute sync with Priya tomorrow at 3 PM",
  "Find a time this week when Amit and I are both free",
  "Start a meeting now",
];
const IN_MEETING_SUGGESTIONS = ["Who is in this meeting?", "Invite Amit to this call", "Send the meeting link to the Platform team"];

export function AssistantChat({
  conversationId,
  meetingRef,
  onConversation,
  dark = false,
  className,
}: {
  conversationId?: string | null;
  meetingRef?: string;
  onConversation?: (id: string) => void;
  dark?: boolean;
  className?: string;
}) {
  const { items, busy, loading, send, decide, decidePlan, load } = useAssistant({ meetingRef, onConversation });
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const [language, setLanguage] = useState("en");
  useEffect(() => {
    api<{ profile: { preferredLanguage: string } }>("/api/profile").then((r) => setLanguage(r.profile.preferredLanguage)).catch(() => {});
  }, []);
  const voice = useVoiceIO(language, busy);
  // Questions asked by voice are always answered aloud; typed ones only when "Speak replies" is on.
  const speakTurn = useRef(false);

  // Something said with the mic on. A yes/no while an action or plan waits for approval answers it, as if
  // the button had been pressed; anything else is a new question.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const onSpoken = (said: string) => {
    const list = itemsRef.current;
    const lastUser = list.findLastIndex((i) => i.kind === "user");
    const pendingAction = list.findLast((i, n) => n > lastUser && i.kind === "tool" && i.confirmation?.state === "pending");
    const pendingPlan = list.findLast((i, n) => n > lastUser && i.kind === "plan" && i.plan.status === "proposed");
    const verdict = pendingAction || pendingPlan ? classifyYesNo(said) : null;
    if (verdict) {
      const decided =
        pendingAction?.kind === "tool" && pendingAction.confirmation
          ? decide(pendingAction.confirmation.actionId, verdict === "yes" ? "confirm" : "reject")
          : pendingPlan?.kind === "plan"
            ? decidePlan(pendingPlan.plan.id, verdict === "yes" ? "approve" : "reject")
            : Promise.resolve(null);
      void decided.then((text) => voice.speak(text ?? (verdict === "yes" ? "Done." : "Cancelled.")));
      return;
    }
    speakTurn.current = true;
    send(said, { channel: "voice", language });
  };

  // Read the answer aloud while it's being written: each sentence plays as soon as it's complete.
  // `speakTurn` is set when a question is sent that should be answered aloud, and cleared once it has been.
  const { feed, finish } = voice;
  useEffect(() => {
    if (!speakTurn.current) return;
    const lastUser = items.findLastIndex((i) => i.kind === "user");
    const reply = items
      .slice(lastUser + 1)
      .flatMap((i) => (i.kind === "assistant" && !i.error && !i.guard ? [i.content] : []))
      .join("\n");
    if (busy) return feed(reply);
    speakTurn.current = false;
    void finish(reply);
  }, [busy, items, feed, finish]);

  useEffect(() => {
    load(conversationId ?? null);
  }, [conversationId, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!text.trim()) return;
    speakTurn.current = voice.speakReplies;
    send(text);
    setText("");
  }

  const muted = dark ? "text-white/60" : "text-muted-foreground";

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite" aria-busy={busy}>
        {loading ? (
          <div className={cn("flex items-center gap-2 text-sm", muted)}><Loader2 className="size-4 animate-spin" aria-hidden /> Loading conversation…</div>
        ) : items.length === 0 ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" aria-hidden />
              <p className="font-medium">How can I help?</p>
            </div>
            <p className={cn("text-sm", muted)}>A team of agents works for you: meetings &amp; calls, meeting knowledge, food &amp; dining, travel and reminders. I&apos;ll always ask before doing anything that changes something.</p>
            <div className="flex flex-wrap gap-2">
              {(meetingRef ? IN_MEETING_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <Button key={s} type="button" variant="outline" size="sm" className={cn("h-auto py-1.5 text-left whitespace-normal", dark && "border-white/20 bg-transparent text-white hover:bg-white/10")} onClick={() => send(s)} disabled={busy}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="grid gap-3">
            {items.map((item) => (
              <li key={item.id}>
                {item.kind === "plan" ? (
                  <PlanCard plan={item.plan} dark={dark} busy={busy} onDecide={decidePlan} />
                ) : (
                  <Message item={item} dark={dark} busy={busy} onPick={(t) => send(t)} onDecide={decide} />
                )}
              </li>
            ))}
            {busy && !(items[items.length - 1]?.kind === "assistant" && (items[items.length - 1] as Extract<Item, { kind: "assistant" }>).streaming) && (
              <li className={cn("flex items-center gap-2 text-sm", muted)}><Loader2 className="size-4 animate-spin" aria-hidden /> Thinking…</li>
            )}
          </ol>
        )}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className={cn("border-t p-3", dark && "border-white/10")}>
        <div className="relative">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder={meetingRef ? "Ask about or manage this meeting…" : "Ask the assistant…"}
            aria-label="Message the assistant"
            className={cn("resize-none pr-20", dark && "border-white/20 bg-white/5 text-white placeholder:text-white/40")}
          />
          <Button
            type="button"
            size="icon-sm"
            variant={voice.listening ? "destructive" : "ghost"}
            className="absolute right-11 bottom-2"
            disabled={!voice.listening && busy}
            onClick={() => {
              if (voice.listening) voice.stopSpeaking();
              void voice.listen(onSpoken);
            }}
            aria-label={voice.listening ? "Turn the microphone off" : "Talk to the assistant"}
            aria-pressed={voice.listening}
            title={voice.listening ? "Mic on: talk any time. Click to turn it off" : "Talk instead of typing (stays on until you turn it off)"}
          >
            {voice.transcribing ? <Loader2 className="animate-spin" /> : voice.listening ? <MicOff /> : <Mic />}
          </Button>
          <Button type="submit" size="icon-sm" className="absolute right-2 bottom-2" disabled={busy || !text.trim()} aria-label="Send">
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
        <div className={cn("mt-1.5 flex items-center justify-between gap-2 text-[11px]", muted)}>
          <p role="status">
            {!voice.listening
              ? "The assistant can make mistakes. Actions are only taken through the steps shown here."
              : voice.speaking
                ? "Speaking… the mic listens again when it's done."
                : busy || voice.transcribing
                  ? "Working on it…"
                  : "Mic on: just talk, and pause when you're done. Click the mic to turn it off."}
          </p>
          <button type="button" onClick={voice.toggleSpeak} aria-pressed={voice.speakReplies} className="flex shrink-0 items-center gap-1 rounded px-1 hover:text-foreground">
            {voice.speakReplies ? <Volume2 className="size-3.5" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />} Speak replies
          </button>
        </div>
      </form>
    </div>
  );
}

const PLAN_STATUS: Record<PlanView["status"], string> = {
  proposed: "Waiting for your approval",
  running: "Carrying out…",
  completed: "Done",
  partial: "Partly done",
  failed: "Didn't work",
  rejected: "You cancelled this plan",
  expired: "Expired — ask again",
};

/** A multi-step plan from the Planner: every exact action, approved once. */
function PlanCard({ plan, dark, busy, onDecide }: { plan: PlanView; dark: boolean; busy: boolean; onDecide: (id: string, d: "approve" | "reject") => void }) {
  const [deciding, setDeciding] = useState(false);
  const muted = dark ? "text-white/60" : "text-muted-foreground";
  const decide = (d: "approve" | "reject") => {
    setDeciding(true);
    onDecide(plan.id, d);
  };
  return (
    <section aria-label={`Plan: ${plan.goal}`} className={cn("rounded-xl border p-3 text-sm", dark ? "border-white/15 bg-white/5" : "bg-muted/30")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <ListChecks className="size-4 shrink-0 text-primary" aria-hidden />
          <span>{plan.revision > 0 ? "Revised plan" : "Plan"}: {plan.goal}</span>
        </div>
        <span className={cn("shrink-0 text-xs", muted)}>{PLAN_STATUS[plan.status]}</span>
      </div>
      <ol className="mt-3 grid gap-2">
        {plan.steps.map((s) => {
          const Icon = AGENT_ICON[s.agent] ?? Bot;
          return (
            <li key={s.index} className="flex gap-2">
              <span className="mt-0.5 shrink-0">
                {s.status === "done" ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Done" />
                  : s.status === "failed" ? <XCircle className="size-4 text-destructive" aria-label="Failed" />
                  : s.status === "skipped" ? <CircleSlash className={cn("size-4", muted)} aria-label="Skipped" />
                  : <Icon className={cn("size-4", muted)} aria-hidden />}
              </span>
              <div className="min-w-0">
                <p><span className={muted}>{s.index}.</span> {s.status === "done" && s.resultSummary ? s.resultSummary : s.summary}</p>
                <p className={cn("text-xs", s.error ? "text-destructive" : muted)}>{s.error ?? s.why}{s.dependsOn.length > 0 && !s.error ? ` · after step ${s.dependsOn.join(", ")}` : ""}</p>
                {s.link && s.status === "done" && <Link href={s.link} className="text-xs text-primary underline underline-offset-2">open</Link>}
              </div>
            </li>
          );
        })}
      </ol>
      {plan.status === "proposed" && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => decide("approve")} disabled={busy || deciding}>
            {deciding && busy ? <Loader2 className="animate-spin" aria-hidden /> : null} Approve plan
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide("reject")} disabled={busy || deciding} className={cn(dark && "border-white/20 bg-transparent text-white hover:bg-white/10")}>Cancel</Button>
        </div>
      )}
    </section>
  );
}

const AGENT_ICON: Record<string, typeof Bot> = { meetings: CalendarClock, knowledge: MessagesSquare, dining: UtensilsCrossed, travel: Car, reminders: BellRing, planner: ListChecks, general: Bot };

function Message({ item, dark, busy, onPick, onDecide }: { item: Item; dark: boolean; busy: boolean; onPick: (text: string) => void; onDecide: (id: string, d: "confirm" | "reject") => void }) {
  if (item.kind === "plan") return null; // rendered by PlanCard
  if (item.kind === "handoff") {
    const Icon = AGENT_ICON[item.agent] ?? Bot;
    return (
      <div className={cn("flex items-center gap-2 text-xs", dark ? "text-white/60" : "text-muted-foreground")} title={item.total > 1 ? `Task: ${item.task}` : undefined}>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium", dark ? "border-white/20 text-white/80" : "bg-muted/60 text-foreground")}>
          <Icon className="size-3.5" aria-hidden /> {item.name} agent
        </span>
        {item.total > 1 && <span className="min-w-0 truncate">{item.task}</span>}
      </div>
    );
  }
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{item.content}</div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    if (item.guard || item.error) {
      return (
        <div role="alert" className={cn("flex gap-2 rounded-lg border px-3 py-2 text-sm", item.guard ? "border-amber-500/50 bg-amber-500/10" : "border-destructive/50 bg-destructive/10")}>
          <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", item.guard ? "text-amber-600" : "text-destructive")} aria-hidden />
          <span>{item.content}</span>
        </div>
      );
    }
    return (
      <div className={cn("max-w-[95%]", dark && "[&_a]:text-indigo-300")}>
        <Markdown text={item.content} />
        {item.link && (
          <Link href={item.link} className="mt-1 inline-block text-sm font-medium text-primary underline underline-offset-2">open</Link>
        )}
      </div>
    );
  }

  // Tool step
  const c = item.confirmation;
  return (
    <div className="grid gap-2">
      <div className={cn("flex items-start gap-2 text-xs", dark ? "text-white/70" : "text-muted-foreground")}>
        {item.running ? (
          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : c ? (
          <ShieldQuestion className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
        ) : item.ok ? (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
        )}
        <span>
          <span className="font-medium">{item.label}</span>
          {item.summary && !c && <> — {item.summary}</>}
          {item.link && !c && (
            <> · <Link href={item.link} className="text-primary underline underline-offset-2">open</Link></>
          )}
        </span>
      </div>

      {item.candidates && item.candidates.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-5" role="group" aria-label="Choose a person">
          {item.candidates.map((cand) => (
            <Button key={cand.id} type="button" size="sm" variant="outline" disabled={busy} className={cn("h-auto flex-col items-start py-1.5", dark && "border-white/20 bg-transparent text-white hover:bg-white/10")} onClick={() => onPick(`I mean ${cand.displayName} (${cand.email})`)}>
              <span className="font-medium">{cand.displayName}</span>
              <span className="text-xs opacity-70">{cand.email}{cand.title ? ` · ${cand.title}` : ""}</span>
            </Button>
          ))}
        </div>
      )}

      {item.citations && item.citations.length > 0 && <CitationList citations={item.citations} dark={dark} className="pl-5" />}

      {c && (
        <div className={cn("ml-5 rounded-lg border p-3 text-sm", dark ? "border-white/15 bg-white/5" : "bg-muted/40")}>
          <p className="font-medium">{item.summary}</p>
          {c.state === "pending" ? (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => onDecide(c.actionId, "confirm")} disabled={busy}>Confirm</Button>
              <Button size="sm" variant="outline" onClick={() => onDecide(c.actionId, "reject")} disabled={busy} className={cn(dark && "border-white/20 bg-transparent text-white hover:bg-white/10")}>Cancel</Button>
            </div>
          ) : (
            <p className={cn("mt-2 flex items-center gap-1.5 text-xs", dark ? "text-white/60" : "text-muted-foreground")}>
              {c.state === "confirmed" ? <><CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden /> Confirmed and done</>
                : c.state === "rejected" ? <><CircleSlash className="size-3.5" aria-hidden /> You cancelled this</>
                : c.state === "expired" ? <><Clock className="size-3.5" aria-hidden /> Expired — ask again</>
                : <><XCircle className="size-3.5 text-destructive" aria-hidden /> Failed</>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
