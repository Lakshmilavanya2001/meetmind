import type { Metadata } from "next";
import Link from "next/link";
import { CalendarX2, History, Search, Video } from "lucide-react";
import { requireAuth } from "@/server/auth/current";
import { listMyMeetings } from "@/server/services/meetings";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ScheduleDialog } from "@/components/meetings/schedule-dialog";
import { SampleCallButton } from "@/components/meetings/sample-call-button";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Meetings" };

const TABS = [
  { key: "upcoming", label: "Upcoming", icon: Video },
  { key: "recent", label: "Past", icon: History },
  { key: "canceled", label: "Cancelled", icon: CalendarX2 },
] as const;

export default async function MeetingsPage({ searchParams }: PageProps<"/meetings">) {
  const ctx = await requireAuth();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "upcoming";
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const meetings = await listMyMeetings(ctx, { scope: tab, limit: 50, q: q || undefined });
  const tz = ctx.user.timezone;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Meetings"
        description="Meetings you host or were invited to."
        actions={ctx.orgRole !== "GUEST" ? <><SampleCallButton /><ScheduleDialog userTimezone={tz} /></> : undefined}
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav className="flex gap-1 rounded-lg bg-muted p-1" aria-label="Meeting lists">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={{ pathname: "/meetings", query: { tab: t.key, ...(q ? { q } : {}) } }}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground", tab === t.key && "bg-background text-foreground shadow-sm")}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <form className="relative sm:w-72" role="search">
          <input type="hidden" name="tab" value={tab} />
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input name="q" defaultValue={q} placeholder="Search by title" className="pl-8" aria-label="Search meetings by title" />
        </form>
      </div>
      <Card>
        <CardContent>
          {meetings.length === 0 ? (
            <EmptyState
              icon={TABS.find((t) => t.key === tab)!.icon}
              title={q ? `No meetings match “${q}”` : tab === "upcoming" ? "Nothing scheduled" : tab === "recent" ? "No past meetings yet" : "No cancelled meetings"}
            />
          ) : (
            <ul className="divide-y">
              {meetings.map((m) => (
                <li key={m.id}>
                  <Link href={`/meetings/${m.joinCode}`} className="flex items-center justify-between gap-4 rounded-md px-2 py-3 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none">
                    <div className="min-w-0">
                      <p className={cn("truncate font-medium", m.status === "CANCELED" && "line-through decoration-muted-foreground")}>{m.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatDateTime(m.scheduledStart ?? m.startedAt, tz)} · {m.host.displayName} · {m._count.participants} {m._count.participants === 1 ? "person" : "people"}
                      </p>
                    </div>
                    {m.status === "LIVE" ? <Badge>Live now</Badge> : m.status === "CANCELED" ? <Badge variant="outline">Cancelled</Badge> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {tab === "upcoming" && ctx.orgRole !== "GUEST" && (
        <p className="mt-3 text-sm text-muted-foreground">
          Need to talk now? <Button variant="link" className="h-auto p-0" asChild><Link href="/dashboard">Start an instant meeting</Link></Button>
        </p>
      )}
    </div>
  );
}
