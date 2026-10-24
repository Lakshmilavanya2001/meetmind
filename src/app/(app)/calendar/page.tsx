import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { requireAuth } from "@/server/auth/current";
import { listMyCalendar } from "@/server/services/calendar";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { ScheduleDialog } from "@/components/meetings/schedule-dialog";
import { addDaysToDate, dateInZone, localClock, zonedWallTimeToUtc } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Calendar" };

/** Monday (YYYY-MM-DD) of the week containing `date`. */
function mondayOf(date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0=Sun
  return addDaysToDate(date, -((weekday + 6) % 7));
}

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const ctx = await requireAuth();
  const tz = ctx.user.timezone;
  const sp = await searchParams;
  const today = dateInZone(new Date(), tz);
  const requested = typeof sp.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : today;
  const monday = mondayOf(requested);
  const days = Array.from({ length: 7 }, (_, i) => addDaysToDate(monday, i));
  const start = zonedWallTimeToUtc(monday, "00:00", tz);
  const end = zonedWallTimeToUtc(addDaysToDate(monday, 7), "00:00", tz);
  const events = await listMyCalendar(ctx, start, end);
  const byDay = new Map(days.map((d) => [d, [] as typeof events]));
  for (const e of events) byDay.get(dateInZone(e.startsAt, tz))?.push(e);

  const fmt = (d: Date) => formatInTimeZone(d, tz, "HH:mm");
  const label = `${formatInTimeZone(start, tz, "d MMM")} – ${formatInTimeZone(new Date(end.getTime() - 1), tz, "d MMM yyyy")}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Calendar"
        description={`Your MeetMind meetings, in ${tz}.`}
        actions={ctx.orgRole !== "GUEST" ? <ScheduleDialog userTimezone={tz} /> : undefined}
      />
      <div className="mb-4 flex items-center gap-2">
        <Button variant="outline" size="icon" asChild>
          <Link href={`/calendar?week=${addDaysToDate(monday, -7)}`} aria-label="Previous week"><ChevronLeft /></Link>
        </Button>
        <Button variant="outline" size="icon" asChild>
          <Link href={`/calendar?week=${addDaysToDate(monday, 7)}`} aria-label="Next week"><ChevronRight /></Link>
        </Button>
        <Button variant="ghost" asChild><Link href="/calendar">Today</Link></Button>
        <h2 className="ml-2 text-sm font-medium" aria-live="polite">{label}</h2>
      </div>
      <div className="grid gap-3 md:grid-cols-7">
        {days.map((d) => {
          const list = byDay.get(d)!;
          const weekend = localClock(zonedWallTimeToUtc(d, "12:00", tz), tz).weekday >= 6;
          return (
            <section key={d} aria-label={formatInTimeZone(zonedWallTimeToUtc(d, "12:00", tz), tz, "EEEE d MMMM")} className={cn("min-h-28 rounded-lg border p-2", weekend && "bg-muted/40", d === today && "border-primary")}>
              <h3 className={cn("mb-2 text-xs font-medium text-muted-foreground", d === today && "text-primary")}>
                {formatInTimeZone(zonedWallTimeToUtc(d, "12:00", tz), tz, "EEE d")}
              </h3>
              {list.length === 0 ? (
                <p className="text-xs text-muted-foreground/70 md:sr-only">No meetings</p>
              ) : (
                <ul className="grid gap-1.5">
                  {list.map((e) => {
                    const canceled = e.status === "CANCELED";
                    return (
                      <li key={e.id}>
                        <Link
                          href={e.meeting ? `/meetings/${e.meeting.joinCode}` : "#"}
                          className={cn(
                            "block rounded-md border-l-4 px-2 py-1.5 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            canceled ? "border-muted-foreground/40 text-muted-foreground line-through" : e.status === "TENTATIVE" ? "border-dashed border-primary/60 bg-primary/5" : "border-primary bg-primary/10",
                          )}
                        >
                          <span className="block font-medium">{fmt(e.startsAt)}–{fmt(e.endsAt)}</span>
                          <span className="block truncate">{e.title}</span>
                          {e.status === "TENTATIVE" && <span className="text-muted-foreground">Not yet accepted</span>}
                          {e.meeting?.status === "LIVE" && <span className="font-medium text-primary">Live now</span>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
