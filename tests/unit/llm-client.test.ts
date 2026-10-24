import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleProvider } from "@/server/ai/llm";

const config = { baseUrl: "http://llm.test/v1", model: "m", enableThinking: false, timeoutMs: 5000 };

function sse(chunks: object[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  // Split mid-line to exercise buffering.
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 37)); c.enqueue(bytes.slice(37)); c.close(); } }), { status: 200 });
}
const delta = (d: object, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

describe("OpenAI-compatible LLM client", () => {
  it("streams text and assembles parallel tool calls from fragments", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([
        delta({ content: "Let me " }),
        delta({ content: "check." }),
        delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "search_users" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"query": "Ra' } }] }),
        delta({ tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "search_users", arguments: '{"query":"Priya"}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'hul"}' } }] }, "tool_calls"),
      ]),
    );
    const seen: string[] = [];
    const r = await createOpenAiCompatibleProvider(config, fetchImpl).complete({ messages: [{ role: "user", content: "hi" }], onDelta: (t) => seen.push(t) });
    expect(seen.join("")).toBe("Let me check.");
    expect(r.toolCalls.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments).query])).toEqual([
      ["c1", "search_users", "Rahul"],
      ["c2", "search_users", "Priya"],
    ]);
    expect(r.finishReason).toBe("tool_calls");
  });

  it("retries transient failures, then gives a clear error", async () => {
    const ok = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValue(sse([delta({ content: "hi" }, "stop")]));
    await expect(createOpenAiCompatibleProvider(config, ok).complete({ messages: [] })).resolves.toMatchObject({ content: "hi" });
    expect(ok).toHaveBeenCalledTimes(2);

    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(createOpenAiCompatibleProvider(config, down).complete({ messages: [] })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(down).toHaveBeenCalledTimes(3);

    const bad = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    await expect(createOpenAiCompatibleProvider(config, bad).complete({ messages: [] })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(bad).toHaveBeenCalledTimes(1); // 4xx is not retried
  });
});
