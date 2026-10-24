import { describe, expect, it } from "vitest";
import { parseNaturalDateTime } from "@/server/ai/datetime";

// Friday 9 Oct 2026, 14:00 in Kolkata (08:30 UTC).
const NOW = new Date("2026-10-09T08:30:00Z");

describe("parseNaturalDateTime", () => {
  it("resolves relative dates in the user's zone", () => {
    const r = parseNaturalDateTime("tomorrow at 3 PM", "Asia/Kolkata", NOW);
    expect(r).toMatchObject({ ok: true, start: "2026-10-10T09:30:00.000Z", timeSpecified: true });
  });

  it("uses the zone's date, not the server's (late evening in New York)", () => {
    const lateNy = new Date("2026-10-10T02:30:00Z"); // 22:30 Fri 9 Oct in New York, already Sat in UTC
    const r = parseNaturalDateTime("tomorrow at 9am", "America/New_York", lateNy);
    expect(r).toMatchObject({ ok: true, start: "2026-10-10T13:00:00.000Z" }); // Sat 10 Oct 09:00 EDT
  });

  it("is DST-aware", () => {
    const r = parseNaturalDateTime("November 2 at 3pm", "America/New_York", NOW);
    expect(r).toMatchObject({ ok: true, start: "2026-11-02T20:00:00.000Z" }); // EST after the switch
  });

  it("picks the next weekday going forward and reads durations", () => {
    const r = parseNaturalDateTime("Friday at 11 AM for 45 minutes", "Asia/Kolkata", NOW);
    expect(r).toMatchObject({ ok: true, start: "2026-10-16T05:30:00.000Z", end: "2026-10-16T06:15:00.000Z", durationMinutes: 45 });
    const range = parseNaturalDateTime("tomorrow 3pm to 4:30pm", "UTC", NOW);
    expect(range).toMatchObject({ ok: true, durationMinutes: 90 });
  });

  it("flags a missing time instead of inventing one", () => {
    const r = parseNaturalDateTime("tomorrow", "Asia/Kolkata", NOW);
    expect(r).toMatchObject({ ok: true, timeSpecified: false });
    expect(parseNaturalDateTime("whenever works", "UTC", NOW)).toMatchObject({ ok: false });
  });
});
