import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

// All instants are stored in UTC. Wall-clock times are always interpreted in an explicit IANA zone.

/** "2026-10-10" + "15:00" in "Asia/Kolkata" → the UTC instant. DST gaps/overlaps follow date-fns-tz rules. */
export function zonedWallTimeToUtc(date: string, time: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Expected date YYYY-MM-DD and time HH:mm");
  }
  return fromZonedTime(`${date}T${time}:00`, timeZone);
}

/** The calendar date (YYYY-MM-DD) of an instant in a zone. */
export const dateInZone = (instant: Date, timeZone: string) => formatInTimeZone(instant, timeZone, "yyyy-MM-dd");

/** Wall-clock HH:mm of an instant in a zone. */
export const timeInZone = (instant: Date, timeZone: string) => formatInTimeZone(instant, timeZone, "HH:mm");

/** Minutes since local midnight and ISO weekday (1=Mon … 7=Sun) of an instant in a zone. */
export function localClock(instant: Date, timeZone: string) {
  const z = toZonedTime(instant, timeZone);
  return { minutes: z.getHours() * 60 + z.getMinutes(), weekday: ((z.getDay() + 6) % 7) + 1 };
}

/** Start of the local day containing `instant`, as a UTC instant. */
export const startOfDayInZone = (instant: Date, timeZone: string) => zonedWallTimeToUtc(dateInZone(instant, timeZone), "00:00", timeZone);

/** Add whole calendar days to a YYYY-MM-DD string. */
export function addDaysToDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

export function formatRangeInZone(start: Date, end: Date, timeZone: string) {
  const sameDay = dateInZone(start, timeZone) === dateInZone(end, timeZone);
  const day = formatInTimeZone(start, timeZone, "EEE, d MMM yyyy");
  const s = formatInTimeZone(start, timeZone, "HH:mm");
  const e = formatInTimeZone(end, timeZone, sameDay ? "HH:mm" : "EEE d MMM HH:mm");
  return `${day}, ${s}–${e} (${timeZone})`;
}
