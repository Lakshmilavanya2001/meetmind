"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Car, FlaskConical, Loader2, RefreshCw, ShoppingBag, SkipForward, UtensilsCrossed } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { api } from "@/lib/api";

type Ride = { status: string; label: string; driver: string | null; vehicle: string | null };
type Booking = { id: string; kind: string; title: string; reference: string; status: string; total: string | null; when: string | null; sandbox: boolean; uber?: boolean; uberTest?: boolean; ride?: Ride | null; createdAt: string };
const RIDE_OVER = new Set(["completed", "rider_canceled", "driver_canceled", "no_drivers_available"]);
const ICON = { FOOD: ShoppingBag, CAB: Car, TABLE: UtensilsCrossed } as const;

export function BookingsCard({ bookings }: { bookings: Booking[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function ride(b: Booking, action: "refresh" | "advance") {
    setBusy(`${b.id}:${action}`);
    try {
      const r = await api<{ label: string }>(`/api/bookings/${b.id}/ride${action === "advance" ? "/advance" : ""}`, action === "advance" ? { method: "POST" } : undefined);
      toast.success(r.label);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't reach Uber");
    } finally {
      setBusy(null);
    }
  }
  async function cancel(b: Booking) {
    if (!confirm(`Cancel ${b.title}?`)) return;
    try {
      await api(`/api/bookings/${b.id}/cancel`, { method: "POST" });
      toast.success("Cancelled");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't cancel");
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ShoppingBag className="size-4" aria-hidden /> Orders &amp; bookings</CardTitle>
        <CardDescription>
          Made by the assistant after you confirm. Food, tables and non-Uber cabs use a <strong>sandbox</strong> provider: no real order is placed and nothing is charged. Uber rides in <strong>test mode</strong> send no real car either.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {bookings.length === 0 ? (
          <EmptyState icon={ShoppingBag} title="No orders or bookings yet" description="Try asking the assistant: “order two masala dosas to the office” or “book a table for 4 tomorrow at 8 pm”." />
        ) : (
          <ul className="divide-y" aria-label="Orders and bookings">
            {bookings.map((b) => {
              const Icon = ICON[b.kind as keyof typeof ICON] ?? ShoppingBag;
              const canceled = b.status === "CANCELED";
              return (
                <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <p className={canceled ? "truncate font-medium line-through decoration-muted-foreground" : "truncate font-medium"}>{b.title}</p>
                      <p className="text-sm text-muted-foreground">
                        Ref {b.reference}{b.when && ` · ${b.when}`}{b.total && ` · ${b.total}`}
                      </p>
                      {b.ride && (
                        <p className="text-sm">
                          <span className="font-medium">{b.ride.label}</span>
                          {b.ride.driver && ` · ${b.ride.driver}`}{b.ride.vehicle && ` · ${b.ride.vehicle}`}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {b.sandbox && <Badge variant="outline" title="Sandbox — no real order"><FlaskConical aria-hidden /> Sandbox</Badge>}
                    {b.uber && <Badge variant="outline" title={b.uberTest ? "Uber test mode — no real car" : "A real Uber ride"}>{b.uberTest && <FlaskConical aria-hidden />} {b.uberTest ? "Uber test" : "Uber"}</Badge>}
                    {b.ride && !canceled && !RIDE_OVER.has(b.ride.status) && (
                      <>
                        <Button size="icon" variant="ghost" aria-label="Refresh ride status" title="Refresh ride status" disabled={!!busy} onClick={() => ride(b, "refresh")}>
                          {busy === `${b.id}:refresh` ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                        </Button>
                        {b.uberTest && (
                          <Button size="sm" variant="outline" title="Test mode: move the ride to its next stage" disabled={!!busy} onClick={() => ride(b, "advance")}>
                            {busy === `${b.id}:advance` ? <Loader2 className="animate-spin" aria-hidden /> : <SkipForward aria-hidden />} Next stage
                          </Button>
                        )}
                      </>
                    )}
                    {canceled ? <Badge variant="secondary">Cancelled</Badge>
                      : b.ride && (RIDE_OVER.has(b.ride.status) || b.ride.status === "in_progress") ? null
                      : <Button size="sm" variant="ghost" onClick={() => cancel(b)}>Cancel</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
