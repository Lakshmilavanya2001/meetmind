"use client";

import { useEffect, useRef } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type RemoteParticipant } from "livekit-client";
import { INTERPRETER_IDENTITY } from "./use-interpreter";

/** A transcript line as the server agent sends it the moment it's recognised. */
export type FeedLine = { id: string; speakerId: string; speaker: string; language: string; text: string; startMs: number };

/**
 * Live transcript lines and translations pushed by the server agent over the call's data channel (topic
 * "interpreter"). The agent is in the call whenever transcription or interpretation is on, so the transcript
 * panel and captions can show a line as soon as it's recognised instead of polling for it.
 */
export function useCallFeed(handlers: { onLine?: (l: FeedLine) => void; onTranslation?: (id: string, language: string, text: string) => void }) {
  const room = useRoomContext();
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const decoder = new TextDecoder();
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== "interpreter" || participant?.identity !== INTERPRETER_IDENTITY) return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(decoder.decode(payload));
      } catch {
        return;
      }
      if (m.type === "line" && typeof m.id === "string")
        ref.current.onLine?.({ id: m.id, speakerId: String(m.speakerId ?? ""), speaker: String(m.speaker ?? ""), language: String(m.language ?? ""), text: String(m.text ?? ""), startMs: Number(m.startMs ?? 0) });
      else if (m.type === "translation" && typeof m.id === "string") ref.current.onTranslation?.(m.id, String(m.language), String(m.text ?? ""));
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);
}
