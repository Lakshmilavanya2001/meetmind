"use client";

import { useCallback, useRef, useState } from "react";
import { api } from "@/lib/api";

export type Candidate = { id: string; displayName: string; email: string; title?: string | null };
export type PlanView = {
  id: string;
  goal: string;
  status: "proposed" | "running" | "completed" | "partial" | "failed" | "rejected" | "expired";
  revision: number;
  steps: { index: number; summary: string; why: string; agent: string; status: "pending" | "done" | "failed" | "skipped"; resultSummary?: string; error?: string; link?: string; dependsOn: number[] }[];
};
export type Item =
  | { kind: "user"; id: string; content: string }
  | { kind: "handoff"; id: string; agent: string; name: string; task: string; total: number }
  | { kind: "plan"; id: string; plan: PlanView }
  | { kind: "assistant"; id: string; content: string; guard?: boolean; streaming?: boolean; error?: boolean; link?: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      label: string;
      ok?: boolean;
      running?: boolean;
      summary: string;
      link?: string;
      candidates?: Candidate[];
      citations?: import("@/components/transcripts/citations").CitationView[];
      confirmation?: { actionId: string; state: "pending" | "confirmed" | "rejected" | "failed" | "expired" };
    };

type ServerMessage =
  | { id: string; kind: "user" | "assistant"; content: string; guard?: boolean; link?: string }
  | Extract<Item, { kind: "handoff" }>
  | Extract<Item, { kind: "plan" }>
  | Omit<Extract<Item, { kind: "tool" }>, "running">;

let seq = 0;
const tmpId = () => `tmp-${++seq}`;

export function useAssistant(opts: { meetingRef?: string; onConversation?: (id: string) => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const convRef = useRef<string | null>(null);

  const load = useCallback(async (id: string | null) => {
    convRef.current = id;
    setConversationId(id);
    if (!id) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ messages: ServerMessage[] }>(`/api/assistant/conversations/${id}`);
      if (convRef.current === id) setItems(res.messages as Item[]);
    } catch (err) {
      setItems([{ kind: "assistant", id: tmpId(), content: err instanceof Error ? err.message : "Could not load the conversation.", error: true }]);
    } finally {
      setLoading(false);
    }
  }, []);

  const send = useCallback(
    async (text: string, how?: { channel?: "text" | "voice"; language?: string }) => {
      const message = text.trim();
      if (!message || busy) return;
      setBusy(true);
      setItems((prev) => [...prev, { kind: "user", id: tmpId(), content: message }]);

      const update = (fn: (prev: Item[]) => Item[]) => setItems(fn);
      const appendText = (t: string) =>
        update((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === "assistant" && last.streaming) return [...prev.slice(0, -1), { ...last, content: last.content + t }];
          return [...prev, { kind: "assistant", id: tmpId(), content: t, streaming: true }];
        });

      let convId = convRef.current;
      try {
        const res = await fetch("/api/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, conversationId: convRef.current ?? undefined, meetingRef: opts.meetingRef, channel: how?.channel, language: how?.language }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (!chunk.startsWith("data:")) continue;
            const e = JSON.parse(chunk.slice(5));
            switch (e.type) {
              case "conversation":
                convId = e.id;
                convRef.current = e.id;
                setConversationId(e.id);
                opts.onConversation?.(e.id);
                break;
              case "delta":
                appendText(e.text);
                break;
              case "handoff":
                update((prev) => [
                  ...prev.map((p) => (p.kind === "assistant" && p.streaming ? { ...p, streaming: false } : p)),
                  { kind: "handoff", id: tmpId(), agent: e.agent, name: e.name, task: e.task, total: e.total },
                ]);
                break;
              case "tool_start":
                update((prev) => [...prev.map((p) => (p.kind === "assistant" && p.streaming ? { ...p, streaming: false } : p)), { kind: "tool", id: e.id, name: e.name, label: e.label, running: true, summary: "" }]);
                break;
              case "tool_end":
                update((prev) => prev.map((p) => (p.kind === "tool" && p.id === e.id ? { ...p, running: false, ok: e.ok, summary: e.summary, link: e.link, candidates: e.candidates, citations: e.citations } : p)));
                break;
              case "confirmation":
                update((prev) => {
                  const i = prev.findLastIndex((p) => p.kind === "tool" && p.name === e.toolName);
                  if (i < 0) return prev;
                  const copy = [...prev];
                  copy[i] = { ...(copy[i] as Extract<Item, { kind: "tool" }>), confirmation: { actionId: e.actionId, state: "pending" } };
                  return copy;
                });
                break;
              case "plan":
                update((prev) => [...prev, { kind: "plan", id: `plan-${e.plan.id}`, plan: e.plan }]);
                break;
              case "guard":
                update((prev) => [...prev, { kind: "assistant", id: tmpId(), content: e.message, guard: true }]);
                break;
              case "error":
                update((prev) => [...prev, { kind: "assistant", id: tmpId(), content: e.message, error: true }]);
                break;
            }
          }
        }
      } catch (err) {
        setItems((prev) => [...prev, { kind: "assistant", id: tmpId(), content: err instanceof Error ? err.message : "Could not reach the assistant.", error: true }]);
      } finally {
        setBusy(false);
        // Re-sync with the server's canonical record (ids, confirmation states).
        if (convId) {
          try {
            const res = await api<{ messages: ServerMessage[] }>(`/api/assistant/conversations/${convId}`);
            if (convRef.current === convId) setItems((prev) => [...(res.messages as Item[]), ...prev.filter((p) => p.kind === "assistant" && p.error)]);
          } catch {
            /* keep the streamed view */
          }
        }
      }
    },
    [busy, opts],
  );

  const decide = useCallback(
    async (actionId: string, decision: "confirm" | "reject"): Promise<string | null> => {
      setBusy(true);
      try {
        const res = await api<{ message?: { content: string } }>(`/api/assistant/actions/${actionId}`, { method: "POST", json: { decision } });
        return res.message?.content ?? null;
      } catch (err) {
        setItems((prev) => [...prev, { kind: "assistant", id: tmpId(), content: err instanceof Error ? err.message : "Could not complete that.", error: true }]);
        return err instanceof Error ? err.message : null;
      } finally {
        setBusy(false);
        if (convRef.current) {
          const keepErrors = (prev: Item[]) => prev.filter((p) => p.kind === "assistant" && p.error && p.id.startsWith("tmp"));
          try {
            const res = await api<{ messages: ServerMessage[] }>(`/api/assistant/conversations/${convRef.current}`);
            setItems((prev) => [...(res.messages as Item[]), ...keepErrors(prev)]);
          } catch {
            /* ignore */
          }
        }
      }
    },
    [],
  );

  const decidePlan = useCallback(async (planId: string, decision: "approve" | "reject"): Promise<string | null> => {
    setBusy(true);
    try {
      const res = await api<{ message?: { content: string } }>(`/api/assistant/plans/${planId}`, { method: "POST", json: { decision } });
      return res.message?.content ?? null;
    } catch (err) {
      setItems((prev) => [...prev, { kind: "assistant", id: tmpId(), content: err instanceof Error ? err.message : "Could not complete that.", error: true }]);
      return err instanceof Error ? err.message : null;
    } finally {
      setBusy(false);
      if (convRef.current) {
        try {
          const res = await api<{ messages: ServerMessage[] }>(`/api/assistant/conversations/${convRef.current}`);
          setItems((prev) => [...(res.messages as Item[]), ...prev.filter((p) => p.kind === "assistant" && p.error && p.id.startsWith("tmp"))]);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  return { conversationId, items, busy, loading, send, decide, decidePlan, load };
}
