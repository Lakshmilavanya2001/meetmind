"use client";

import { useMemo, useState } from "react";
import { Info, Loader2, Search, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/common/empty-state";
import { useDirectorySearch } from "@/hooks/use-directory-search";
import { initials } from "@/lib/format";
import { CallButtons } from "@/components/calls/call-buttons";

export function DirectoryBrowser({ currentUserId }: { currentUserId: string }) {
  const [q, setQ] = useState("");
  const { users, loading, error } = useDirectorySearch(q, { limit: 50 });

  // Flag people who share a display name so they can be told apart by email.
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const u of users) counts.set(u.displayName.toLowerCase(), (counts.get(u.displayName.toLowerCase()) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  }, [users]);

  return (
    <Card>
      <CardContent className="grid gap-4">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" className="pl-8" aria-label="Search directory" />
          {loading && <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Searching" />}
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">{error}</p>
        ) : !loading && users.length === 0 ? (
          <EmptyState icon={Users} title={q ? `No one matches “${q}”` : "No members yet"} description={q ? "Try a different spelling or search by email." : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="hidden md:table-cell">Title</TableHead>
                  <TableHead className="hidden lg:table-cell">Department</TableHead>
                  <TableHead className="hidden lg:table-cell">Time zone</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="w-20"><span className="sr-only">Call</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs">{initials(u.displayName)}</AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{u.displayName}</span>
                        {duplicateNames.has(u.displayName.toLowerCase()) && (
                          <span title="Several people share this name — check the email address." className="text-amber-600 dark:text-amber-400">
                            <Info className="size-4" aria-label="Shared name" />
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.email}</TableCell>
                    <TableCell className="hidden md:table-cell">{u.title ?? "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell">{u.department ?? "—"}</TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{u.timezone}</TableCell>
                    <TableCell>
                      <Badge variant={u.role === "MEMBER" ? "secondary" : "outline"} className="capitalize">{u.role.toLowerCase()}</Badge>
                    </TableCell>
                    <TableCell>{u.id !== currentUserId && <CallButtons userId={u.id} name={u.displayName} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
