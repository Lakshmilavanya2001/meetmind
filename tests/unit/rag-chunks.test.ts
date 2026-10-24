import { describe, expect, it, vi } from "vitest";
import { buildChunks } from "@/server/services/transcript-index";
import { createOpenAiEmbeddingProvider } from "@/server/providers/embeddings";

describe("transcript chunking", () => {
  it("keeps timestamps/speakers, respects size, overlaps by one segment", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 10_000, endMs: i * 10_000 + 9000, speakerLabel: i % 2 ? "Priya" : "Rahul", text: "x".repeat(250) }));
    const chunks = buildChunks(segs, 900);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].text.startsWith("[00:00] Rahul: ")).toBe(true);
    expect(chunks.every((c) => c.text.length <= 900 || c.text.split("\n").length === 1)).toBe(true);
    // Overlap: the last line of a chunk starts the next one.
    expect(chunks[1].text.split("\n")[0]).toBe(chunks[0].text.split("\n").at(-1));
    expect(chunks.at(-1)!.endMs).toBe(99_000);
    expect(new Set(chunks.flatMap((c) => c.speakerLabels))).toEqual(new Set(["Rahul", "Priya"]));
  });

  it("handles a single huge segment and empty input", () => {
    expect(buildChunks([{ startMs: 0, endMs: 1, speakerLabel: "A", text: "y".repeat(5000) }])).toHaveLength(1);
    expect(buildChunks([])).toEqual([]);
  });
});

describe("embedding client", () => {
  it("batches, orders by index and checks dimensions", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(init.body as string).input as string[];
      return new Response(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: [t.length, 0] })).reverse() }), { status: 200 });
    });
    const p = createOpenAiEmbeddingProvider({ baseUrl: "http://e", model: "m", dimensions: 2, queryPrefix: "", passagePrefix: "", batchSize: 2 }, fetchImpl as never);
    expect(await p.embed(["a", "bb", "ccc"], "passage")).toEqual([[1, 0], [2, 0], [3, 0]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const wrongDims = createOpenAiEmbeddingProvider({ baseUrl: "http://e", model: "m", dimensions: 3, queryPrefix: "", passagePrefix: "", batchSize: 8 }, fetchImpl as never);
    await expect(wrongDims.embed(["a"], "query")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
