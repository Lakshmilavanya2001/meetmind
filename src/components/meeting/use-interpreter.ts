"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RemoteParticipant, RoomEvent, Track, type RemoteTrackPublication } from "livekit-client";
import { api } from "@/lib/api";

// Mirrors src/server/interpreter/constants.ts (that module is server-side).
export const INTERPRETER_IDENTITY = "agent-interpreter";
const TOPIC = "interpreter";
const trackName = (lang: string) => `interpreter-${lang}`;

const VOLUME_KEY = "meetmind.interpreter.originalVolume";

export type VoiceOption = { id: string; speaker: string; tone: string | null };
export type InterpretationState = { enabled: boolean; canManage: boolean; available: boolean; myLanguage: string; chosen?: boolean; myVoice?: boolean; languages: { code: string; name: string; voice: boolean }[]; engines?: { indic: boolean }; voices?: VoiceOption[]; defaultVoice?: string | null; myVoiceId?: string | null };
export type Latency = { asrMs: number; mtMs: number; ttsMs: number; queueMs: number; totalMs: number; spoken: boolean };
export type Line = { id: string; speakerId: string; speaker: string; language: string; text: string; at: number; translations: Record<string, string>; latency: Record<string, Latency> };

const decoder = new TextDecoder();

/**
 * Live interpretation in the call: state, the interpreter's messages (original + translated lines with
 * latency), and audio routing — you hear the interpreter in your language, and other-language voices
 * are turned down (like a human interpreter's booth).
 */
export function useInterpreter(meetingRef: string) {
  const room = useRoomContext();
  const [state, setState] = useState<InterpretationState | null>(null);
  const [roster, setRoster] = useState<{ languages: Record<string, string>; voices: string[] }>({ languages: {}, voices: [] });
  const [lines, setLines] = useState<Line[]>([]);
  // How loud other-language speakers stay under the translation. Muted by default: listeners hear only
  // the translated voice. Each person's choice is remembered on their device.
  const [originalVolume, setOriginalVolumeState] = useState(() => {
    try {
      const v = Number(localStorage.getItem(VOLUME_KEY));
      return localStorage.getItem(VOLUME_KEY) !== null && [0, 0.15, 1].includes(v) ? v : 0;
    } catch {
      return 0;
    }
  });
  const setOriginalVolume = useCallback((v: number) => {
    setOriginalVolumeState(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      /* not saved; still applies to this call */
    }
  }, []);
  const [agentPresent, setAgentPresent] = useState(() => room.remoteParticipants.has(INTERPRETER_IDENTITY));

  useEffect(() => {
    // Someone joining after the interpreter gets it in the room's join response, with no "participant
    // connected" event, so presence is re-checked on connect/reconnect and track events too, and every 2 s.
    // (Without this the panel said "The interpreter is joining the call…" for the whole call.)
    const check = () => setAgentPresent(room.remoteParticipants.has(INTERPRETER_IDENTITY));
    const events = [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.Connected, RoomEvent.Reconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackPublished] as const;
    check();
    for (const e of events) room.on(e, check);
    const t = setInterval(check, 2000);
    return () => {
      for (const e of events) room.off(e, check);
      clearInterval(t);
    };
  }, [room]);

  const refresh = useCallback(async () => {
    try {
      setState(await api<InterpretationState>(`/api/meetings/${meetingRef}/interpretation`));
    } catch {
      /* keep */
    }
  }, [meetingRef]);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, 15_000);
    room.on(RoomEvent.RoomMetadataChanged, refresh);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      room.off(RoomEvent.RoomMetadataChanged, refresh);
    };
  }, [room, refresh]);

  // Messages from the interpreter.
  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== TOPIC || participant?.identity !== INTERPRETER_IDENTITY) return;
      setAgentPresent(true); // a message from the interpreter proves it's here
      let m: { type: string; [k: string]: unknown };
      try {
        m = JSON.parse(decoder.decode(payload));
      } catch {
        return;
      }
      if (m.type === "roster") setRoster({ languages: (m.languages as Record<string, string>) ?? {}, voices: (m.voices as string[]) ?? [] });
      else if (m.type === "line")
        setLines((prev) => [...prev.filter((l) => l.id !== m.id), { id: m.id as string, speakerId: m.speakerId as string, speaker: m.speaker as string, language: m.language as string, text: m.text as string, at: Date.now(), translations: {}, latency: {} }].slice(-30));
      else if (m.type === "translation")
        setLines((prev) => prev.map((l) => (l.id === m.id ? { ...l, translations: { ...l.translations, [m.language as string]: m.text as string } } : l)));
      else if (m.type === "latency")
        setLines((prev) => prev.map((l) => (l.id === m.id ? { ...l, latency: { ...l.latency, [m.language as string]: m as unknown as Latency } } : l)));
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  // Audio routing.
  const enabled = !!state?.enabled;
  const myLanguage = state?.myLanguage ?? "en";
  const route = useCallback(() => {
    for (const p of room.remoteParticipants.values()) {
      if (p.identity === INTERPRETER_IDENTITY) {
        for (const pub of p.audioTrackPublications.values()) (pub as RemoteTrackPublication).setSubscribed(enabled && pub.trackName === trackName(myLanguage));
        continue;
      }
      const theirs = roster.languages[p.identity];
      const translated = enabled && !!theirs && theirs !== myLanguage && roster.voices.includes(myLanguage);
      // "Muted": don't receive their original voice at all. Turning the volume down isn't enough: some
      // browsers (iPhone Safari) ignore page volume, and the original would play under the translation.
      const mute = translated && originalVolume === 0;
      for (const pub of p.audioTrackPublications.values()) {
        if (pub.source !== Track.Source.Microphone) continue;
        const remote = pub as RemoteTrackPublication;
        if (remote.isDesired === mute) remote.setSubscribed(!mute);
      }
      p.setVolume(translated ? originalVolume : 1, Track.Source.Microphone);
    }
  }, [room, enabled, myLanguage, roster, originalVolume]);

  useEffect(() => {
    route();
    const events = [RoomEvent.TrackPublished, RoomEvent.TrackSubscribed, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected] as const;
    for (const e of events) room.on(e, route);
    return () => {
      for (const e of events) room.off(e, route);
    };
  }, [room, route]);

  const setEnabled = useCallback(
    async (on: boolean) => setState(await api<InterpretationState>(`/api/meetings/${meetingRef}/interpretation`, { method: "POST", json: { enabled: on } })),
    [meetingRef],
  );
  const setLanguage = useCallback(
    async (language: string) => setState(await api<InterpretationState>(`/api/meetings/${meetingRef}/interpretation/me`, { method: "PUT", json: { language } })),
    [meetingRef],
  );

  const setVoice = useCallback(
    async (voice: string | null) => setState(await api<InterpretationState>(`/api/meetings/${meetingRef}/interpretation/me/voice`, { method: "PUT", json: { voice } })),
    [meetingRef],
  );
  /** A short sample of a voice, as audio to play. */
  const previewVoice = useCallback(
    async (voice: string | null) => {
      const res = await fetch(`/api/meetings/${meetingRef}/interpretation/voice-preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "Couldn't play the sample");
      return res.blob();
    },
    [meetingRef],
  );

  const stopMyVoice = useCallback(async () => setState(await api<InterpretationState>(`/api/meetings/${meetingRef}/interpretation/me`, { method: "DELETE" })), [meetingRef]);

  // Average end-to-end latency of what this person heard.
  const stats = useMemo(() => {
    const totals = lines.flatMap((l) => (l.latency[myLanguage]?.spoken ? [l.latency[myLanguage].totalMs] : []));
    return { count: totals.length, avgMs: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null };
  }, [lines, myLanguage]);

  return { state, enabled, myLanguage, roster, lines, stats, agentPresent, originalVolume, setOriginalVolume, setEnabled, setLanguage, setVoice, previewVoice, stopMyVoice };
}
