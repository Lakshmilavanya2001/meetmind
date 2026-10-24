"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { BellRing, Loader2, MessageSquareText, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/common/empty-state";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { addDaysToDate, dateInZone, zonedWallTimeToUtc } from "@/lib/time";

type Reminder = { id: string; text: string; dueAt: string; sms: boolean; status: string; source: string; sentAt: string | null; smsStatus: string | null };
const SOURCE: Record<string, string> = { assistant: "via assistant", action_item: "action item", user: "" };

export function RemindersCard({ timezone, upcoming, recent, phoneVerified, smsDefault }: { timezone: string; upcoming: Reminder[]; recent: Reminder[]; phoneVerified: boolean; smsDefault: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [date, setDate] = useState(() => addDaysToDate(dateInZone(new Date(), timezone), 1));
  const [time, setTime] = useState("09:00");
  const [sms, setSms] = useState(smsDefault && phoneVerified);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/reminders", { method: "POST", json: { text, dueAt: zonedWallTimeToUtc(date, time, timezone).toISOString(), sms } });
      toast.success("Reminder set");
      setText("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't set the reminder");
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    try {
      await api(`/api/reminders/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't cancel");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><BellRing className="size-4" aria-hidden /> Reminders</CardTitle>
        <CardDescription>
          Shown in your notifications{phoneVerified ? ", and texted to your phone when SMS is ticked." : "."}{" "}
          {!phoneVerified && <Link className="underline underline-offset-2" href="/settings/profile">Verify your mobile number</Link>}
          {!phoneVerified && " to get them by SMS."} Times are in {timezone}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="r-text">Remind me to…</Label>
            <Input id="r-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Send the revised budget" maxLength={300} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="r-date">Date</Label>
            <Input id="r-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="r-time">Time</Label>
            <Input id="r-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm" title={phoneVerified ? "Also text it to your phone" : "Verify your mobile number first"}>
            <input type="checkbox" checked={sms} disabled={!phoneVerified} onChange={(e) => setSms(e.target.checked)} className="size-4" /> SMS
          </label>
          <Button type="submit" disabled={busy || !text.trim()}>{busy && <Loader2 className="animate-spin" aria-hidden />} Add reminder</Button>
        </form>

        {upcoming.length === 0 ? (
          <EmptyState icon={BellRing} title="No upcoming reminders" />
        ) : (
          <ul className="divide-y" aria-label="Upcoming reminders">
            {upcoming.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.text}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTime(r.dueAt, timezone)}
                    {SOURCE[r.source] && ` · ${SOURCE[r.source]}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.sms && <Badge variant="secondary"><MessageSquareText aria-hidden /> SMS</Badge>}
                  <Button size="icon-sm" variant="ghost" aria-label={`Cancel reminder: ${r.text}`} onClick={() => cancel(r.id)}><X /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {recent.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Recently sent ({recent.length})</summary>
            <ul className="mt-2 divide-y text-sm">
              {recent.map((r) => (
                <li key={r.id} className="flex justify-between gap-3 py-2">
                  <span className="min-w-0 truncate">{r.text}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {r.status === "CANCELED" ? "Cancelled" : r.status === "FAILED" ? "Failed" : `Sent ${formatDateTime(r.sentAt ?? r.dueAt, timezone)}`}
                    {r.smsStatus && ` · SMS ${r.smsStatus === "outbox" ? "in dev outbox" : r.smsStatus}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
