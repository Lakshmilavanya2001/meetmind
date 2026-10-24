"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Clapperboard, FlaskConical, Pizza, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Stage = { name: string; at: string | null; done: boolean };
const time = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });

function usePoll<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<T>(url));
    } catch {
      /* keep */
    }
  }, [url]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    const i = setInterval(load, 4000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [load]);
  return data;
}

function Timeline({ stages, tz }: { stages: Stage[]; tz: string }) {
  return (
    <ol className="grid gap-1.5" aria-label="Order progress">
      {stages.map((s) => (
        <li key={s.name} className={cn("flex items-center gap-2 text-sm", !s.done && "text-muted-foreground")}>
          {s.name.startsWith("Cancelled") ? <XCircle className="size-4 text-destructive" aria-hidden /> : s.done ? <CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> : <Circle className="size-4" aria-hidden />}
          <span className="flex-1">{s.name}</span>
          {s.at && <span className="text-xs tabular-nums text-muted-foreground">{time(s.at, tz)}</span>}
        </li>
      ))}
    </ol>
  );
}

function PortalHeader({ icon: Icon, name, sub, color }: { icon: typeof Pizza; name: string; sub: string; color: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 rounded-xl px-5 py-4 text-white", color)}>
      <div className="flex items-center gap-3">
        <Icon className="size-7" aria-hidden />
        <div>
          <p className="text-lg font-semibold">{name}</p>
          <p className="text-sm text-white/80">{sub}</p>
        </div>
      </div>
      <Badge className="bg-white/20 text-white"><FlaskConical aria-hidden /> Sandbox partner portal</Badge>
    </div>
  );
}

type FoodData = { restaurant: { id: string; name: string; area: string }; orders: { id: string; reference: string; receivedAt: string; status: string; items: { name: string; quantity: number; total: string }[]; address: string; notes: string | null; subtotal: string; delivery: string; taxes: string; total: string; stages: Stage[] }[] };

export function FoodPortal({ restaurantId, tz }: { restaurantId: string; tz: string }) {
  const d = usePoll<FoodData>(`/api/partners/food?restaurant=${encodeURIComponent(restaurantId)}`);
  if (!d) return null;
  return (
    <div className="grid gap-4">
      <PortalHeader icon={Pizza} name={`${d.restaurant.name} · Orders`} sub={`${d.restaurant.area} kitchen — orders sent by the MeetMind assistant`} color="bg-gradient-to-r from-orange-600 to-red-600" />
      {d.orders.length === 0 ? (
        <EmptyState icon={Pizza} title="No orders yet" description="Ask the assistant to order from this restaurant; the order appears here the moment you confirm it." />
      ) : (
        <ul className="grid gap-3" aria-label="Incoming orders">
          {d.orders.map((o) => (
            <li key={o.id}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">Order {o.reference}</CardTitle>
                    <CardDescription>Received {time(o.receivedAt, tz)} · deliver to {o.address}{o.notes ? ` · “${o.notes}”` : ""}</CardDescription>
                  </div>
                  <span className="text-lg font-semibold tabular-nums">{o.total}</span>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                  <table className="w-full text-sm" aria-label={`Items in ${o.reference}`}>
                    <tbody>
                      {o.items.map((i) => <tr key={i.name} className="border-b last:border-0"><td className="py-1">{i.quantity} ×</td><td>{i.name}</td><td className="text-right tabular-nums">{i.total}</td></tr>)}
                      <tr className="text-muted-foreground"><td /><td className="pt-2">Delivery · taxes</td><td className="pt-2 text-right tabular-nums">{o.delivery} · {o.taxes}</td></tr>
                    </tbody>
                  </table>
                  <Timeline stages={o.stages} tz={tz} />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type CinemaData = { cinema: { id: string; name: string; area: string }; bookings: { id: string; reference: string; receivedAt: string; status: string; film: string; language: string; certificate: string; when: string; seats: string[]; tickets: string; fees: string; total: string; hall: ("mine" | "sold" | "free")[][]; stages: Stage[] }[] };

export function CinemaPortal({ cinemaId, tz }: { cinemaId: string; tz: string }) {
  const d = usePoll<CinemaData>(`/api/partners/cinema?cinema=${encodeURIComponent(cinemaId)}`);
  if (!d) return null;
  return (
    <div className="grid gap-4">
      <PortalHeader icon={Clapperboard} name={`${d.cinema.name} · Box office`} sub={`${d.cinema.area} — bookings sent by the MeetMind assistant`} color="bg-gradient-to-r from-indigo-700 to-fuchsia-700" />
      {d.bookings.length === 0 ? (
        <EmptyState icon={Clapperboard} title="No bookings yet" description="Ask the assistant to book tickets at this cinema; the booking appears here the moment you confirm it." />
      ) : (
        <ul className="grid gap-3" aria-label="Bookings">
          {d.bookings.map((b) => (
            <li key={b.id}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{b.film} <span className="text-sm font-normal text-muted-foreground">({b.language}, {b.certificate})</span></CardTitle>
                    <CardDescription>Ticket code <span className="font-mono">{b.reference}</span> · {b.when} · seats {b.seats.join(", ")}</CardDescription>
                  </div>
                  <span className="text-lg font-semibold tabular-nums">{b.total}</span>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-[auto_1fr]">
                  <figure className="grid gap-1" aria-label={`Seats for ${b.reference}`}>
                    <div className="mb-1 h-1.5 rounded bg-muted-foreground/40" title="Screen" />
                    {b.hall.map((row, r) => (
                      <div key={r} className="flex gap-0.5">
                        <span className="w-3 text-[9px] text-muted-foreground">{"ABCDEFGHIJ"[r]}</span>
                        {row.map((s, i) => <span key={i} className={cn("size-3 rounded-[3px]", s === "mine" ? "bg-fuchsia-600" : s === "sold" ? "bg-muted-foreground/30" : "border border-muted-foreground/40")} />)}
                      </div>
                    ))}
                    <figcaption className="mt-1 text-[11px] text-muted-foreground">Screen at the top · <span className="text-fuchsia-600">■</span> this booking · ■ sold</figcaption>
                  </figure>
                  <div className="grid content-start gap-3">
                    <p className="text-sm text-muted-foreground">Tickets {b.tickets} · fees {b.fees}</p>
                    <Timeline stages={b.stages} tz={tz} />
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PartnerSwitcher({ items, current, base }: { items: { id: string; name: string }[]; current: string; base: string }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Partners">
      {items.map((i) => (
        <Link key={i.id} href={`${base}?${base.endsWith("food") ? "restaurant" : "cinema"}=${i.id}`} aria-current={i.id === current ? "page" : undefined} className={cn("rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted", i.id === current && "bg-muted font-medium text-foreground")}>
          {i.name}
        </Link>
      ))}
    </nav>
  );
}
