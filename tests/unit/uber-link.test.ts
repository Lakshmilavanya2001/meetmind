import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyResultLink, uberRideLink } from "@/lib/uber-link";
import { geocode, resetGeocodeCache } from "@/server/providers/geocode";

describe("Open in Uber link", () => {
  it("fills in pickup and drop-off with coordinates and addresses", () => {
    const u = new URL(uberRideLink({ address: "Indiranagar, Bengaluru", lat: 12.9732913, lng: 77.6404672 }, { address: "Kempegowda Airport", lat: 13.1986, lng: 77.7066 }));
    expect(u.origin).toBe("https://m.uber.com");
    expect(u.pathname).toBe("/ul/");
    expect(u.searchParams.get("action")).toBe("setPickup");
    expect(u.searchParams.get("pickup[latitude]")).toBe("12.973291");
    expect(u.searchParams.get("pickup[longitude]")).toBe("77.640467");
    expect(u.searchParams.get("pickup[formatted_address]")).toBe("Indiranagar, Bengaluru");
    expect(u.searchParams.get("dropoff[latitude]")).toBe("13.198600");
    expect(u.searchParams.get("dropoff[nickname]")).toBe("Kempegowda Airport");
    expect(u.searchParams.has("client_id")).toBe(false);
  });

  it("without coordinates passes only the addresses; adds the client id when set", () => {
    const u = new URL(uberRideLink({ address: "MG Road & Brigade Rd" }, { address: "Koramangala" }, "abc123"));
    expect(u.searchParams.has("pickup[latitude]")).toBe(false);
    expect(u.searchParams.get("pickup[formatted_address]")).toBe("MG Road & Brigade Rd"); // encoded safely
    expect(u.searchParams.get("client_id")).toBe("abc123");
  });

  it("the chat shows only app pages and Uber links", () => {
    expect(classifyResultLink("/tasks")).toBe("internal");
    expect(classifyResultLink(uberRideLink({ address: "a b c" }, { address: "d e f" }))).toBe("uber");
    expect(classifyResultLink("//evil.example/x")).toBeNull();
    expect(classifyResultLink("https://evil.example/ul/")).toBeNull();
    expect(classifyResultLink("http://m.uber.com/ul/")).toBeNull();
    expect(classifyResultLink("https://m.uber.com.evil.example/")).toBeNull();
    expect(classifyResultLink("javascript:alert(1)")).toBeNull();
    expect(classifyResultLink(undefined)).toBeNull();
  });
});

describe("geocoder", () => {
  const ok = (lat: string, lon: string) => new Response(JSON.stringify([{ lat, lon, display_name: "Somewhere" }]), { status: 200 });
  beforeEach(() => {
    resetGeocodeCache();
    vi.stubEnv("GEOCODER_URL", "https://geo.example/");
    vi.stubEnv("GEOCODER_CONTACT", "");
    vi.stubEnv("GEOCODER_COUNTRIES", "in");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off unless GEOCODER_URL is set", async () => {
    vi.stubEnv("GEOCODER_URL", "");
    const f = vi.fn();
    expect(await geocode("Indiranagar", f as never)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns coordinates, asks within the configured countries, sends no contact unless set, and caches", async () => {
    const f = vi.fn(async () => ok("12.97", "77.64"));
    expect(await geocode("Indiranagar", f as never)).toEqual({ lat: 12.97, lng: 77.64, label: "Somewhere" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/geo\.example\/search\?/);
    expect(new URL(url).searchParams.get("countrycodes")).toBe("in");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("MeetMind/1.0");
    expect(await geocode("  indiranagar ", f as never)).toEqual({ lat: 12.97, lng: 77.64, label: "Somewhere" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a failed or empty lookup gives no coordinates", async () => {
    expect(await geocode("Nowhere at all", (async () => new Response("[]")) as never)).toBeNull();
    expect(await geocode("Server down", (async () => new Response("x", { status: 503 })) as never)).toBeNull();
    expect(await geocode("Network error", (async () => { throw new Error("boom"); }) as never)).toBeNull();
  });
});
