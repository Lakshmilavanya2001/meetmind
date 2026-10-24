"use client";

import { useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useDirectorySearch, type DirectoryUser } from "@/hooks/use-directory-search";

/**
 * Pick workspace members. Results always show the email so people who share a name
 * (e.g. two "Rahul Sharma"s) can be told apart; nothing is auto-selected.
 */
export function PeoplePicker({
  selected,
  onChange,
  excludeIds = [],
  id = "people",
  placeholder = "Add people by name or email",
}: {
  selected: DirectoryUser[];
  onChange: (users: DirectoryUser[]) => void;
  excludeIds?: string[];
  id?: string;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const active = q.trim().length > 0;
  const { users, loading } = useDirectorySearch(q, { limit: 8, enabled: active });
  const hidden = new Set([...excludeIds, ...selected.map((s) => s.id)]);
  const results = users.filter((u) => !hidden.has(u.id));
  const sameName = (u: DirectoryUser) => users.filter((x) => x.displayName.toLowerCase() === u.displayName.toLowerCase()).length > 1;

  return (
    <div className="grid gap-2">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected people">
          {selected.map((u) => (
            <li key={u.id}>
              <Badge variant="secondary" className="gap-1 py-1 pr-1">
                <span>{u.displayName}</span>
                <span className="text-muted-foreground">· {u.email}</span>
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((s) => s.id !== u.id))}
                  className="rounded-sm p-0.5 hover:bg-muted-foreground/20"
                  aria-label={`Remove ${u.displayName} (${u.email})`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="pl-8" autoComplete="off" />
        {loading && active && <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
      </div>
      {active && (
        <ul className="max-h-56 overflow-y-auto rounded-md border" role="listbox" aria-label="Matching people">
          {!loading && results.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matching members.</li>}
          {results.map((u) => (
            <li key={u.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                onClick={() => {
                  onChange([...selected, u]);
                  setQ("");
                }}
              >
                <span className="min-w-0">
                  <span className="font-medium">{u.displayName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {u.email}
                    {u.title ? ` · ${u.title}` : ""}
                    {u.department ? ` · ${u.department}` : ""}
                  </span>
                </span>
                {sameName(u) && <Badge variant="outline" className="shrink-0 text-amber-700 dark:text-amber-400">Same name</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
