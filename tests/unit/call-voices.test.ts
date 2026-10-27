import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allVoices, listMagpieVoices, resetMagpieVoices, streamMagpieSpeech, voiceIn, type MagpieVoice } from "@/server/providers/magpie";
import { voiceLabel } from "@/components/meeting/voice-picker";

const v = (id: string): MagpieVoice => ({ id, speaker: id.split(".")[0], tone: id.split(".")[1] ?? null });
const CATALOG = new Map<string, MagpieVoice[]>([
  ["en", ["Louise", "Sofia", "Sofia.Calm", "Jason", "Jason.Happy"].map(v)],
  ["hi", ["Louise", "Sofia", "Leo"].map(v)],
  ["ar", ["Sofia", "Ray"].map(v)],
]);

describe("a speaker's voice, as each language hears it (voiceIn)", () => {
  it("the exact voice and tone where the language has it", () => {
    expect(voiceIn(CATALOG, "en", "Sofia.Calm")).toBe("Sofia.Calm");
  });
  it("the same voice without the tone where the language lacks the tone", () => {
    expect(voiceIn(CATALOG, "hi", "Sofia.Calm")).toBe("Sofia");
  });
  it("the language's default voice where it lacks the voice", () => {
    expect(voiceIn(CATALOG, "hi", "Jason.Happy")).toBeNull();
    expect(voiceIn(CATALOG, "ar", "Louise")).toBeNull();
    expect(voiceIn(CATALOG, "en", null)).toBeNull();
  });
  it("speakers choose from every voice on offer, their own language's first, each once", () => {
    expect(allVoices(CATALOG, "hi").map((x) => x.id)).toEqual(["Louise", "Sofia", "Leo", "Sofia.Calm", "Jason", "Jason.Happy", "Ray"]);
  });
  it("labels voices for people", () => {
    expect(voiceLabel("Sofia.Calm")).toBe("Sofia · Calm");
    expect(voiceLabel("Diego.PleasantSurprised")).toBe("Diego · Pleasantly surprised");
    expect(voiceLabel("Louise")).toBe("Louise");
  });
});

describe("Magpie voice catalog", () => {
  beforeEach(() => {
    resetMagpieVoices();
    vi.stubEnv("MAGPIE_TTS_URL", "http://magpie.test/v1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const body = { "en-US,hi-IN": { voices: ["Magpie-Multilingual.EN-US.Sofia", "Magpie-Multilingual.EN-US.Sofia.Calm", "Magpie-Multilingual.HI-IN.Leo", "Magpie-Multilingual.XX-YY.Nope", "junk"] } };

  it("groups the server's voices by app language, with tones; caches the list", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(body)));
    const m = await listMagpieVoices(f as never);
    expect(m.get("en")).toEqual([{ id: "Sofia", speaker: "Sofia", tone: null }, { id: "Sofia.Calm", speaker: "Sofia", tone: "Calm" }]);
    expect(m.get("hi")).toEqual([{ id: "Leo", speaker: "Leo", tone: null }]);
    await listMagpieVoices(f as never);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("http://magpie.test/v1/audio/list_voices");
  });
  it("is empty when the server is down (no voice choice offered)", async () => {
    expect((await listMagpieVoices((async () => { throw new Error("down"); }) as never)).size).toBe(0);
  });
  it("sends the chosen voice and tone to Magpie; falls back to the default for anything malformed", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent.push(String((init.body as FormData).get("voice")));
      return new Response(new Uint8Array([1, 2, 3, 4]));
    });
    await streamMagpieSpeech("Hello", "en", { voice: "Sofia.Calm" });
    await streamMagpieSpeech("Hello", "en", { voice: "../../etc" });
    await streamMagpieSpeech("Hello", "ar", {});
    expect(sent).toEqual(["Magpie-Multilingual.EN-US.Sofia.Calm", "Magpie-Multilingual.EN-US.Louise", "Magpie-Multilingual.AR-XA.Sofia"]);
  });
});
