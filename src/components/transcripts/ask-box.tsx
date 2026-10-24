"use client";

import { useState } from "react";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api } from "@/lib/api";
import { CitationList, type CitationView } from "./citations";
import { Markdown } from "@/components/assistant/markdown";

type Answer = { answer: string; sufficientEvidence: boolean; confidence: "supported" | "partial" | "none"; citations: CitationView[]; mode: string; meetingsSearched: number };

/** Ask a question answered only from transcripts, with verified citations. */
export function AskBox({ meetings, placeholder }: { meetings?: string[]; placeholder: string }) {
  const [q, setQ] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask(question: string) {
    if (question.trim().length < 3) return;
    setPending(true);
    setError(null);
    try {
      setAnswer(await api<Answer>("/api/ask", { method: "POST", json: { question, meetings } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer");
      setAnswer(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <div className="relative flex-1">
          <MessageCircleQuestion className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="pl-8" aria-label="Question about meetings" maxLength={1000} />
        </div>
        <Button type="submit" disabled={pending || q.trim().length < 3}>
          {pending && <Loader2 className="animate-spin" aria-hidden />} Ask
        </Button>
      </form>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {answer && (
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-4" aria-live="polite">
          {answer.confidence === "none" ? (
            <p className="text-sm text-muted-foreground">{answer.answer}</p>
          ) : (
            <>
              {answer.confidence === "partial" && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">This may not fully answer your question — check the sources.</p>}
              <Markdown text={answer.answer} />
            </>
          )}
          <CitationList citations={answer.citations} />
          <p className="text-xs text-muted-foreground">
            Answered only from transcripts you can access ({answer.meetingsSearched} meeting{answer.meetingsSearched === 1 ? "" : "s"}). Quotes are checked against the transcript text.
          </p>
        </div>
      )}
    </div>
  );
}
