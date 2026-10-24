import { Timer } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { getLatencyReport } from "@/server/services/interpretation";

type Report = Awaited<ReturnType<typeof getLatencyReport>>;
const s = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(2)} s`);

/** End-to-end latency of the AI interpreter in this meeting: end of speech → translated speech starts. */
export function LatencyCard({ report }: { report: Report }) {
  const o = report.overall;
  if (!o.count) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Timer className="size-4" aria-hidden /> AI interpreter latency</CardTitle>
        <CardDescription>From the moment a speaker stopped talking to the moment the listener started hearing the translation, measured on the server for every line ({o.count} lines).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Latency summary">
          {[["Average", o.avgMs], ["Median", o.p50Ms], ["95th percentile", o.p95Ms], ["Slowest", o.maxMs]].map(([label, v]) => (
            <div key={label as string} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-xl font-semibold tabular-nums">{s(v as number | null)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted-foreground">
          Average breakdown: speech recognition {s(o.avgAsrMs)} · translation {s(o.avgMtMs)} · voice {s(o.avgTtsMs)} · waiting {s(o.avgQueueMs)} (plus the pause that marks the end of a sentence, included in recognition).
        </p>
        <table className="w-full text-sm">
          <caption className="sr-only">Latency by language pair</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="py-1 font-medium">Direction</th><th className="font-medium">Lines</th><th className="font-medium">Average</th><th className="font-medium">95th pct.</th></tr>
          </thead>
          <tbody className="tabular-nums">
            {report.byPair.map((p) => (
              <tr key={p.pair} className="border-t"><td className="py-1.5">{p.pair}</td><td>{p.count}</td><td>{s(p.avgMs)}</td><td>{s(p.p95Ms)}</td></tr>
            ))}
          </tbody>
        </table>
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">Recent lines</summary>
          <ul className="mt-2 grid gap-2 text-sm">
            {report.recent.slice(0, 15).map((r, i) => (
              <li key={i} className="rounded-md border px-3 py-2">
                <p className="text-xs text-muted-foreground">{r.source} → {r.target} · {s(r.totalMs)} (recognition {s(r.asrMs)}, translation {s(r.mtMs)}, voice {s(r.ttsMs)})</p>
                <p>{r.original}</p>
                <p className="text-muted-foreground">{r.translated}</p>
              </li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
