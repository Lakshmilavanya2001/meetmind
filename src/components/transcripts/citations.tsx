import Link from "next/link";
import { Quote } from "lucide-react";
import { cn } from "@/lib/utils";

export type CitationView = { n: number; meetingTitle: string; meetingCode: string; meetingDate: string | null; startMs: number; speaker: string | null; quote: string };

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Numbered, verified sources; each opens the transcript at the cited moment. */
export function CitationList({ citations, dark = false, className }: { citations: CitationView[]; dark?: boolean; className?: string }) {
  if (citations.length === 0) return null;
  return (
    <ol className={cn("grid gap-2", className)} aria-label="Sources">
      {citations.map((c) => (
        <li key={`${c.n}-${c.meetingCode}-${c.startMs}`}>
          <Link
            href={`/meetings/${c.meetingCode}/transcript#t=${c.startMs}`}
            className={cn(
              "flex gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
              dark ? "border-white/15 hover:bg-white/5" : "hover:bg-muted/60",
            )}
          >
            <span className="font-semibold text-primary">[{c.n}]</span>
            <span className="min-w-0">
              <span className="block font-medium">
                {c.meetingTitle}
                <span className={cn("font-normal", dark ? "text-white/60" : "text-muted-foreground")}>
                  {c.meetingDate ? ` · ${c.meetingDate.slice(0, 10)}` : ""} · {clock(c.startMs)}{c.speaker ? ` · ${c.speaker}` : ""}
                </span>
              </span>
              <span className={cn("mt-0.5 flex gap-1 italic", dark ? "text-white/80" : "text-foreground/80")}>
                <Quote className="mt-0.5 size-3 shrink-0 opacity-50" aria-hidden />“{c.quote}”
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
