"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { encodeWav, resample, SpeechChunker, TARGET_RATE } from "@/lib/audio/wav";
import { SpeechPlayer } from "@/lib/audio/speech-player";

/** Script → language, to read a reply in the right voice. */
export function languageOfText(text: string, fallback: string) {
  const ranges: [RegExp, string][] = [[/[ऀ-ॿ]/, "hi"], [/[஀-௿]/, "ta"], [/[ఀ-౿]/, "te"], [/[ಀ-೿]/, "kn"], [/[ഀ-ൿ]/, "ml"], [/[ঀ-৿]/, "bn"], [/[઀-૿]/, "gu"], [/[਀-੿]/, "pa"], [/[଀-୿]/, "or"], [/[؀-ۿ]/, "ur"]];
  for (const [re, l] of ranges) if (re.test(text)) return l === "hi" && fallback !== "hi" && ["mr", "ne", "mai", "doi", "kok", "sa", "brx"].includes(fallback) ? fallback : l;
  return /[a-z]/i.test(text) ? "en" : fallback;
}

/** Quiet time after the assistant stops speaking before the mic is heard again (echo tail). */
const RESUME_AFTER_MS = 400;

/**
 * Talk to the assistant hands-free. `listen()` turns the mic on and it stays on until `listen()` is
 * called again: every time you pause, what you said is transcribed and sent. While the assistant is
 * working (`busy`) or speaking, the mic is ignored so it never hears itself or half a reply.
 */
export function useVoiceIO(language: string, busy = false) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem("mm.speakReplies") === "1";
    } catch {
      return false;
    }
  });
  const stopRef = useRef<(() => void) | null>(null);
  const langRef = useRef(language);
  useEffect(() => {
    langRef.current = language;
  }, [language]);
  const player = useRef<SpeechPlayer | null>(null);
  const getPlayer = () => (player.current ??= new SpeechPlayer((t) => languageOfText(t, langRef.current)));
  // Read inside the audio callback, which outlives renders.
  const hold = useRef({ busy, speaking: false, transcribing: false, until: 0 });
  useEffect(() => {
    hold.current.busy = busy;
  }, [busy]);

  useEffect(
    () => () => {
      stopRef.current?.();
      player.current?.stop();
    },
    [],
  );

  const listen = useCallback(
    async (onText: (text: string) => void) => {
      if (stopRef.current) return stopRef.current();
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } });
      } catch {
        toast.error("Microphone access was blocked.");
        return;
      }
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule("/audio/pcm-capture-worklet.js");
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-capture");
      const mute = ctx.createGain();
      mute.gain.value = 0;
      let done = false;
      const stop = () => {
        if (done) return;
        done = true;
        setListening(false);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        stopRef.current = null;
      };
      stopRef.current = stop;

      const transcribe = async (samples: Float32Array) => {
        hold.current.transcribing = true;
        setTranscribing(true);
        try {
          const form = new FormData();
          form.append("audio", encodeWav(samples, TARGET_RATE), "speech.wav");
          form.append("language", language);
          const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message ?? "Couldn't understand that");
          if (data.text && !done) onText(data.text);
        } catch (err) {
          if (!done) toast.error(err instanceof Error ? err.message : "Couldn't understand that");
        } finally {
          hold.current.transcribing = false;
          setTranscribing(false);
        }
      };

      let chunker: SpeechChunker;
      const newChunker = () => new SpeechChunker((c) => void transcribe(c.samples), { minMs: 400, maxMs: 15_000, pauseMs: 900, frameMs: 100 });
      chunker = newChunker();
      let wasHeld = false;
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        const h = hold.current;
        const held = h.busy || h.speaking || h.transcribing || Date.now() < h.until;
        if (held) {
          // Throw away anything half-heard, so the next question starts clean.
          if (!wasHeld) chunker = newChunker();
          wasHeld = true;
          return;
        }
        wasHeld = false;
        chunker.push(resample(e.data, ctx.sampleRate), Date.now());
      };
      src.connect(node);
      node.connect(mute).connect(ctx.destination);
      setListening(true);
    },
    [language],
  );

  const startSpeaking = () => {
    if (hold.current.speaking) return;
    hold.current.speaking = true;
    setSpeaking(true);
  };
  const doneSpeaking = () => {
    hold.current.speaking = false;
    hold.current.until = Date.now() + RESUME_AFTER_MS;
    setSpeaking(false);
  };

  /** The reply so far (it grows while the assistant writes): complete sentences start playing at once. */
  const feed = useCallback((replySoFar: string) => {
    if (!replySoFar.trim()) return;
    startSpeaking();
    getPlayer().feed(replySoFar);
  }, []);

  /** The reply is complete: speak the rest. Resolves when everything has been played. */
  const finish = useCallback(async (reply: string) => {
    if (!reply.trim() && !hold.current.speaking) return;
    startSpeaking();
    try {
      await getPlayer().end(reply);
    } finally {
      doneSpeaking();
    }
  }, []);

  /** Read one complete text aloud; resolves when it has finished. */
  const speak = useCallback((markdown: string) => finish(markdown), [finish]);

  const stopSpeaking = useCallback(() => {
    player.current?.stop();
    doneSpeaking();
  }, []);

  const toggleSpeak = useCallback(() => {
    setSpeakReplies((v) => {
      try {
        localStorage.setItem("mm.speakReplies", v ? "0" : "1");
      } catch {
        /* preference only */
      }
      if (v) player.current?.stop();
      return !v;
    });
  }, []);

  return { listening, transcribing, speaking, listen, speak, feed, finish, stopSpeaking, speakReplies, toggleSpeak };
}
