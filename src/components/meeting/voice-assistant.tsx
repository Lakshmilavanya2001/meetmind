"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { Ear, Loader2, Mic, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { encodeWav, resample, SpeechChunker, TARGET_RATE } from "@/lib/audio/wav";
import { cn } from "@/lib/utils";
import { SpeechPlayer } from "@/lib/audio/speech-player";

type Speech = { text: string; language: string; audioBase64?: string; mimeType?: string; stream?: boolean };
type VoiceReply = {
  heard: string;
  triggered: boolean;
  conversationId?: string;
  reply?: string;
  speech?: Speech;
  confirmation?: { actionId: string; summary: string };
  expectCommand?: boolean;
};
type Phase = "idle" | "listening" | "thinking" | "speaking" | "confirm";

const WAKE_KEY = "mm.heyMind";
const BCP47: Record<string, string> = { en: "en-US", hi: "hi-IN", bn: "bn-IN", ta: "ta-IN", te: "te-IN", mr: "mr-IN", gu: "gu-IN", kn: "kn-IN", ml: "ml-IN", pa: "pa-IN", ur: "ur-IN", es: "es-ES", fr: "fr-FR", de: "de-DE" };

let currentAudio: { el: HTMLAudioElement; done: () => void } | null = null;
let streamed: SpeechPlayer | null = null;
/** Stop anything the assistant is saying (e.g. when leaving the call). */
export function stopSpeech() {
  streamed?.stop();
  streamed = null;
  if (currentAudio) {
    currentAudio.el.pause();
    currentAudio.done();
    currentAudio = null;
  }
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/** Play the assistant's reply: server-synthesised audio if provided, otherwise the browser's own voice. */
export function playSpeech(s: Speech): Promise<void> {
  if (s.stream && s.text) {
    // Streamed sentence by sentence: the first words play in about half a second.
    streamed?.stop();
    const player = new SpeechPlayer(() => s.language);
    streamed = player;
    return player.say(s.text).finally(() => {
      if (streamed === player) streamed = null;
    });
  }
  return new Promise((resolve) => {
    if (s.audioBase64) {
      const bytes = Uint8Array.from(atob(s.audioBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: s.mimeType ?? "audio/wav" }));
      const audio = new Audio(url);
      const done = () => {
        URL.revokeObjectURL(url);
        if (currentAudio?.el === audio) currentAudio = null;
        resolve();
      };
      currentAudio = { el: audio, done };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
      return;
    }
    if (typeof speechSynthesis === "undefined" || !s.text) return resolve();
    const u = new SpeechSynthesisUtterance(s.text);
    u.lang = BCP47[s.language] ?? s.language;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(u.lang.toLowerCase().slice(0, 2)));
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

/**
 * Voice assistant inside a call: push-to-talk, or say "Hey Mind …" when listening is on.
 * Audio is taken from your own microphone only; while the assistant speaks, capture pauses so it doesn't hear itself.
 */
export function VoiceAssistant({ meetingRef, conversationId, onConversation }: { meetingRef: string; conversationId: string | null; onConversation: (id: string) => void }) {
  const { microphoneTrack, isMicrophoneEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const track = microphoneTrack?.track?.mediaStreamTrack;
  const [wakeOn, setWakeOn] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(WAKE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState<{ actionId: string; summary: string } | null>(null);

  // Mutable mirrors for the audio callback.
  const modeRef = useRef<"wake" | "ptt" | "confirm" | null>(null);
  const busyRef = useRef(false);
  const convRef = useRef(conversationId);
  const pendingRef = useRef(pending);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    convRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const baseMode = useCallback(() => (wakeOn ? "wake" : null), [wakeOn]);

  // Leaving the call: stop speaking, drop pending requests and timers.
  const inflight = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      stopSpeech();
      inflight.current?.abort();
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  // "Hey Mind" listening is remembered per browser; say so whenever it's switched back on in a call.
  const told = useRef(false);
  useEffect(() => {
    if (!wakeOn || told.current || !isMicrophoneEnabled) return;
    told.current = true;
    toast.message("Listening for “Hey Mind”", {
      description: "You turned this on earlier. While your mic is on, what you say is sent to speech recognition and discarded unless it starts with “Hey Mind”. Turn it off with the ear button.",
    });
  }, [wakeOn, isMicrophoneEnabled]);

  // Keep the AI interpreter (if it's in the call) informed, so my commands and yes/no answers aren't
  // translated and spoken to everyone else: whether I'm listening for "Hey Mind", whether each thing
  // I said was for the assistant, and when I'm in a conversation with it.
  const tellInterpreter = useCallback(
    (m: { wake?: boolean; verdict?: "assistant" | "call"; active?: boolean; checking?: boolean }) => {
      // Use the room's current participant at send time (a reference kept from an earlier render can
      // belong to a connection that has since been replaced).
      if (room.state !== "connected") return;
      room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(m)), { reliable: true, topic: "assistant-state", destinationIdentities: ["agent-interpreter"] })
        .catch(() => {
          /* no interpreter in the call: nothing to tell */
        });
    },
    [room],
  );
  const withAssistant = phase !== "idle";
  useEffect(() => tellInterpreter({ active: withAssistant }), [withAssistant, tellInterpreter]);
  const wakeListening = wakeOn && isMicrophoneEnabled;
  useEffect(() => {
    // Repeated (on or off) because the interpreter may join the call at any time.
    tellInterpreter({ wake: wakeListening });
    const t = setInterval(() => tellInterpreter({ wake: wakeListening }), 1500);
    return () => clearInterval(t);
  }, [wakeListening, tellInterpreter]);
  const finishTurn = useCallback(
    (next: "wake" | "ptt" | "confirm" | null) => {
      modeRef.current = next ?? baseMode();
      setPhase(next === "confirm" ? "confirm" : next === "ptt" ? "listening" : "idle");
    },
    [baseMode],
  );

  const send = useCallback(
    async (wav: Blob) => {
      const mode = modeRef.current;
      if (!mode || busyRef.current) return;
      busyRef.current = true;
      if (mode !== "wake") setPhase("thinking");
      try {
        const form = new FormData();
        form.append("audio", wav, "utterance.wav");
        form.append("meetingRef", meetingRef);
        form.append("mode", mode);
        form.append("streamSpeech", "1");
        if (convRef.current) form.append("conversationId", convRef.current);
        if (mode === "confirm" && pendingRef.current) form.append("actionId", pendingRef.current.actionId);
        const ctrl = new AbortController();
        inflight.current = ctrl;
        // The interpreter holds what this person says until the verdict; tell it a check is under way so it
        // waits for the answer however long recognition takes, instead of translating after a fixed time.
        if (mode === "wake") tellInterpreter({ checking: true });
        const res = await fetch("/api/voice/utterance", { method: "POST", body: form, signal: ctrl.signal, headers: { accept: "application/x-ndjson" } });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error?.message ?? "The voice assistant couldn't process that.");
        }
        // Two lines: whether it was addressed to the assistant (as soon as it's recognised), then the reply.
        let r: VoiceReply | null = null;
        let told = false;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (value) buf += value;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const msg = JSON.parse(buf.slice(0, nl)) as { type: string; triggered?: boolean; message?: string } & VoiceReply;
            buf = buf.slice(nl + 1);
            if (msg.type === "heard" && mode === "wake") {
              tellInterpreter({ verdict: msg.triggered ? "assistant" : "call" });
              told = true;
            } else if (msg.type === "reply") r = msg;
            else if (msg.type === "error") throw new Error(msg.message ?? "The voice assistant couldn't process that.");
          }
          if (done) break;
        }
        if (!r) throw new Error("The voice assistant couldn't process that.");
        if (mode === "wake" && !told) tellInterpreter({ verdict: r.triggered ? "assistant" : "call" });
        if (!r.triggered) {
          // Not addressed to the assistant: say nothing, keep listening.
          if (mode === "ptt" && !r.heard) toast.info("I didn't catch that — try again.");
          finishTurn(mode === "ptt" ? null : mode);
          return;
        }
        if (r.conversationId) onConversation(r.conversationId);
        setHeard(r.heard);
        setReply(r.reply ?? "");
        setPending(r.confirmation ?? (mode === "confirm" ? pendingRef.current : null));
        if (mode === "confirm" && r.reply) setPending(null);
        if (r.speech) {
          setPhase("speaking");
          await playSpeech(r.speech);
          await new Promise((t) => setTimeout(t, 300)); // let the room echo die down
        }
        if (r.confirmation) {
          finishTurn("confirm");
          if (confirmTimer.current) clearTimeout(confirmTimer.current);
          confirmTimer.current = setTimeout(() => {
            if (modeRef.current === "confirm") finishTurn(null);
          }, 20_000);
        } else if (mode === "confirm" && !r.reply) finishTurn("confirm"); // "please say yes or no"
        else finishTurn(r.expectCommand ? "ptt" : null);
      } catch (err) {
        if (mode === "wake") tellInterpreter({ verdict: "call" });
        if ((err as Error).name === "AbortError") return;
        toast.error(err instanceof Error ? err.message : "Voice assistant error");
        finishTurn(null);
      } finally {
        busyRef.current = false;
      }
    },
    [meetingRef, onConversation, finishTurn, tellInterpreter],
  );

  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Capture utterances from the local microphone while any mode is active.
  const active = !!track && isMicrophoneEnabled && (wakeOn || phase !== "idle");
  useEffect(() => {
    if (!active || !track) return;
    let ctx: AudioContext | null = null;
    let stopped = false;
    // While listening for "Hey Mind", the interpreter holds this person's speech until we say whether it was a
    // command. Tell it a check has begun as soon as they start talking (so a slow check can't let a command
    // through), and that there won't be one when a sound is dropped or can't be checked now.
    const wake = () => modeRef.current === "wake";
    const notChecking = () => wake() && tellInterpreter({ checking: false });
    const chunker = new SpeechChunker(
      (c) => {
        if (stopped || busyRef.current || phaseRef.current === "speaking") return notChecking();
        send(encodeWav(c.samples, TARGET_RATE));
      },
      { minMs: 300, maxMs: 12_000, pauseMs: 700, frameMs: 100 },
      {
        onStart: () => {
          if (wake() && !busyRef.current && phaseRef.current !== "speaking") tellInterpreter({ checking: true });
        },
        onDrop: notChecking,
      },
    );
    (async () => {
      try {
        ctx = new AudioContext();
        await ctx.audioWorklet.addModule("/audio/pcm-capture-worklet.js");
        if (stopped) return;
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const node = new AudioWorkletNode(ctx, "pcm-capture");
        const rate = ctx.sampleRate;
        node.port.onmessage = (e: MessageEvent<Float32Array>) => {
          if (phaseRef.current === "speaking" || phaseRef.current === "thinking") return; // don't hear ourselves
          chunker.push(resample(e.data, rate), Date.now());
        };
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(node);
        node.connect(mute).connect(ctx.destination);
      } catch (err) {
        toast.error(`Voice assistant can't use the microphone: ${(err as Error).message}`);
      }
    })();
    return () => {
      stopped = true;
      ctx?.close().catch(() => {});
    };
  }, [active, track, send, tellInterpreter]);

  useEffect(() => {
    if (phase === "idle") modeRef.current = baseMode();
  }, [phase, baseMode]);

  function pushToTalk() {
    if (!isMicrophoneEnabled) {
      toast.info("Turn your microphone on to talk to the assistant.");
      return;
    }
    if (phase === "listening") {
      finishTurn(null);
      return;
    }
    setHeard("");
    setReply("");
    modeRef.current = "ptt";
    setPhase("listening");
  }

  function toggleWake() {
    const next = !wakeOn;
    setWakeOn(next);
    try {
      localStorage.setItem(WAKE_KEY, next ? "1" : "0");
    } catch {
      /* preference only */
    }
    if (phase === "idle") modeRef.current = next ? "wake" : null;
    toast.message(next ? "Listening for “Hey Mind”" : "Stopped listening for “Hey Mind”", {
      description: next ? "Only your own microphone is checked, and only while it's on. Speech that doesn't start with “Hey Mind” is discarded." : undefined,
    });
  }

  async function decide(decision: "confirm" | "reject") {
    if (!pending) return;
    try {
      const res = await api<{ message: { content: string } }>(`/api/assistant/actions/${pending.actionId}`, { method: "POST", json: { decision } });
      setReply(res.message.content);
      setPending(null);
      finishTurn(null);
      await playSpeech({ text: res.message.content.replace(/[✓*]/g, ""), language: "en" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't complete that");
    }
  }

  const showCard = phase !== "idle" || !!reply;
  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-lg"
          onClick={pushToTalk}
          aria-label={phase === "listening" ? "Stop listening" : "Ask the assistant by voice"}
          title="Ask the assistant by voice"
          aria-pressed={phase === "listening"}
          className={cn("rounded-full text-white hover:bg-white/10 hover:text-white", phase === "listening" && "bg-indigo-500 hover:bg-indigo-500")}
        >
          {phase === "thinking" ? <Loader2 className="animate-spin" /> : <span className="relative"><Mic /><Sparkles className="absolute -top-1.5 -right-2 size-3" /></span>}
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          onClick={toggleWake}
          aria-label={wakeOn ? "Stop listening for Hey Mind" : "Listen for Hey Mind"}
          title={wakeOn ? "Listening for “Hey Mind”" : "Listen for “Hey Mind”"}
          aria-pressed={wakeOn}
          className={cn("rounded-full text-white hover:bg-white/10 hover:text-white", wakeOn && "bg-indigo-500/60 hover:bg-indigo-500/70")}
        >
          <Ear />
        </Button>
      </div>

      {showCard && (
        <div role="status" aria-live="polite" className="fixed top-16 left-1/2 z-40 w-[min(92vw,30rem)] -translate-x-1/2 rounded-2xl border border-white/15 bg-neutral-900/95 p-4 text-sm text-white shadow-2xl backdrop-blur">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-indigo-300" aria-hidden />
            <div className="min-w-0 flex-1 grid gap-1.5">
              {phase === "listening" && <p className="font-medium">Listening… <span className="font-normal text-white/60">say what you need</span></p>}
              {heard && <p className="text-white/70">You: “{heard}”</p>}
              {phase === "thinking" && <p className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Thinking…</p>}
              {reply && <p>{reply}</p>}
              {phase === "confirm" && pending && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-white/60">Say “yes” or “no”, or</span>
                  <Button size="sm" className="h-7" onClick={() => decide("confirm")}>Yes</Button>
                  <Button size="sm" variant="secondary" className="h-7" onClick={() => decide("reject")}>No</Button>
                </div>
              )}
            </div>
            <Button size="icon-xs" variant="ghost" className="text-white hover:bg-white/10" aria-label="Dismiss" onClick={() => { setHeard(""); setReply(""); setPending(null); finishTurn(null); }}>
              <X />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
