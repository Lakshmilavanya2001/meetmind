import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "@/server/auth/current";
import { partnerDirectory } from "@/server/services/partners";
import { CinemaPortal, PartnerSwitcher } from "@/components/partners/portals";

export const metadata: Metadata = { title: "Cinema partner portal" };

export default async function CinemaPartnerPage({ searchParams }: PageProps<"/partners/cinema">) {
  const ctx = await requireAuth();
  const sp = await searchParams;
  const dir = partnerDirectory();
  const id = typeof sp.cinema === "string" && dir.cinemas.some((c) => c.id === sp.cinema) ? sp.cinema : "cn-galaxy-kor";
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <Link href="/demos" className="text-sm text-muted-foreground hover:text-foreground">← Demos</Link>
      <p className="text-sm text-muted-foreground">A mock cinema box office showing what it receives when the AI assistant books your tickets. Only your own bookings are shown.</p>
      <PartnerSwitcher items={dir.cinemas} current={id} base="/partners/cinema" />
      <CinemaPortal cinemaId={id} tz={ctx.user.timezone} />
    </div>
  );
}
