"use client";

import { useRouter } from "next/navigation";
import { Car, FlaskConical, ShoppingBag, UtensilsCrossed } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { api } from "@/lib/api";

type Booking = { id: string; kind: string; title: string; reference: string; status: string; total: string | null; when: string | null; sandbox: boolean; createdAt: string };
const ICON = { FOOD: ShoppingBag, CAB: Car, TABLE: UtensilsCrossed } as const;

export function BookingsCard({ bookings }: { bookings: Booking[] }) {
  const router = useRouter();
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
          Made by the assistant after you confirm. These use a <strong>sandbox</strong> provider: no real order is placed, no cab is sent and nothing is charged.
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
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {b.sandbox && <Badge variant="outline" title="Sandbox — no real order"><FlaskConical aria-hidden /> Sandbox</Badge>}
                    {canceled ? <Badge variant="secondary">Cancelled</Badge> : <Button size="sm" variant="ghost" onClick={() => cancel(b)}>Cancel</Button>}
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
