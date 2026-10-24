"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Keyboard, Loader2, Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

// Accepts "abc-defg-hij", "abcdefghij", or a full meeting link.
function parseMeetingInput(input: string): string | null {
  const s = input.trim().toLowerCase();
  const fromLink = /\/m\/([a-z-]+)/.exec(s)?.[1];
  const raw = (fromLink ?? s).replace(/[^a-z]/g, "");
  if (raw.length !== 10) return null;
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`;
}

export function MeetingActions() {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    try {
      const { meeting } = await api<{ meeting: { joinCode: string } }>("/api/meetings", { method: "POST", json: {} });
      router.push(`/m/${meeting.joinCode}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start a meeting");
      setStarting(false);
    }
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseMeetingInput(code);
    if (!parsed) {
      setError("Enter a meeting code like abc-defg-hij, or paste a meeting link.");
      return;
    }
    router.push(`/m/${parsed}`);
  }

  return (
    <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-start">
      <Button size="lg" onClick={start} disabled={starting}>
        {starting ? <Loader2 className="animate-spin" aria-hidden /> : <Video aria-hidden />} Start a meeting
      </Button>
      <form onSubmit={join} className="flex flex-1 flex-col gap-1 sm:max-w-md">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Keyboard className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setError(null);
              }}
              placeholder="Enter a code or link"
              className="h-10 pl-8"
              aria-label="Meeting code or link"
              aria-invalid={!!error}
              aria-describedby={error ? "join-error" : undefined}
            />
          </div>
          <Button type="submit" size="lg" variant="outline" disabled={!code.trim()}>Join</Button>
        </div>
        {error && <p id="join-error" className="text-sm text-destructive" role="alert">{error}</p>}
      </form>
    </div>
  );
}
