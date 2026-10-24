"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarPlus, CheckCircle2, Copy, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FormField } from "@/components/form-field";
import { PeoplePicker } from "@/components/people-picker";
import type { DirectoryUser } from "@/hooks/use-directory-search";
import { api, ApiError } from "@/lib/api";
import { addDaysToDate, dateInZone, formatRangeInZone, timeInZone, zonedWallTimeToUtc } from "@/lib/time";
import { TimeFields, type TimeValue } from "./time-fields";
import { ConflictList, type ConflictInfo } from "./conflict-list";

type Result = {
  meeting: { joinCode: string; title: string; scheduledStart: string; scheduledEnd: string; timezone: string };
  invited: { userId: string; displayName: string; email: string; emailStatus: "sent" | "not_configured" | "failed" }[];
};

type Slot = { start: string; end: string };

function defaultTime(timezone: string): TimeValue {
  // Next half hour, tomorrow if it's late.
  const now = new Date(Date.now() + 30 * 60_000);
  now.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
  return { date: dateInZone(now, timezone), time: timeInZone(now, timezone), duration: 30, timezone };
}

const EMAIL_NOTE: Record<Result["invited"][number]["emailStatus"], string> = {
  sent: "emailed",
  not_configured: "notified in-app (email not configured)",
  failed: "notified in-app (email failed)",
};

export function ScheduleDialog({ userTimezone, trigger }: { userTimezone: string; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [when, setWhen] = useState<TimeValue>(() => defaultTime(userTimezone));
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictInfo[] | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [findingSlots, setFindingSlots] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  function reset() {
    setTitle("");
    setDescription("");
    setWhen(defaultTime(userTimezone));
    setPeople([]);
    setErrors({});
    setError(null);
    setConflicts(null);
    setSlots(null);
    setResult(null);
  }

  function instants() {
    const start = zonedWallTimeToUtc(when.date, when.time, when.timezone);
    return { start, end: new Date(start.getTime() + when.duration * 60_000) };
  }

  async function submit(allowConflicts = false) {
    setPending(true);
    setErrors({});
    setError(null);
    try {
      const { start, end } = instants();
      const res = await api<Result>("/api/meetings/schedule", {
        method: "POST",
        json: {
          title,
          description: description || undefined,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          timezone: when.timezone,
          participantIds: people.map((p) => p.id),
          allowConflicts,
        },
      });
      setResult(res);
      setConflicts(null);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT") {
        setConflicts((err.details as { conflicts: ConflictInfo[] }).conflicts);
      } else if (err instanceof ApiError) {
        setError(err.message);
        setErrors(err.fields ?? {});
      } else setError(err instanceof Error ? err.message : "Could not schedule the meeting");
    } finally {
      setPending(false);
    }
  }

  async function findTime() {
    setFindingSlots(true);
    setSlots(null);
    try {
      const rangeStart = zonedWallTimeToUtc(when.date, "00:00", when.timezone);
      const rangeEnd = zonedWallTimeToUtc(addDaysToDate(when.date, 7), "00:00", when.timezone);
      const res = await api<{ slots: Slot[] }>("/api/calendar/free-slots", {
        method: "POST",
        json: { userIds: people.map((p) => p.id), rangeStart: rangeStart.toISOString(), rangeEnd: rangeEnd.toISOString(), durationMinutes: when.duration, limit: 6 },
      });
      setSlots(res.slots);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not check availability");
    } finally {
      setFindingSlots(false);
    }
  }

  const link = result && typeof window !== "undefined" ? `${window.location.origin}/m/${result.meeting.joinCode}` : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="lg" variant="outline">
            <CalendarPlus aria-hidden /> Schedule
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> Meeting scheduled
              </DialogTitle>
              <DialogDescription>
                {result.meeting.title} · {formatRangeInZone(new Date(result.meeting.scheduledStart), new Date(result.meeting.scheduledEnd), result.meeting.timezone)}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
                <Button size="icon-sm" variant="ghost" aria-label="Copy meeting link" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Link copied"))}>
                  <Copy />
                </Button>
              </div>
              {result.invited.length > 0 ? (
                <ul className="grid gap-1">
                  {result.invited.map((i) => (
                    <li key={i.userId}>
                      <span className="font-medium">{i.displayName}</span> <span className="text-muted-foreground">({i.email}) — {EMAIL_NOTE[i.emailStatus]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No one else was invited. Share the link or invite people from the meeting page.</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>Schedule another</Button>
              <Button asChild><Link href={`/meetings/${result.meeting.joinCode}`}>Open meeting</Link></Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(false);
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>Schedule a meeting</DialogTitle>
              <DialogDescription>Invitees get an in-app notification and the meeting appears in their calendar.</DialogDescription>
            </DialogHeader>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <FormField id="m-title" label="Title" error={errors.title}>
              <Input id="m-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project review" required autoFocus />
            </FormField>
            <TimeFields value={when} onChange={(v) => { setWhen(v); setConflicts(null); }} errors={errors} />
            <div className="grid gap-1.5">
              <label htmlFor="m-people" className="text-sm font-medium">Participants</label>
              <PeoplePicker id="m-people" selected={people} onChange={(p) => { setPeople(p); setConflicts(null); setSlots(null); }} />
            </div>
            <div>
              <Button type="button" variant="ghost" size="sm" onClick={findTime} disabled={findingSlots || !when.date}>
                {findingSlots ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />} Find a time everyone is free
              </Button>
              {slots && (
                <div className="mt-2 grid gap-2">
                  {slots.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No common free slot in the 7 days from the chosen date (09:00–18:00 local, Mon–Fri).</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {slots.map((s) => (
                        <Button
                          key={s.start}
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const d = new Date(s.start);
                            setWhen({ ...when, date: dateInZone(d, when.timezone), time: timeInZone(d, when.timezone) });
                            setConflicts(null);
                          }}
                        >
                          {new Intl.DateTimeFormat("en-GB", { timeZone: when.timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(s.start))}
                        </Button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">Based on MeetMind&apos;s calendar only — external calendars aren&apos;t connected.</p>
                </div>
              )}
            </div>
            <FormField id="m-desc" label="Description (optional)" error={errors.description}>
              <Textarea id="m-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </FormField>
            {conflicts && <ConflictList conflicts={conflicts} timezone={when.timezone} />}
            <DialogFooter>
              {conflicts ? (
                <>
                  <Button type="button" variant="outline" onClick={() => setConflicts(null)}>Change time</Button>
                  <Button type="button" onClick={() => submit(true)} disabled={pending}>
                    {pending && <Loader2 className="animate-spin" aria-hidden />} Schedule anyway
                  </Button>
                </>
              ) : (
                <Button type="submit" disabled={pending || !title.trim()}>
                  {pending && <Loader2 className="animate-spin" aria-hidden />} Schedule
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
