import "server-only";
import { AppError } from "../errors";

/** Text embedding provider. Vectors must have exactly `dimensions` entries (the DB column is fixed-size). */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

type Config = { baseUrl: string; model: string; dimensions: number; apiKey?: string; queryPrefix: string; passagePrefix: string; batchSize: number };

export function readEmbeddingConfig(env: Record<string, string | undefined> = process.env): Config | null {
  if (!env.EMBEDDING_BASE_URL || !env.EMBEDDING_MODEL) return null;
  return {
    baseUrl: env.EMBEDDING_BASE_URL.replace(/\/$/, ""),
    model: env.EMBEDDING_MODEL,
    dimensions: Number(env.EMBEDDING_DIMENSIONS || 2048),
    apiKey: env.EMBEDDING_API_KEY,
    // Some models want "query: " / "passage: " prefixes; nemotron-embed retrieved better without (measured).
    queryPrefix: env.EMBEDDING_QUERY_PREFIX ?? "",
    passagePrefix: env.EMBEDDING_PASSAGE_PREFIX ?? "",
    batchSize: Number(env.EMBEDDING_BATCH_SIZE || 32),
  };
}

export class TransientEmbeddingError extends Error {}

export function createOpenAiEmbeddingProvider(config: Config, fetchImpl: typeof fetch = fetch): EmbeddingProvider {
  async function call(input: string[]) {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify({ model: config.model, input }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        throw new TransientEmbeddingError(`Embedding service unreachable: ${(err as Error).message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (res.status === 429 || res.status >= 500) throw new TransientEmbeddingError(`Embedding service error ${res.status}`);
      if (!res.ok) throw new AppError("PROVIDER_UNAVAILABLE", `Embedding request rejected (${res.status}).`);
      const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const vectors = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (vectors.length !== input.length || vectors.some((v) => v.length !== config.dimensions)) {
        throw new AppError("PROVIDER_UNAVAILABLE", `Embedding model returned unexpected dimensions (expected ${config.dimensions}).`);
      }
      return vectors;
    }
  }
  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts, kind) {
      const prefix = kind === "query" ? config.queryPrefix : config.passagePrefix;
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += config.batchSize) out.push(...(await call(texts.slice(i, i + config.batchSize).map((t) => prefix + t))));
      return out;
    },
  };
}

let override: EmbeddingProvider | null = null;
let instance: EmbeddingProvider | null | undefined;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (override) return override;
  if (instance === undefined) {
    const c = readEmbeddingConfig();
    instance = c ? createOpenAiEmbeddingProvider(c) : null;
  }
  if (!instance) throw new AppError("NOT_CONFIGURED", "Transcript search is not configured (EMBEDDING_BASE_URL / EMBEDDING_MODEL).");
  return instance;
}

export const isEmbeddingConfigured = () => !!override || readEmbeddingConfig() !== null;

export function setEmbeddingProviderForTests(p: EmbeddingProvider | null) {
  override = p;
}

/** pgvector literal, e.g. "[0.1,0.2]". */
export const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
