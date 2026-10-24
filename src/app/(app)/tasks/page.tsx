import type { Metadata } from "next";
import { requireAuth } from "@/server/auth/current";
import { listReminders } from "@/server/services/reminders";
import { listBookings } from "@/server/services/bookings";
import { getProfile } from "@/server/services/profile";
import { canTextUser } from "@/server/services/sms";
import { PageHeader } from "@/components/common/page-header";
import { RemindersCard } from "@/components/tasks/reminders";
import { BookingsCard } from "@/components/tasks/bookings";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage() {
  const ctx = await requireAuth();
  const [upcoming, all, bookings, profile] = await Promise.all([
    listReminders(ctx),
    listReminders(ctx, { include: "all" }),
    ctx.orgRole === "GUEST" ? Promise.resolve([]) : listBookings(ctx),
    getProfile(ctx),
  ]);
  const recent = all.filter((r) => r.status !== "PENDING" && r.status !== "SENDING").slice(0, 10);
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <PageHeader title="Tasks" description="Reminders, plus food orders, cabs and tables booked through the assistant. Ask it things like “remind me at 5 to call Priya” or “book a cab to the airport”." />
      <RemindersCard
        timezone={ctx.user.timezone}
        upcoming={upcoming.map((r) => ({ ...r, dueAt: r.dueAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null }))}
        recent={recent.map((r) => ({ ...r, dueAt: r.dueAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null }))}
        phoneVerified={canTextUser(profile)}
        smsDefault={profile.smsReminders}
      />
      {ctx.orgRole !== "GUEST" && <BookingsCard bookings={bookings.map((b) => ({ id: b.id, kind: b.kind, title: b.title, reference: b.reference, status: b.status, total: b.total, when: b.when, sandbox: b.sandbox, createdAt: b.createdAt.toISOString() }))} />}
    </div>
  );
}
