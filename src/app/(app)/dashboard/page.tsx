import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, History, MailOpen, Users } from "lucide-react";
import { requireAuth } from "@/server/auth/current";
import { db } from "@/server/db";
import { listMyMeetings } from "@/server/services/meetings";
import { listMyPendingInvitations } from "@/server/services/invitations";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ScheduleDialog } from "@/components/meetings/schedule-dialog";
import { DirectoryQuickSearch } from "./quick-search";
import { MeetingActions } from "./meeting-actions";
import { Input } from "@/components/ui/input";
import { RsvpButtons } from "@/components/meetings/meeting-actions";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

function greeting(timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export default async function DashboardPage() {
  const ctx = await requireAuth();
  const tz = ctx.user.timezone;
  const isGuest = ctx.orgRole === "GUEST";
  const [upcoming, recent, invitations, memberCount] = await Promise.all([
    listMyMeetings(ctx, { scope: "upcoming", limit: 6 }),
    listMyMeetings(ctx, { scope: "recent", limit: 5 }),
    listMyPendingInvitations(ctx),
    isGuest ? Promise.resolve(0) : db.organizationMember.count({ where: { organizationId: ctx.organizationId, role: { not: "GUEST" } } }),
  ]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title={`${greeting(tz)}, ${ctx.user.displayName.split(" ")[0]}`} description={`Times are shown in ${tz}.`} />

      {!isGuest && (
        <Card className="mb-6">
          <CardContent className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <MeetingActions />
            <ScheduleDialog userTimezone={tz} />
          </CardContent>
        </Card>
      )}

      {invitations.length > 0 && (
        <Card className="mb-6 border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MailOpen className="size-4 text-primary" aria-hidden /> Invitations awaiting your reply
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {invitations.map((i) => (
                <li key={i.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <Link href={`/meetings/${i.meeting.joinCode}`} className="min-w-0 hover:underline">
                    <p className="truncate font-medium">{i.meeting.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {i.meeting.status === "LIVE" ? "Happening now" : formatDateTime(i.meeting.scheduledStart, tz)}
                      {i.invitedBy ? ` · from ${i.invitedBy.displayName}` : ""}
                    </p>
                  </Link>
                  {i.meeting.status === "LIVE" ? (
                    <Button size="sm" asChild><Link href={`/m/${i.meeting.joinCode}`}>Join now</Link></Button>
                  ) : (
                    <RsvpButtons meetingRef={i.meeting.joinCode} current="PENDING" />
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className={isGuest ? "lg:col-span-3" : "lg:col-span-2"}>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="size-4 text-primary" aria-hidden /> Upcoming meetings
              </CardTitle>
              <CardDescription>Meetings you host or were invited to.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild><Link href="/calendar">Calendar</Link></Button>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <EmptyState icon={CalendarClock} title="No upcoming meetings" description={isGuest ? "Meetings you're invited to will appear here." : "Schedule one above, or ask the assistant once it's available."} />
            ) : (
              <ul className="divide-y">
                {upcoming.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-4 py-3">
                    <Link href={`/meetings/${m.joinCode}`} className="min-w-0 hover:underline">
                      <p className="truncate font-medium">{m.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {m.status === "LIVE" ? "In progress" : formatDateTime(m.scheduledStart, tz)} · {m.host.displayName}
                      </p>
                    </Link>
                    {m.status === "LIVE" ? (
                      <Button size="sm" asChild><Link href={`/m/${m.joinCode}`}>Join</Link></Button>
                    ) : (
                      <Badge variant="secondary">{m._count.participants} {m._count.participants === 1 ? "person" : "people"}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {!isGuest && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="size-4 text-primary" aria-hidden /> Find people
              </CardTitle>
              <CardDescription>{memberCount} {memberCount === 1 ? "member" : "members"} in your workspace.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <DirectoryQuickSearch />
              <Button variant="outline" asChild><Link href="/directory">Open directory</Link></Button>
            </CardContent>
          </Card>
        )}

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Search across previous meetings</CardTitle>
            <CardDescription>Ask what was decided, who said what, or search for a topic. Answers cite the transcript.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/search" className="flex gap-2" role="search">
              <Input name="q" placeholder="e.g. What budget was discussed last week?" aria-label="Search meetings" maxLength={300} />
              <Button type="submit">Search</Button>
            </form>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="size-4 text-primary" aria-hidden /> Recent meetings
              </CardTitle>
              <CardDescription>Your meeting history, newest first.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild><Link href="/meetings?tab=recent">All past meetings</Link></Button>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <EmptyState icon={History} title="No meeting history yet" description="Meetings you join will be listed here." />
            ) : (
              <ul className="divide-y">
                {recent.map((m) => (
                  <li key={m.id}>
                    <Link href={`/meetings/${m.joinCode}`} className="flex items-center justify-between gap-4 py-3 hover:underline">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{m.title}</p>
                        <p className="text-sm text-muted-foreground">{formatDateTime(m.startedAt, tz)}</p>
                      </div>
                      <Badge variant="secondary">ended</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
