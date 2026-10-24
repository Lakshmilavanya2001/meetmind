import { describe, expect, it, vi } from "vitest";
import { createOpenAiSttProvider, TransientSttError } from "@/server/providers/stt";

const config = { baseUrl: "http://stt.test/v1", model: "granite" };

describe("STT client", () => {
  it("posts multipart audio and returns trimmed text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "  hello team " }), { status: 200 }));
    const r = await createOpenAiSttProvider(config, fetchImpl).transcribe(Buffer.from("RIFF"), { mimeType: "audio/wav" });
    expect(r.text).toBe("hello team");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://stt.test/v1/audio/transcriptions");
    expect((init.body as FormData).get("model")).toBe("granite");
  });

  it("classifies failures", async () => {
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(createOpenAiSttProvider(config, down).transcribe(Buffer.from("x"), { mimeType: "audio/wav" })).rejects.toBeInstanceOf(TransientSttError);
    const busy = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    await expect(createOpenAiSttProvider(config, busy).transcribe(Buffer.from("x"), { mimeType: "audio/wav" })).rejects.toBeInstanceOf(TransientSttError);
    const bad = vi.fn().mockResolvedValue(new Response("bad audio", { status: 400 }));
    await expect(createOpenAiSttProvider(config, bad).transcribe(Buffer.from("x"), { mimeType: "audio/wav" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
