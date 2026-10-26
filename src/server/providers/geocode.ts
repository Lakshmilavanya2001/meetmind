import "server-only";

/**
 * Place name → coordinates, used only to pre-fill the "Open in Uber" link (Uber's links expect coordinates).
 * Off unless GEOCODER_URL is set. It speaks the Nominatim search API, e.g. https://nominatim.openstreetmap.org
 * (public: at most 1 request a second, and a contact in the User-Agent: set GEOCODER_CONTACT) or a self-hosted copy.
 * Results are cached; a slow or failed lookup just gives no coordinates.
 */
export type GeoPoint = { lat: number; lng: number; label: string };

const TIMEOUT_MS = 2500;
const MIN_GAP_MS = 1100; // the public server's limit is 1 request a second
const CACHE_MAX = 500;
const CACHE_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, { at: number; point: GeoPoint | null }>();
let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;

export function readGeocoderConfig(env: Record<string, string | undefined> = process.env) {
  const url = env.GEOCODER_URL?.trim().replace(/\/$/, "");
  return url ? { url, contact: env.GEOCODER_CONTACT?.trim() || "", countries: env.GEOCODER_COUNTRIES?.trim() || "" } : null;
}

export async function geocode(place: string, fetcher: typeof fetch = fetch): Promise<GeoPoint | null> {
  const cfg = readGeocoderConfig();
  const key = place.trim().toLowerCase();
  if (!cfg || key.length < 3) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.point;

  // One request at a time, spaced out, so the public server's rate limit is respected.
  const run = queue.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    const q = new URLSearchParams({ q: place.trim(), format: "jsonv2", limit: "1" });
    if (cfg.countries) q.set("countrycodes", cfg.countries);
    try {
      const res = await fetcher(`${cfg.url}/search?${q}`, {
        headers: { "User-Agent": `MeetMind/1.0${cfg.contact ? ` (${cfg.contact})` : ""}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as { lat?: string; lon?: string; display_name?: string }[];
      const r = rows[0];
      const lat = Number(r?.lat);
      const lng = Number(r?.lon);
      if (!r || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, label: r.display_name ?? place };
    } catch {
      return null;
    }
  });
  queue = run.catch(() => null);
  const point = await run;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), point });
  return point;
}

/** Tests only. */
export function resetGeocodeCache() {
  cache.clear();
  lastAt = 0;
}
