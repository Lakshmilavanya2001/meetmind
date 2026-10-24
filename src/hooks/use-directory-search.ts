"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type DirectoryUser = {
  id: string;
  displayName: string;
  email: string;
  title: string | null;
  department: string | null;
  timezone: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
};

/** Debounced directory search against /api/users. Stale responses are discarded. */
export function useDirectorySearch(query: string, { limit = 20, enabled = true } = {}) {
  const [result, setResult] = useState<{ query: string; users: DirectoryUser[]; error: string | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api<{ users: DirectoryUser[] }>(
          `/api/users?q=${encodeURIComponent(query)}&limit=${limit}`,
        );
        if (!cancelled) setResult({ query, users: res.users, error: null });
      } catch (e) {
        if (!cancelled) setResult({ query, users: [], error: e instanceof Error ? e.message : "Search failed" });
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, limit, enabled]);

  const fresh = result?.query === query;
  return {
    users: result?.users ?? [],
    loading: enabled && !fresh,
    error: fresh ? result.error : null,
  };
}
