import "server-only";
import { AppError } from "../errors";

// Provider-independent chat model interface (OpenAI-compatible wire format underneath).

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type CompletionRequest = {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Called with each text fragment as it streams in. */
  onDelta?: (text: string) => void;
  /** Constrain output to a JSON Schema (vLLM/OpenAI structured outputs). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
};

export type CompletionResult = { content: string; toolCalls: ToolCall[]; finishReason: string | null };

export interface LlmProvider {
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

type Config = { baseUrl: string; model: string; apiKey?: string; enableThinking: boolean; timeoutMs: number };

export function readLlmConfig(env: Record<string, string | undefined> = process.env): Config | null {
  if (!env.LLM_BASE_URL || !env.LLM_MODEL) return null;
  return {
    baseUrl: env.LLM_BASE_URL.replace(/\/$/, ""),
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY,
    enableThinking: env.LLM_ENABLE_THINKING === "true",
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 120_000),
  };
}

const isTransient = (status: number) => status === 429 || status >= 500;

/** OpenAI-compatible /chat/completions client with streaming and tool-call accumulation. */
export function createOpenAiCompatibleProvider(config: Config, fetchImpl: typeof fetch = fetch): LlmProvider {
  return {
    model: config.model,
    async complete(req) {
      const body = JSON.stringify({
        model: config.model,
        messages: req.messages,
        ...(req.tools?.length ? { tools: req.tools, tool_choice: "auto" } : {}),
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 1500,
        stream: true,
        ...(req.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } } } : {}),
        // Qwen-specific; ignored by other OpenAI-compatible servers.
        chat_template_kwargs: { enable_thinking: config.enableThinking },
      });

      let res: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body,
            signal: req.signal ?? AbortSignal.timeout(config.timeoutMs),
          });
          if (res.ok) break;
          if (attempt < 2 && isTransient(res.status)) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
          const text = await res.text().catch(() => "");
          console.error("[llm] request rejected", res.status, text.slice(0, 300));
          throw new AppError("PROVIDER_UNAVAILABLE", "The AI model rejected the request.");
        } catch (err) {
          if (err instanceof AppError) throw err;
          if (attempt < 2 && (req.signal?.aborted !== true)) {
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            continue;
          }
          console.error("[llm] unreachable", (err as Error).message);
          throw new AppError("PROVIDER_UNAVAILABLE", "The AI assistant is unavailable right now. Please try again shortly.");
        }
      }

      // Parse the SSE stream. No retries past this point: text may already have reached the user.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let finishReason: string | null = null;
      const calls = new Map<number, ToolCall>();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (typeof delta.content === "string" && delta.content) {
              content += delta.content;
              req.onDelta?.(delta.content);
            }
            for (const tc of delta.tool_calls ?? []) {
              const existing = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, type: "function" as const, function: { name: "", arguments: "" } };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              calls.set(tc.index, existing);
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
      } catch (err) {
        console.error("[llm] stream interrupted", (err as Error).message);
        throw new AppError("PROVIDER_UNAVAILABLE", "The AI response was interrupted. Please try again.");
      }
      return { content, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c), finishReason };
    },
  };
}

let override: LlmProvider | null = null;
let instance: LlmProvider | null | undefined;

export function getLlmProvider(): LlmProvider {
  if (override) return override;
  if (instance === undefined) {
    const config = readLlmConfig();
    instance = config ? createOpenAiCompatibleProvider(config) : null;
  }
  if (!instance) throw new AppError("NOT_CONFIGURED", "The AI assistant is not configured (LLM_BASE_URL / LLM_MODEL).");
  return instance;
}

/** Test hook. */
export function setLlmProviderForTests(p: LlmProvider | null) {
  override = p;
}

/** True when an LLM is available (configured endpoint, or a test provider). */
export function isLlmConfigured() {
  return !!override || !!readLlmConfig();
}
