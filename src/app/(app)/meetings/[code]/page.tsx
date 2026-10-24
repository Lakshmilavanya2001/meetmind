import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarClock, Check, Clock, HelpCircle, Mail, X } from "lucide-react";
import { requireAuth } from "@/server/auth/current";
import { getMeetingDetails } from "@/server/services/meetings";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatRangeInZone } from "@/lib/time";
import { formatDateTime } from "@/lib/format";
import { getLatencyReport } from "@/server/services/interpretation";
import { LatencyCard } from "@/components/meetings/latency-card";
import { CopyButton, RsvpButtons, InviteDialog, RescheduleDialog, CancelMeetingButton } from "@/components/meetings/meeting-actions";

export const metadata: Metadata = { title: "Meeting" };

const RSVP = {
  ACCEPTED: { label: "Accepted", icon: Check, cls: "text-emerald-600" },
  DECLINED: { label: "Declined", icon: X, cls: "text-destructive" },
  PENDING: { label: "Awaiting reply", icon: HelpCircle, cls: "text-muted-foreground" },
  REVOKED: { label: "Withdrawn", icon: X, cls: "text-muted-foreground" },
  EXPIRED: { label: "Expired", icon: Clock, cls: "text-muted-foreground" },
} as const;

export default async function MeetingDetailPage({ params }: PageProps<"/meetings/[code]">) {
  const ctx = await requireAuth();
  const { code } = await params;
  let d;
  try {
    d = await getMeetingDetails(ctx, code);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    if (isAppError(err)) {
      return (
        <Alert variant="destructive" className="mx-auto max-w-lg">
          <AlertDescription>{err.message}</AlertDescription>
        </Alert>
      );
    }
    throw err;
  }
  const { meeting: m, myRole } = d;
  // Only people who were in the meeting can see its interpreter report.
  const latency = await getLatencyReport(ctx, code).catch(() => null);
  const tz = ctx.user.timezone;
  const isModerator = myRole === "HOST" || myRole === "COHOST";
  const canJoin = m.status !== "CANCELED";
  const scheduled = m.scheduledStart && m.scheduledEnd;

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
            {m.status === "LIVE" && <Badge>Live now</Badge>}
            {m.status === "CANCELED" && <Badge variant="destructive">Cancelled</Badge>}
            {m.status === "ENDED" && <Badge variant="secondary">Ended</Badge>}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <CalendarClock className="size-4" aria-hidden />
            {scheduled ? formatRangeInZone(m.scheduledStart!, m.scheduledEnd!, tz) : m.startedAt ? `Started ${formatDateTime(m.startedAt, tz)}` : "Instant meeting"}
          </p>
          <p className="text-sm text-muted-foreground">Hosted by {m.host.displayName}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canJoin && (
            <Button asChild size="lg">
              <Link href={`/m/${m.joinCode}`}>{m.status === "LIVE" ? "Join now" : "Join"}</Link>
            </Button>
          )}
          <CopyButton path={`/m/${m.joinCode}`} />
          <Button variant="outline" size="lg" asChild>
            <Link href={`/meetings/${m.joinCode}/transcript`}>Transcript & summary</Link>
          </Button>
        </div>
      </div>

      {d.myInvitationStatus && myRole !== "HOST" && m.status === "SCHEDULED" && (
        <Card>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              {d.myInvitationStatus === "PENDING" ? "You're invited. Will you attend?" : `You ${d.myInvitationStatus === "ACCEPTED" ? "accepted" : "declined"} this invitation.`}
            </p>
            <RsvpButtons meetingRef={m.joinCode} current={d.myInvitationStatus} />
          </CardContent>
        </Card>
      )}

      {m.description && (
        <Card>
          <CardContent className="text-sm whitespace-pre-wrap">{m.description}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">People</CardTitle>
            <CardDescription>Meeting code <span className="font-mono">{m.joinCode}</span></CardDescription>
          </div>
          {isModerator && m.status !== "CANCELED" && m.status !== "ENDED" && (
            <div className="flex flex-wrap justify-end gap-2">
              <InviteDialog meetingRef={m.joinCode} existingIds={d.participants.map((p) => p.userId)} />
              {m.status === "SCHEDULED" && scheduled && (
                <RescheduleDialog meetingRef={m.joinCode} start={m.scheduledStart!.toISOString()} end={m.scheduledEnd!.toISOString()} timezone={tz} />
              )}
              {myRole === "HOST" && m.status === "SCHEDULED" && <CancelMeetingButton meetingRef={m.joinCode} title={m.title} />}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {d.participants.map((p) => {
              const r = p.rsvp ? RSVP[p.rsvp] : null;
              return (
                <li key={p.userId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {p.displayName}
                      {p.role !== "ATTENDEE" && <span className="ml-2 text-xs font-normal text-muted-foreground">{p.role === "HOST" ? "Host" : "Co-host"}</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{p.email}</p>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    {p.attended && <Badge variant="secondary">Attended</Badge>}
                    {r && (
                      <span className={`flex items-center gap-1 ${r.cls}`}>
                        <r.icon className="size-3.5" aria-hidden /> {r.label}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
            {d.externalInvites.map((e) => (
              <li key={e.email} className="flex items-center justify-between gap-3 py-2.5">
                <p className="flex items-center gap-2 text-sm"><Mail className="size-4 text-muted-foreground" aria-hidden /> {e.email}</p>
                <span className="text-xs text-muted-foreground">Invited by email · not joined yet</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {latency && <LatencyCard report={latency} />}
    </div>
  );
}
