"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarClock, Copy, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FormField } from "@/components/form-field";
import { PeoplePicker } from "@/components/people-picker";
import { TimeFields, type TimeValue } from "@/components/meetings/time-fields";
import { ConflictList, type ConflictInfo } from "@/components/meetings/conflict-list";
import type { DirectoryUser } from "@/hooks/use-directory-search";
import { api, ApiError } from "@/lib/api";
import { dateInZone, timeInZone, zonedWallTimeToUtc } from "@/lib/time";

const EMAIL_NOTE = { sent: "emailed", not_configured: "notified in-app", failed: "notified in-app (email failed)", skipped: "already invited" } as const;

export function CopyButton({ path }: { path: string }) {
  return (
    <Button
      variant="outline"
      size="lg"
      onClick={() => navigator.clipboard.writeText(`${window.location.origin}${path}`).then(() => toast.success("Meeting link copied"), () => toast.error("Copy failed"))}
    >
      <Copy aria-hidden /> Copy link
    </Button>
  );
}

export function RsvpButtons({ meetingRef, current }: { meetingRef: string; current: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  async function respond(response: "accept" | "decline") {
    setPending(response);
    try {
      await api(`/api/meetings/${meetingRef}/rsvp`, { method: "POST", json: { response } });
      toast.success(response === "accept" ? "Accepted — it's in your calendar" : "Declined");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not respond");
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="flex gap-2">
      <Button size="sm" variant={current === "ACCEPTED" ? "default" : "outline"} disabled={!!pending} onClick={() => respond("accept")} aria-pressed={current === "ACCEPTED"}>
        {pending === "accept" && <Loader2 className="animate-spin" aria-hidden />} Accept
      </Button>
      <Button size="sm" variant={current === "DECLINED" ? "destructive" : "outline"} disabled={!!pending} onClick={() => respond("decline")} aria-pressed={current === "DECLINED"}>
        {pending === "decline" && <Loader2 className="animate-spin" aria-hidden />} Decline
      </Button>
    </div>
  );
}

type InviteResult = { results: { userId: string; displayName: string; email: string; status: string; emailStatus: keyof typeof EMAIL_NOTE }[] };
type EmailInviteResult =
  | { kind: "member"; result: InviteResult["results"][number] }
  | { kind: "external"; email: string; inviteLink: string; emailStatus: "sent" | "not_configured" | "failed" };

export function InviteDialog({ meetingRef, existingIds, trigger }: { meetingRef: string; existingIds: string[]; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [external, setExternal] = useState<Extract<EmailInviteResult, { kind: "external" }> | null>(null);

  async function inviteMembers() {
    setPending(true);
    setError(null);
    try {
      const res = await api<InviteResult>(`/api/meetings/${meetingRef}/invitations`, { method: "POST", json: { userIds: people.map((p) => p.id) } });
      toast.success(res.results.map((r) => `${r.displayName}: ${r.status === "already_invited" ? "already invited" : EMAIL_NOTE[r.emailStatus]}`).join(" · "));
      setPeople([]);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not invite");
    } finally {
      setPending(false);
    }
  }

  async function inviteEmail(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await api<EmailInviteResult>(`/api/meetings/${meetingRef}/invitations`, { method: "POST", json: { email } });
      if (res.kind === "member") {
        toast.success(`${res.result.displayName} is a workspace member and was invited`);
        setOpen(false);
      } else {
        setExternal(res);
      }
      setEmail("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not invite");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setError(null); setExternal(null); } }}>
      <DialogTrigger asChild>
        {trigger ?? <Button variant="outline" size="sm"><UserPlus aria-hidden /> Invite</Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          <DialogDescription>Invited people are notified and can join with the meeting link.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {external ? (
          <div className="grid gap-3 text-sm">
            <p>
              {external.emailStatus === "sent"
                ? <>An invitation was emailed to <strong>{external.email}</strong>.</>
                : <>The invitation for <strong>{external.email}</strong> was created, but <strong>it was not emailed</strong> ({external.emailStatus === "not_configured" ? "email isn't configured on this server" : "the email could not be sent"}). Share this personal link with them:</>}
            </p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{external.inviteLink}</span>
              <Button size="icon-sm" variant="ghost" aria-label="Copy invitation link" onClick={() => navigator.clipboard.writeText(external.inviteLink).then(() => toast.success("Link copied"))}><Copy /></Button>
            </div>
            <p className="text-xs text-muted-foreground">They&apos;ll join as a guest who can only see this meeting.</p>
            <DialogFooter><Button onClick={() => setOpen(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <Tabs defaultValue="members">
            <TabsList className="w-full">
              <TabsTrigger value="members">Workspace members</TabsTrigger>
              <TabsTrigger value="email">By email</TabsTrigger>
            </TabsList>
            <TabsContent value="members" className="grid gap-3 pt-2">
              <PeoplePicker id="invite-people" selected={people} onChange={setPeople} excludeIds={existingIds} />
              <DialogFooter>
                <Button onClick={inviteMembers} disabled={pending || people.length === 0}>
                  {pending && <Loader2 className="animate-spin" aria-hidden />} Invite {people.length > 0 ? people.length : ""}
                </Button>
              </DialogFooter>
            </TabsContent>
            <TabsContent value="email" className="pt-2">
              <form onSubmit={inviteEmail} className="grid gap-3">
                <FormField id="invite-email" label="Email address" hint="People outside your workspace need external invitations enabled by an admin.">
                  <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </FormField>
                <DialogFooter>
                  <Button type="submit" disabled={pending || !email}>
                    {pending && <Loader2 className="animate-spin" aria-hidden />} Send invitation
                  </Button>
                </DialogFooter>
              </form>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RescheduleDialog({ meetingRef, start, end, timezone }: { meetingRef: string; start: string; end: string; timezone: string }) {
  const router = useRouter();
  const initial = (): TimeValue => ({
    date: dateInZone(new Date(start), timezone),
    time: timeInZone(new Date(start), timezone),
    duration: Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000),
    timezone,
  });
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState<TimeValue>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<ConflictInfo[] | null>(null);

  async function submit(allowConflicts: boolean) {
    setPending(true);
    setError(null);
    setErrors({});
    try {
      const s = zonedWallTimeToUtc(when.date, when.time, when.timezone);
      await api(`/api/meetings/${meetingRef}/reschedule`, {
        method: "POST",
        json: { startTime: s.toISOString(), endTime: new Date(s.getTime() + when.duration * 60_000).toISOString(), allowConflicts },
      });
      toast.success("Meeting moved. Participants were notified.");
      setOpen(false);
      setConflicts(null);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT" && err.details) setConflicts((err.details as { conflicts: ConflictInfo[] }).conflicts);
      else if (err instanceof ApiError) {
        setError(err.message);
        setErrors(err.fields ?? {});
      } else setError("Could not reschedule");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setWhen(initial()); setConflicts(null); setError(null); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><CalendarClock aria-hidden /> Reschedule</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reschedule meeting</DialogTitle>
          <DialogDescription>Everyone invited will be notified of the new time.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <TimeFields value={when} onChange={(v) => { setWhen(v); setConflicts(null); }} errors={errors} />
        {conflicts && <ConflictList conflicts={conflicts} timezone={when.timezone} />}
        <DialogFooter>
          {conflicts ? (
            <Button onClick={() => submit(true)} disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} Move anyway</Button>
          ) : (
            <Button onClick={() => submit(false)} disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} Save new time</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelMeetingButton({ meetingRef, title }: { meetingRef: string; title: string }) {
  const router = useRouter();
  async function cancel() {
    try {
      await api(`/api/meetings/${meetingRef}/cancel`, { method: "POST" });
      toast.success("Meeting cancelled. Participants were notified.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel");
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">Cancel meeting</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel “{title}”?</AlertDialogTitle>
          <AlertDialogDescription>Everyone invited will be notified and it will be removed from their calendars. This can&apos;t be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep meeting</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={cancel}>Cancel meeting</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
