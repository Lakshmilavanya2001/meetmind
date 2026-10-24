"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useDirectorySearch } from "@/hooks/use-directory-search";

export function DirectoryQuickSearch() {
  const [q, setQ] = useState("");
  const { users, loading, error } = useDirectorySearch(q, { limit: 5, enabled: q.trim().length > 0 });
  const active = q.trim().length > 0;

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or email"
          className="pl-8"
          aria-label="Search people"
        />
        {loading && active && <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
      </div>
      {active && (
        <ul className="grid gap-1 text-sm" aria-live="polite">
          {error && <li className="text-destructive">{error}</li>}
          {!loading && !error && users.length === 0 && <li className="text-muted-foreground">No one matches “{q}”.</li>}
          {users.map((u) => (
            <li key={u.id} className="rounded-md px-2 py-1.5 hover:bg-muted">
              <p className="font-medium">{u.displayName}</p>
              <p className="text-xs text-muted-foreground">{u.email}{u.title ? ` · ${u.title}` : ""}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
