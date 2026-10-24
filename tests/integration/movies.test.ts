import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/server/db";
import { setLlmProviderForTests, type CompletionRequest, type CompletionResult } from "@/server/ai/llm";
import { decideAction, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { bookMovie, cancelBooking, movieSeatMap, orderFood } from "@/server/services/bookings";
import { cinemaPortal, foodPortal } from "@/server/services/partners";
import { CINEMAS, MOVIES, showsOn, showId } from "@/server/providers/commerce/movies";
import { createOrg, createUser, resetDb } from "../helpers";

let n = 0;
const call = (name: string, args: object) => ({ id: `m${++n}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const lastTool = (req: CompletionRequest) => JSON.parse([...req.messages].reverse().find((m) => m.role === "tool")!.content as string);
function movies(steps: ((req: CompletionRequest) => Partial<CompletionResult>)[]) {
  setLlmProviderForTests({
    model: "s",
    complete: async (req) => {
      if (req.jsonSchema?.name === "route_request") return { content: JSON.stringify({ steps: [{ agent: "movies", task: "Book the tickets" }] }), toolCalls: [], finishReason: "stop" };
      const r = { content: "", toolCalls: [], finishReason: "stop", ...steps.shift()!(req) };
      if (r.content) req.onDelta?.(r.content);
      return r;
    },
  });
}
beforeEach(() => resetDb());
afterAll(() => setLlmProviderForTests(null));

async function setup() {
  const org = await createOrg();
  const mk = async (name: string) => {
    const u = await createUser(org.id, name, { timezone: "Asia/Kolkata" });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, email: u.email, displayName: name, timezone: "Asia/Kolkata" } };
  };
  const date = formatInTimeZone(new Date(Date.now() + 3 * 86400_000), "Asia/Kolkata", "yyyy-MM-dd");
  const film = MOVIES.find((m) => m.id === "mv-last-signal")!;
  const cinema = CINEMAS.find((c) => showsOn(c.id, film.id, date).length)!;
  const show = showId(cinema.id, film.id, date, showsOn(cinema.id, film.id, date)[0]);
  return { aisha: await mk("Aisha Khan"), priya: await mk("Priya Patel"), show, cinema };
}

describe("movie tickets", () => {
  it("the Movies agent checks seats, then books only after confirmation", async () => {
    const { aisha, show } = await setup();
    const events: AgentEvent[] = [];
    movies([
      () => ({ toolCalls: [call("get_seat_map", { show_id: show, party_size: 2 })] }),
      (req) => ({ toolCalls: [call("book_movie_tickets", { show_id: show, seats: lastTool(req).data.suggestedSeats })] }),
      () => ({ content: "Waiting for your confirmation." }),
    ]);
    await runAgentTurn(aisha, { message: "Book 2 tickets for The Last Signal" }, (e) => events.push(e));
    const conf = events.find((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>;
    expect(conf.summary).toMatch(/^Book 2 tickets for The Last Signal \(English, UA13\+\) at .* seats [A-J]\d+, [A-J]\d+ .*= ₹\d+.*Sandbox/);
    expect(await db.booking.count()).toBe(0);
    await decideAction(aisha, conf.actionId, "confirm");
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ kind: "MOVIE", userId: aisha.userId });
  });

  it("taken seats are refused, and two people can't buy the same seats at once", async () => {
    const { aisha, priya, show } = await setup();
    const map = await movieSeatMap(aisha, show, 2);
    const seats = map.suggestion!;
    const r = await Promise.allSettled([bookMovie(aisha, { showId: show, seats }), bookMovie(priya, { showId: show, seats })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await expect(bookMovie(aisha, { showId: show, seats: [seats[0]] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(bookMovie(aisha, { showId: show, seats: ["Z99"] })).rejects.toThrow(/isn't a seat/);
    expect((await movieSeatMap(aisha, show, 2)).taken).toEqual(expect.arrayContaining(seats));
  });

  it("cancelling releases the seats", async () => {
    const { aisha, show } = await setup();
    const seats = (await movieSeatMap(aisha, show, 1)).suggestion!;
    const b = await bookMovie(aisha, { showId: show, seats });
    await cancelBooking(aisha, b.booking.id);
    expect((await movieSeatMap(aisha, show, 1)).taken).not.toContain(seats[0]);
  });
});

describe("partner portals", () => {
  it("show only your own orders, with their items, seats and stages", async () => {
    const { aisha, priya, show, cinema } = await setup();
    await orderFood(aisha, { restaurantId: "r-slice-republic", items: [{ itemId: "m-margherita-m", quantity: 2 }, { itemId: "m-garlic-bread", quantity: 1 }], address: "Acme office, Koramangala" });
    await orderFood(priya, { restaurantId: "r-slice-republic", items: [{ itemId: "m-cola", quantity: 1 }], address: "Priya's flat, HSR Layout" });
    const food = await foodPortal(aisha, "r-slice-republic");
    expect(food.orders).toHaveLength(1);
    expect(food.orders[0].items.map((i) => `${i.quantity}× ${i.name}`)).toEqual(["2× Margherita pizza (medium)", "1× Garlic breadsticks"]);
    expect(food.orders[0].stages[0]).toMatchObject({ name: "Order received", done: true });
    expect(JSON.stringify(food)).not.toContain("HSR Layout");

    const seats = (await movieSeatMap(aisha, show, 2)).suggestion!;
    await bookMovie(aisha, { showId: show, seats });
    const box = await cinemaPortal(aisha, cinema.id);
    expect(box.bookings[0].seats).toEqual(seats);
    const row = "ABCDEFGHIJ".indexOf(seats[0][0]);
    expect(box.bookings[0].hall[row][Number(seats[0].slice(1)) - 1]).toBe("mine");
    expect((await cinemaPortal(priya, cinema.id)).bookings).toHaveLength(0);
  });
});
