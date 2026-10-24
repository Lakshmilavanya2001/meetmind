"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bell, Check, Loader2, Mail, MessageSquareText, Pencil, Send, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Segment = { startMs: number; endMs: number; speakerLabel: string };
const COLORS = ["bg-sky-500", "bg-violet-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-teal-500"];
export const speakerColor = (labels: string[], label: string) => COLORS[Math.max(0, labels.indexOf(label)) % COLORS.length];
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** Who spoke, for how long — and (for recordings) give "Speaker 1" a real name. */
export function SpeakersCard({ meetingRef, segments, canManage, onRenamed }: { meetingRef: string; segments: Segment[]; canManage: boolean; onRenamed: () => void }) {
  const stats = useMemo(() => {
    const m = new Map<string, { ms: number; turns: number }>();
    for (const s of segments) {
      const v = m.get(s.speakerLabel) ?? { ms: 0, turns: 0 };
      v.ms += Math.max(0, s.endMs - s.startMs);
      v.turns++;
      m.set(s.speakerLabel, v);
    }
    const total = [...m.values()].reduce((a, v) => a + v.ms, 0) || 1;
    return [...m.entries()].map(([label, v]) => ({ label, ...v, pct: Math.round((v.ms / total) * 100) }));
  }, [segments]);
  const labels = stats.map((s) => s.label);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(from: string) {
    if (!name.trim() || name.trim() === from) return setEditing(null);
    setBusy(true);
    try {
      await api(`/api/meetings/${meetingRef}/transcript/speakers`, { method: "POST", json: { from, to: name.trim() } });
      toast.success(`Renamed “${from}” to “${name.trim()}”. Regenerate the summary to use the new name.`);
      setEditing(null);
      onRenamed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename");
    } finally {
      setBusy(false);
    }
  }

  if (stats.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Users className="size-4" aria-hidden /> Speakers</CardTitle>
        <CardDescription>
          {stats.length} speaker{stats.length > 1 ? "s" : ""} identified. In calls, each line comes from that person&apos;s own microphone; in recordings, voices are told apart automatically.
          {canManage && " Rename a speaker to give them their real name."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3" aria-label="Speakers">
          {stats.map((s) => (
            <li key={s.label} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2 text-sm">
                {editing === s.label ? (
                  <form className="flex flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save(s.label); }}>
                    <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label={`New name for ${s.label}`} className="h-8" />
                    <Button size="icon-sm" type="submit" disabled={busy} aria-label="Save name">{busy ? <Loader2 className="animate-spin" /> : <Check />}</Button>
                    <Button size="icon-sm" variant="ghost" type="button" onClick={() => setEditing(null)} aria-label="Cancel"><X /></Button>
                  </form>
                ) : (
                  <span className="flex items-center gap-2 font-medium">
                    <span className={cn("size-2.5 rounded-full", speakerColor(labels, s.label))} aria-hidden />
                    {s.label}
                    {canManage && (
                      <Button size="icon-xs" variant="ghost" aria-label={`Rename ${s.label}`} onClick={() => { setEditing(s.label); setName(s.label); }}><Pencil /></Button>
                    )}
                  </span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{mmss(s.ms)} · {s.pct}% · {s.turns} turn{s.turns > 1 ? "s" : ""}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-muted" aria-hidden><div className={cn("h-full", speakerColor(labels, s.label))} style={{ width: `${s.pct}%` }} /></div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type Deliveries = {
  summaryId: string | null;
  canSend: boolean;
  channels: { email: "smtp" | "outbox" | "off"; sms: "twilio" | "outbox" | "off" };
  people: { userId: string; name: string; email: string; channels: Record<string, { status: string; detail: string | null; at: string }> }[];
};
const CH = [
  { key: "IN_APP", label: "In the app", icon: Bell },
  { key: "EMAIL", label: "Email", icon: Mail },
  { key: "SMS", label: "SMS", icon: MessageSquareText },
] as const;
const STATUS: Record<string, { text: string; cls: string }> = {
  SENT: { text: "Sent", cls: "bg-emerald-600 text-white" },
  OUTBOX: { text: "Outbox", cls: "bg-sky-600 text-white" },
  FAILED: { text: "Failed", cls: "bg-destructive text-white" },
  SKIPPED: { text: "Off", cls: "" },
};

/** How the summary reached each person: in the app, by email and by SMS — with status and time. */
export function DeliveryCard({ meetingRef, summaryId, userTimezone }: { meetingRef: string; summaryId: string | null; userTimezone: string }) {
  const [d, setD] = useState<Deliveries | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setD(await api<Deliveries>(`/api/meetings/${meetingRef}/summary/deliveries`));
    } catch {
      /* keep */
    }
  }, [meetingRef]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    // Automatic delivery runs on the server shortly after the summary is made.
    const i = setInterval(load, 5000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [load, summaryId]);

  async function send() {
    setBusy(true);
    try {
      setD(await api<Deliveries>(`/api/meetings/${meetingRef}/summary/deliver`, { method: "POST" }));
      toast.success("Summary sent to everyone in the call");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send");
    } finally {
      setBusy(false);
    }
  }

  if (!summaryId || !d) return null;
  const mode = (m: string) => (m === "outbox" ? "development outbox — recorded, not sent" : m === "off" ? "not set up on this server" : "live");
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Send className="size-4" aria-hidden /> Summary delivery</CardTitle>
          <CardDescription>
            After the call, everyone who was in it automatically gets the summary <strong>in the app</strong> (notification and this page), by <strong>email</strong> unless they turned it off, and by <strong>SMS</strong> to a verified number if they asked for it.
            {" "}Email: {mode(d.channels.email)}. SMS: {mode(d.channels.sms)}. <Link href="/settings/messages" className="underline underline-offset-2">Your messages</Link>
          </CardDescription>
        </div>
        {d.canSend && (
          <Button size="sm" variant="outline" onClick={send} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />} {d.people.length ? "Send again" : "Send summary"}</Button>
        )}
      </CardHeader>
      <CardContent>
        {d.people.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Not delivered yet — this happens automatically a moment after the summary is made.</p>
        ) : (
          <table className="w-full text-sm" aria-label="Summary delivery">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1 font-medium">Person</th>{CH.map((c) => <th key={c.key} className="font-medium"><span className="inline-flex items-center gap-1"><c.icon className="size-3.5" aria-hidden />{c.label}</span></th>)}</tr>
            </thead>
            <tbody>
              {d.people.map((p) => (
                <tr key={p.userId} className="border-t align-top">
                  <td className="py-2 pr-2"><p className="font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{p.email}</p></td>
                  {CH.map((c) => {
                    const v = p.channels[c.key];
                    if (!v) return <td key={c.key} className="py-2 text-muted-foreground">—</td>;
                    const st = STATUS[v.status] ?? { text: v.status, cls: "" };
                    return (
                      <td key={c.key} className="py-2 pr-2" title={v.detail ?? undefined}>
                        <Badge variant={v.status === "SKIPPED" ? "outline" : "default"} className={st.cls}>{st.text}</Badge>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{v.status === "SKIPPED" ? v.detail : formatDateTime(v.at, userTimezone, { dateStyle: undefined })}</p>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
