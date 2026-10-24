import "server-only";
import { createHash } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { AppError } from "../../errors";
import { zonedWallTimeToUtc } from "@/lib/time";

/**
 * Sandbox cinema catalogue: fictional films and cinemas (no real chain), deterministic showtimes and
 * seat availability. Nothing here reaches a real cinema or payment network.
 */
export const CINEMA_TZ = "Asia/Kolkata";

export type Movie = { id: string; title: string; language: string; genre: string; certificate: string; minutes: number; synopsis: string };
export type Cinema = { id: string; name: string; area: string };

export const MOVIES: Movie[] = [
  { id: "mv-monsoon-express", title: "Monsoon Express", language: "Hindi", genre: "Action thriller", certificate: "UA13+", minutes: 148, synopsis: "A train, a storm and a missing ledger: one night from Mumbai to Goa." },
  { id: "mv-last-signal", title: "The Last Signal", language: "English", genre: "Sci-fi", certificate: "UA13+", minutes: 132, synopsis: "A deep-space relay picks up a message from Earth sent fifty years too late." },
  { id: "mv-kadhal-paadhai", title: "Kadhal Paadhai", language: "Tamil", genre: "Romance drama", certificate: "U", minutes: 141, synopsis: "Two strangers, one bus route, and a summer in Madurai." },
  { id: "mv-little-big-chef", title: "Little Big Chef", language: "English", genre: "Animation · family", certificate: "U", minutes: 98, synopsis: "A ten-year-old enters a national cooking contest with her grandmother's recipes." },
  { id: "mv-ghar-wapsi", title: "Ghar Wapsi", language: "Hindi", genre: "Comedy drama", certificate: "U", minutes: 126, synopsis: "Three siblings come home for a wedding nobody wanted to plan." },
];
export const CINEMAS: Cinema[] = [
  { id: "cn-galaxy-kor", name: "Galaxy Cinemas", area: "Koramangala" },
  { id: "cn-starlight-wf", name: "Starlight Multiplex", area: "Whitefield" },
  { id: "cn-regal-mg", name: "Regal Picture House", area: "MG Road" },
];
const TIMES = ["10:30", "13:15", "16:00", "18:45", "21:45"];

export const ROWS = "ABCDEFGHIJ".split("");
export const SEATS_PER_ROW = 14;
export const CATEGORIES = [
  { name: "Classic", rows: "ABC", pricePaise: 18000 },
  { name: "Prime", rows: "DEFGH", pricePaise: 26000 },
  { name: "Recliner", rows: "IJ", pricePaise: 45000 },
];
export const FEE_PER_TICKET_PAISE = 3000;
export const GST_ON_FEE = 0.18;

const h = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export const categoryOf = (seat: string) => CATEGORIES.find((c) => c.rows.includes(seat[0]))!;

/** Show ids are readable and self-describing: cinema~movie~YYYYMMDD~HHmm. */
export const showId = (cinemaId: string, movieId: string, date: string, time: string) => `${cinemaId}~${movieId}~${date.replace(/-/g, "")}~${time.replace(":", "")}`;
export function parseShowId(id: string) {
  const m = /^(cn-[a-z-]+)~(mv-[a-z-]+)~(\d{4})(\d{2})(\d{2})~(\d{2})(\d{2})$/.exec(id);
  if (!m) throw new AppError("VALIDATION", "Unknown show. Use get_showtimes to find show ids.");
  const cinema = CINEMAS.find((c) => c.id === m[1]);
  const movie = MOVIES.find((x) => x.id === m[2]);
  if (!cinema || !movie) throw new AppError("VALIDATION", "Unknown show. Use get_showtimes to find show ids.");
  const date = `${m[3]}-${m[4]}-${m[5]}`;
  const time = `${m[6]}:${m[7]}`;
  if (!TIMES.includes(time) || !showsOn(cinema.id, movie.id, date).includes(time)) throw new AppError("VALIDATION", "That show doesn't exist. Use get_showtimes.");
  return { id, cinema, movie, date, time, start: zonedWallTimeToUtc(date, time, CINEMA_TZ) };
}

/** Which times a film plays at a cinema on a date (3–4 of the 5 slots, varying by day). */
export function showsOn(cinemaId: string, movieId: string, date: string) {
  if (h(`${cinemaId}|${movieId}`) % 4 === 0) return []; // not every cinema shows every film
  return TIMES.filter((t) => h(`${cinemaId}|${movieId}|${date}|${t}`) % 5 !== 0);
}

export function searchMovies(q: { query?: string; language?: string; genre?: string }) {
  const query = q.query ? norm(q.query) : "";
  return MOVIES.filter(
    (m) =>
      (!q.language || norm(m.language).includes(norm(q.language))) &&
      (!q.genre || norm(m.genre).includes(norm(q.genre))) &&
      (!query || query.split(" ").every((w) => norm(`${m.title} ${m.genre} ${m.language}`).includes(w))),
  );
}

export function showtimes(movieId: string, date: string, area?: string, now = Date.now()) {
  const movie = MOVIES.find((m) => m.id === movieId);
  if (!movie) throw new AppError("NOT_FOUND", "Unknown film. Use search_movies.");
  return CINEMAS.filter((c) => !area || norm(c.area).includes(norm(area)) || norm(c.name).includes(norm(area))).flatMap((c) =>
    showsOn(c.id, movie.id, date)
      .map((t) => ({ show_id: showId(c.id, movie.id, date, t), cinema: c.name, area: c.area, start: zonedWallTimeToUtc(date, t, CINEMA_TZ), local: `${formatInTimeZone(zonedWallTimeToUtc(date, t, CINEMA_TZ), CINEMA_TZ, "EEE d MMM")}, ${t}` }))
      .filter((s) => s.start.getTime() > now + 15 * 60_000), // bookable until 15 min before
  );
}

/** Seats already sold for a show: deterministic "other customers" plus our own bookings. */
export function takenSeats(show: string, booked: string[]) {
  const taken = new Set(booked);
  for (const r of ROWS) for (let n = 1; n <= SEATS_PER_ROW; n++) if (h(`${show}|${r}${n}`) % 100 < 38) taken.add(`${r}${n}`);
  return taken;
}

/** Best block of `count` adjacent free seats: Prime first, closest to the centre. */
export function suggestSeats(taken: Set<string>, count: number, category?: string) {
  const order = ["F", "G", "E", "H", "D", "I", "J", "C", "B", "A"].filter((r) => !category || categoryOf(`${r}1`).name.toLowerCase() === category.toLowerCase());
  const centre = (SEATS_PER_ROW + 1) / 2;
  for (const r of order) {
    let best: string[] | null = null;
    let bestDist = Infinity;
    for (let s = 1; s + count - 1 <= SEATS_PER_ROW; s++) {
      const block = Array.from({ length: count }, (_, i) => `${r}${s + i}`);
      if (block.some((x) => taken.has(x))) continue;
      const dist = Math.abs(s + (count - 1) / 2 - centre);
      if (dist < bestDist) {
        bestDist = dist;
        best = block;
      }
    }
    if (best) return best;
  }
  return null;
}

export function priceSeats(seats: string[]) {
  const ticketsPaise = seats.reduce((a, s) => a + categoryOf(s).pricePaise, 0);
  const feePaise = Math.round(seats.length * FEE_PER_TICKET_PAISE * (1 + GST_ON_FEE));
  return { ticketsPaise, feePaise, totalPaise: ticketsPaise + feePaise };
}

export const isSeat = (s: string) => /^[A-J](?:[1-9]|1[0-4])$/.test(s);
