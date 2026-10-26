/**
 * "Open in Uber": a universal link that opens the Uber app (or m.uber.com) with the pickup and drop-off filled in.
 * The rider sees Uber's real prices and confirms the ride in Uber; nothing is booked or paid from MeetMind, so no
 * Uber API access is needed. Coordinates make Uber place the pins exactly; without them only the address text is passed.
 */
export type LinkPlace = { address: string; lat?: number; lng?: number };

export const UBER_LINK_HOST = "m.uber.com";

export function uberRideLink(pickup: LinkPlace, drop: LinkPlace, clientId?: string): string {
  const q = new URLSearchParams({ action: "setPickup" });
  if (clientId) q.set("client_id", clientId);
  const put = (side: "pickup" | "dropoff", p: LinkPlace) => {
    if (p.lat !== undefined && p.lng !== undefined) {
      q.set(`${side}[latitude]`, p.lat.toFixed(6));
      q.set(`${side}[longitude]`, p.lng.toFixed(6));
    }
    q.set(`${side}[nickname]`, p.address);
    q.set(`${side}[formatted_address]`, p.address);
  };
  put("pickup", pickup);
  put("dropoff", drop);
  return `https://${UBER_LINK_HOST}/ul/?${q}`;
}

/** Links the assistant may show: pages in this app, or an Uber ride link. Anything else is dropped. */
export function classifyResultLink(link: string | undefined | null): "internal" | "uber" | null {
  if (!link) return null;
  if (link.startsWith("/") && !link.startsWith("//")) return "internal";
  try {
    const u = new URL(link);
    return u.protocol === "https:" && u.hostname === UBER_LINK_HOST ? "uber" : null;
  } catch {
    return null;
  }
}
