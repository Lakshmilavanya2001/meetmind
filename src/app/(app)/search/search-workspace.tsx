"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/common/empty-state";
import { Markdown } from "@/components/assistant/markdown";
import { CitationList, clock, type CitationView } from "@/components/transcripts/citations";
import { api } from "@/lib/api";

type Hit = { meetingTitle: string; meetingCode: string; meetingDate: string | null; startMs: number; text: string };
type Answer = { answer: string; sufficientEvidence: boolean; confidence: "supported" | "partial" | "none"; citations: CitationView[]; meetingsSearched: number };

const RANGES = [
  { key: "all", label: "Any time", days: null },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
] as const;

export function SearchWorkspace({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
  const [pending, setPending] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (query: string, rangeKey: string) => {
      if (query.trim().length < 2) return;
      setPending(true);
      setError(null);
      const days = RANGES.find((r) => r.key === rangeKey)?.days;
      const from = days ? new Date(Date.now() - days * 86400_000).toISOString() : undefined;
      try {
        const [s, a] = await Promise.all([
          api<{ results: Hit[] }>(`/api/search?q=${encodeURIComponent(query)}${from ? `&from=${encodeURIComponent(from)}` : ""}`),
          query.trim().length >= 3 ? api<Answer>("/api/ask", { method: "POST", json: { question: query, from } }) : Promise.resolve(null),
        ]);
        setHits(s.results);
        setAnswer(a);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setPending(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (initialQuery) {
      const t = setTimeout(() => run(initialQuery, "all"), 0);
      return () => clearTimeout(t);
    }
  }, [initialQuery, run]);

  return (
    <div className="grid gap-4">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          router.replace(`/search?q=${encodeURIComponent(q)}`, { scroll: false });
          run(q, range);
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. What deadline did we agree on for the API integration?" className="h-10 pl-8" aria-label="Search meetings" maxLength={300} autoFocus />
        </div>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as typeof range)}
          aria-label="Time range"
          className="h-10 rounded-md border border-input bg-transparent px-3 text-sm dark:bg-input/30"
        >
          {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <Button type="submit" size="lg" disabled={pending || q.trim().length < 2}>
          {pending && <Loader2 className="animate-spin" aria-hidden />} Search
        </Button>
      </form>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {answer && (
        <Card role="region" aria-labelledby="answer-heading">
          <CardHeader><CardTitle><h2 id="answer-heading" className="text-base">Answer</h2></CardTitle></CardHeader>
          <CardContent className="grid gap-3">
          {answer.confidence === "none" ? (
            <p className="text-sm text-muted-foreground">{answer.answer}</p>
          ) : (
            <>
              {answer.confidence === "partial" && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">This may not fully answer your question — check the sources.</p>}
              <Markdown text={answer.answer} />
            </>
          )}
            <CitationList citations={answer.citations} />
            <p className="text-xs text-muted-foreground">Generated only from transcripts you can access. Every quote is checked against the transcript; unverifiable statements are removed.</p>
          </CardContent>
        </Card>
      )}

      {hits && (
        <Card role="region" aria-labelledby="passages-heading">
          <CardHeader><CardTitle><h2 id="passages-heading" className="text-base">Matching passages</h2></CardTitle></CardHeader>
          <CardContent>
            {hits.length === 0 ? (
              <EmptyState icon={Search} title="No matching passages" description="Only meetings with transcripts that you attended are searched." />
            ) : (
              <ul className="grid gap-3">
                {hits.map((h, i) => (
                  <li key={i}>
                    <Link href={`/meetings/${h.meetingCode}/transcript#t=${h.startMs}`} className="block rounded-md border p-3 hover:bg-muted/50">
                      <p className="text-sm font-medium">{h.meetingTitle} <span className="font-normal text-muted-foreground">· {h.meetingDate?.slice(0, 10)} · {clock(h.startMs)}</span></p>
                      <p className="mt-1 line-clamp-4 text-sm whitespace-pre-line text-muted-foreground">{h.text}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
