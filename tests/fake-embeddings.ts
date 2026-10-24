import type { EmbeddingProvider } from "@/server/providers/embeddings";

/** Deterministic bag-of-words embedding (hashed into 2048 dims) — similar words → similar vectors. */
export function createFakeEmbeddings(): EmbeddingProvider & { calls: number } {
  const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
  const p: EmbeddingProvider & { calls: number } = {
    model: "fake-embed",
    dimensions: 2048,
    calls: 0,
    async embed(texts) {
      p.calls++;
      return texts.map((t) => {
        const v = new Array(2048).fill(0);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          if (w.length < 3) continue;
          let h = 0;
          for (const ch of stem(w)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % 2048] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  return p;
}
