import { describe, expect, it } from "vitest";
import { MOVIES, parseShowId, priceSeats, showId, showsOn, showtimes, suggestSeats, takenSeats, CINEMAS } from "@/server/providers/commerce/movies";
import { foodStages, movieStages } from "@/server/services/partners";

const date = "2030-03-14";
const anyShow = () => {
  for (const c of CINEMAS) for (const m of MOVIES) { const t = showsOn(c.id, m.id, date); if (t.length) return { c, m, t: t[0] }; }
  throw new Error("no shows");
};

describe("sandbox cinema", () => {
  it("show ids round-trip and invalid ones are rejected", () => {
    const { c, m, t } = anyShow();
    const id = showId(c.id, m.id, date, t);
    expect(parseShowId(id)).toMatchObject({ cinema: { id: c.id }, movie: { id: m.id }, date, time: t });
    expect(() => parseShowId("cn-galaxy-kor~mv-nope~20300314~1830")).toThrow();
    expect(() => parseShowId("garbage")).toThrow();
  });

  it("suggests adjacent free seats near the centre, Prime rows first", () => {
    expect(suggestSeats(new Set(), 2)).toEqual(["F7", "F8"]);
    const busyF = new Set(Array.from({ length: 14 }, (_, i) => `F${i + 1}`));
    expect(suggestSeats(busyF, 3)![0][0]).toBe("G");
    expect(suggestSeats(new Set(["F7"]), 2)).toEqual(["F8", "F9"]);
    expect(suggestSeats(new Set(), 2, "Recliner")![0][0]).toBe("I");
  });

  it("prices seats by category plus a fee with GST", () => {
    expect(priceSeats(["F7", "F8"])).toEqual({ ticketsPaise: 52000, feePaise: 7080, totalPaise: 59080 });
    expect(priceSeats(["A1", "J1"]).ticketsPaise).toBe(18000 + 45000);
  });

  it("other customers' seats are deterministic; our bookings add to them", () => {
    const id = showId(anyShow().c.id, anyShow().m.id, date, anyShow().t);
    const a = takenSeats(id, []);
    expect(takenSeats(id, [])).toEqual(a);
    expect(a.size).toBeGreaterThan(20);
    expect(takenSeats(id, ["F7"]).has("F7")).toBe(true);
  });

  it("showtimes hide shows starting within 15 minutes", () => {
    const { m } = anyShow();
    const all = showtimes(m.id, date, undefined, new Date("2030-03-13T00:00:00Z").getTime());
    const later = showtimes(m.id, date, undefined, all[0].start.getTime() - 10 * 60_000);
    expect(later.find((s) => s.show_id === all[0].show_id)).toBeUndefined();
  });
});

describe("partner order lifecycle (accelerated)", () => {
  it("food orders move through every stage; a cancellation stops it", () => {
    const t0 = new Date("2030-01-01T10:00:00Z");
    expect(foodStages(t0, null, t0.getTime() + 50_000).map((s) => s.done)).toEqual([true, true, true, false, false]);
    const c = foodStages(t0, new Date(t0.getTime() + 20_000), t0.getTime() + 300_000);
    expect(c.filter((s) => s.done).map((s) => s.name)).toEqual(["Order received", "Accepted by the restaurant", "Cancelled by the customer"]);
  });
  it("movie bookings: tickets issued, then showtime and end", () => {
    const t0 = new Date("2030-01-01T10:00:00Z");
    const show = new Date("2030-01-01T18:00:00Z");
    expect(movieStages(t0, show, 120, null, t0.getTime() + 10_000).map((s) => s.done)).toEqual([true, true, false, false]);
    expect(movieStages(t0, show, 120, null, show.getTime() + 121 * 60_000).every((s) => s.done)).toBe(true);
  });
});
