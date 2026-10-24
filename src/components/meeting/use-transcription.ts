"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { api } from "@/lib/api";
import { encodeWav, resample, SpeechChunker, TARGET_RATE } from "@/lib/audio/wav";

export type TranscriptionState = { enabled: boolean; myConsent: boolean; canManage: boolean; transcriptStatus: string | null; sttConfigured: boolean };

/** Server state, refreshed instantly when the host flips it (room metadata) and every 15 s as a fallback. */
export function useTranscriptionState(meetingRef: string) {
  const room = useRoomContext();
  const [state, setState] = useState<TranscriptionState | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await api<TranscriptionState>(`/api/meetings/${meetingRef}/transcription`));
    } catch {
      /* keep last state */
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
  return { state, setState, refresh };
}

export type CaptureStatus = { active: boolean; uploaded: number; failed: number; lastError: string | null };

/**
 * Capture the local microphone for transcription — only while `active` (transcription on AND consent given).
 * Taps the same track LiveKit publishes; muted tracks produce silence, which is never uploaded.
 */
export function useTranscriptionCapture(meetingRef: string, active: boolean) {
  const { microphoneTrack } = useLocalParticipant();
  const track = microphoneTrack?.track?.mediaStreamTrack;
  const [status, setStatus] = useState<CaptureStatus>({ active: false, uploaded: 0, failed: 0, lastError: null });
  const refRef = useRef(meetingRef);
  refRef.current = meetingRef;

  useEffect(() => {
    if (!active || !track) return;
    let stopped = false;
    let ctx: AudioContext | null = null;
    let chunker: SpeechChunker | null = null;

    const upload = async (blob: Blob, startedAt: number, durationMs: number) => {
      const id = crypto.randomUUID();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const form = new FormData();
          form.append("audio", blob, "chunk.wav");
          form.append("clientChunkId", id); // idempotency: retries never create duplicates
          form.append("capturedAt", new Date(startedAt).toISOString());
          form.append("durationMs", String(durationMs));
          const res = await fetch(`/api/meetings/${refRef.current}/transcription/chunks`, { method: "POST", body: form });
          if (res.ok) {
            setStatus((s) => ({ ...s, uploaded: s.uploaded + 1, lastError: null }));
            return;
          }
          const body = await res.json().catch(() => ({}));
          if (res.status < 500 && res.status !== 429) {
            setStatus((s) => ({ ...s, failed: s.failed + 1, lastError: body?.error?.message ?? `Upload failed (${res.status})` }));
            return;
          }
        } catch {
          /* network: retry */
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
      setStatus((s) => ({ ...s, failed: s.failed + 1, lastError: "Couldn't upload audio for transcription." }));
    };

    (async () => {
      try {
        ctx = new AudioContext();
        await ctx.audioWorklet.addModule("/audio/pcm-capture-worklet.js");
        if (stopped) return;
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const node = new AudioWorkletNode(ctx, "pcm-capture");
        const rate = ctx.sampleRate;
        // Short-ish chunks keep live captions within a few seconds of speech.
        chunker = new SpeechChunker((c) => upload(encodeWav(c.samples, TARGET_RATE), c.startedAt, c.durationMs), { minMs: 2000, maxMs: 12_000, pauseMs: 700, frameMs: 100 });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => chunker?.push(resample(e.data, rate), Date.now() - 100);
        source.connect(node);
        // The worklet must be pulled by the graph; route it to a muted gain so nothing is played back.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);
        setStatus((s) => ({ ...s, active: true }));
      } catch (err) {
        setStatus((s) => ({ ...s, active: false, lastError: `Audio capture unavailable: ${(err as Error).message}` }));
      }
    })();

    return () => {
      stopped = true;
      chunker?.flush(); // send the last utterance
      ctx?.close();
      setStatus((s) => ({ ...s, active: false }));
    };
  }, [active, track]);

  return status;
}
