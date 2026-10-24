import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "@/server/auth/current";
import { partnerDirectory } from "@/server/services/partners";
import { FoodPortal, PartnerSwitcher } from "@/components/partners/portals";

export const metadata: Metadata = { title: "Restaurant partner portal" };

export default async function FoodPartnerPage({ searchParams }: PageProps<"/partners/food">) {
  const ctx = await requireAuth();
  const sp = await searchParams;
  const dir = partnerDirectory();
  const id = typeof sp.restaurant === "string" && dir.restaurants.some((r) => r.id === sp.restaurant) ? sp.restaurant : "r-slice-republic";
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <Link href="/demos" className="text-sm text-muted-foreground hover:text-foreground">← Demos</Link>
      <p className="text-sm text-muted-foreground">A mock restaurant website showing what it receives when the AI assistant places your order. Orders move through each stage on a sped-up clock. Only your own orders are shown.</p>
      <PartnerSwitcher items={dir.restaurants} current={id} base="/partners/food" />
      <FoodPortal restaurantId={id} tz={ctx.user.timezone} />
    </div>
  );
}
