import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatDateTime } from "@/lib/format";

export type ConflictInfo = { userId: string; displayName: string; busy: { start: string; end: string; title: string | null }[] };

export function ConflictList({ conflicts, timezone }: { conflicts: ConflictInfo[]; timezone: string }) {
  return (
    <Alert>
      <AlertTriangle aria-hidden />
      <AlertTitle>Scheduling conflict</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 grid gap-1">
          {conflicts.map((c) => (
            <li key={c.userId}>
              <span className="font-medium text-foreground">{c.displayName}</span>:{" "}
              {c.busy.map((b, i) => (
                <span key={i}>
                  {i > 0 && "; "}
                  {b.title ? `“${b.title}”` : "busy"} {formatDateTime(b.start, timezone, { timeStyle: "short", dateStyle: undefined })}–
                  {formatDateTime(b.end, timezone, { timeStyle: "short", dateStyle: undefined })}
                </span>
              ))}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs">Checked against MeetMind&apos;s calendar only; external calendars aren&apos;t connected.</p>
      </AlertDescription>
    </Alert>
  );
}
