import "server-only";
import * as chrono from "chrono-node";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { zonedWallTimeToUtc } from "@/lib/time";

const pad = (n: number) => String(n).padStart(2, "0");

export type ParsedDateTime =
  | {
      ok: true;
      start: string; // ISO instant (UTC)
      end: string | null;
      startLocal: string; // human readable in the zone
      endLocal: string | null;
      timeSpecified: boolean;
      durationMinutes: number | null;
      timezone: string;
      matchedText: string;
    }
  | { ok: false; reason: string };

/**
 * Parse phrases like "tomorrow at 3 PM for 30 minutes" relative to `now` in the user's time zone.
 * Deterministic (no LLM date arithmetic). Wall-clock results are converted to UTC with DST awareness.
 */
export function parseNaturalDateTime(text: string, timezone: string, now = new Date()): ParsedDateTime {
  // chrono works on wall-clock time: give it "now" as the zone's wall clock expressed in UTC fields.
  const wall = toZonedTime(now, timezone);
  const wallAsUtc = new Date(Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes()));
  const results = chrono.parse(text, { instant: wallAsUtc, timezone: "UTC" }, { forwardDate: true });
  if (results.length === 0) return { ok: false, reason: `Could not find a date or time in "${text}".` };
  const r = results[0];

  const toInstant = (c: chrono.ParsedComponents) => {
    const date = `${c.get("year")}-${pad(c.get("month")!)}-${pad(c.get("day")!)}`;
    const time = `${pad(c.get("hour") ?? 0)}:${pad(c.get("minute") ?? 0)}`;
    return zonedWallTimeToUtc(date, time, timezone);
  };
  const timeSpecified = r.start.isCertain("hour");
  const start = toInstant(r.start);

  let end: Date | null = r.end ? toInstant(r.end) : null;
  const dur = /\bfor\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b/i.exec(text) ?? /\b(\d+(?:\.\d+)?)\s*-?\s*(minutes?|mins?|hours?|hrs?)\s+(?:long|meeting|call)\b/i.exec(text);
  let durationMinutes: number | null = null;
  if (dur) {
    durationMinutes = Math.round(Number(dur[1]) * (/^h/i.test(dur[2]) ? 60 : 1));
    if (!end) end = new Date(start.getTime() + durationMinutes * 60_000);
  } else if (end) {
    durationMinutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  }

  const fmt = (d: Date) => formatInTimeZone(d, timezone, "EEEE d MMMM yyyy, HH:mm (zzz)");
  return {
    ok: true,
    start: start.toISOString(),
    end: end?.toISOString() ?? null,
    startLocal: timeSpecified ? fmt(start) : formatInTimeZone(start, timezone, "EEEE d MMMM yyyy") + " (no time given)",
    endLocal: end ? fmt(end) : null,
    timeSpecified,
    durationMinutes,
    timezone,
    matchedText: r.text,
  };
}
