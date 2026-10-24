import { describe, expect, it } from "vitest";
import { addDaysToDate, dateInZone, formatRangeInZone, localClock, overlaps, startOfDayInZone, zonedWallTimeToUtc } from "@/lib/time";

describe("time zones", () => {
  it("converts wall-clock time in a zone to UTC", () => {
    expect(zonedWallTimeToUtc("2026-10-10", "15:00", "Asia/Kolkata").toISOString()).toBe("2026-10-10T09:30:00.000Z");
    expect(zonedWallTimeToUtc("2026-10-10", "15:00", "UTC").toISOString()).toBe("2026-10-10T15:00:00.000Z");
  });

  it("handles DST transitions (New York, Nov 1 2026)", () => {
    // EDT (UTC-4) the day before, EST (UTC-5) after the switch.
    expect(zonedWallTimeToUtc("2026-10-31", "15:00", "America/New_York").toISOString()).toBe("2026-10-31T19:00:00.000Z");
    expect(zonedWallTimeToUtc("2026-11-02", "15:00", "America/New_York").toISOString()).toBe("2026-11-02T20:00:00.000Z");
  });

  it("derives local dates/clocks across the date line", () => {
    const t = new Date("2026-10-10T20:00:00Z");
    expect(dateInZone(t, "Asia/Kolkata")).toBe("2026-10-11");
    expect(dateInZone(t, "America/Los_Angeles")).toBe("2026-10-10");
    expect(localClock(t, "Asia/Kolkata")).toEqual({ minutes: 90, weekday: 7 }); // 01:30 Sunday
    expect(startOfDayInZone(t, "Asia/Kolkata").toISOString()).toBe("2026-10-10T18:30:00.000Z");
  });

  it("date arithmetic and overlap", () => {
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDate("2026-03-01", -1)).toBe("2026-02-28");
    const d = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
    expect(overlaps(d(9), d(10), d(10), d(11))).toBe(false); // back-to-back is not a conflict
    expect(overlaps(d(9), d(11), d(10), d(12))).toBe(true);
  });

  it("formats ranges with the zone name", () => {
    expect(formatRangeInZone(new Date("2026-10-10T09:30:00Z"), new Date("2026-10-10T10:00:00Z"), "Asia/Kolkata")).toBe(
      "Sat, 10 Oct 2026, 15:00–15:30 (Asia/Kolkata)",
    );
  });

  it("rejects malformed input", () => {
    expect(() => zonedWallTimeToUtc("10/10/2026", "3pm", "UTC")).toThrow();
  });
});
