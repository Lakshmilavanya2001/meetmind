export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** Format an instant in the viewer's configured time zone. */
export function formatDateTime(date: Date | string | null | undefined, timeZone: string, opts?: Intl.DateTimeFormatOptions) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
    ...opts,
  }).format(new Date(date));
}

export function formatDuration(ms: number) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${m}m` : `${m} min`;
}
