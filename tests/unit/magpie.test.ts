import { afterEach, describe, expect, it, vi } from "vitest";
import { createMagpieTtsProvider, MAGPIE_LOCALE, magpieCovers, streamMagpieSpeech } from "@/server/providers/magpie";
import { CALL_LANGUAGES } from "@/server/interpreter/constants";
import { RIVA_LANG } from "@/server/providers/stt";

describe("Magpie voice and Parakeet recognition cover the same call languages", () => {
  it("every call language has a Magpie voice and a Parakeet locale", () => {
    for (const l of CALL_LANGUAGES) {
      expect(MAGPIE_LOCALE[l], l).toBeTruthy();
      expect(RIVA_LANG[l], l).toBeTruthy();
    }
    expect(magpieCovers("hi-IN")).toBe(true);
    expect(magpieCovers("ta")).toBe(false);
  });
});

describe("Magpie provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MAGPIE_TTS_URL;
  });

  it("sends the locale, the text and a voice for that language as a form", async () => {
    const calls: { url: string; body: FormData }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as FormData });
      return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } });
    }) as unknown as typeof fetch;
    const tts = createMagpieTtsProvider({ baseUrl: "http://magpie/v1" }, fetchImpl);
    const out = await tts.synthesize("नमस्ते", { language: "hi" });
    expect(out?.mimeType).toBe("audio/wav");
    expect(calls[0].url).toBe("http://magpie/v1/audio/synthesize");
    expect(calls[0].body.get("language")).toBe("hi-IN");
    expect(calls[0].body.get("voice")).toBe("Magpie-Multilingual.HI-IN.Louise");
    expect(calls[0].body.get("sample_rate_hz")).toBe("22050"); // 24000 is rejected by the server
    expect(await tts.synthesize("வணக்கம்", { language: "ta" })).toBeNull(); // not a Magpie language
  });

  it("Arabic uses a voice that exists in Arabic", async () => {
    let voice: unknown;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      voice = (init.body as FormData).get("voice");
      return new Response(new Uint8Array([1]));
    }) as unknown as typeof fetch;
    await createMagpieTtsProvider({ baseUrl: "http://m/v1" }, fetchImpl).synthesize("مرحبا", { language: "ar" });
    expect(voice).toBe("Magpie-Multilingual.AR-XA.Sofia");
  });

  it("streaming fails before any audio when the server answers with an error (so the caller can fall back)", async () => {
    process.env.MAGPIE_TTS_URL = "http://magpie/v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Internal server error." } }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(streamMagpieSpeech("Hello.", "en")).rejects.toThrow(/Magpie/);
    expect(await streamMagpieSpeech("Hello.", "ta")).toBeNull();
  });

  it("streaming passes the audio through once the first bytes arrive", async () => {
    process.env.MAGPIE_TTS_URL = "http://magpie/v1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))));
    const s = await streamMagpieSpeech("Hello.", "en");
    const got = new Uint8Array(await new Response(s).arrayBuffer());
    expect([...got]).toEqual([1, 2, 3, 4]);
  });
});
