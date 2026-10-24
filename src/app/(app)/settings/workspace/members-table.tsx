"use client";

import { useRouter } from "next/navigation";
import { UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import type { DirectoryUser } from "@/hooks/use-directory-search";

type Role = DirectoryUser["role"];

export function MembersTable({ members, currentUserId, myRole }: { members: DirectoryUser[]; currentUserId: string; myRole: Role }) {
  const router = useRouter();
  const isAdmin = myRole === "OWNER" || myRole === "ADMIN";
  // Mirrors the server rule; the server enforces it regardless.
  const canManage = (m: DirectoryUser) => isAdmin && m.id !== currentUserId && (m.role !== "OWNER" || myRole === "OWNER");
  const roleOptions: Role[] = myRole === "OWNER" ? ["OWNER", "ADMIN", "MEMBER"] : ["ADMIN", "MEMBER"];

  async function changeRole(userId: string, role: Role) {
    try {
      await api(`/api/workspace/members/${userId}`, { method: "PATCH", json: { role } });
      toast.success("Role updated");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change role");
    }
  }

  async function remove(userId: string) {
    try {
      await api(`/api/workspace/members/${userId}`, { method: "DELETE" });
      toast.success("Member removed");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove member");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Members</CardTitle>
        <CardDescription>{isAdmin ? "Change roles or remove people from the workspace." : "People in this workspace."}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Email</TableHead>
              <TableHead>Role</TableHead>
              {isAdmin && <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">
                  {m.displayName}
                  {m.id === currentUserId && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                  <p className="text-xs font-normal text-muted-foreground sm:hidden">{m.email}</p>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{m.email}</TableCell>
                <TableCell>
                  {canManage(m) && m.role !== "GUEST" ? (
                    <Select value={m.role} onValueChange={(r) => changeRole(m.id, r as Role)}>
                      <SelectTrigger size="sm" className="w-28" aria-label={`Role for ${m.displayName}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {roleOptions.map((r) => <SelectItem key={r} value={r} className="capitalize">{r.toLowerCase()}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="secondary" className="capitalize">{m.role.toLowerCase()}</Badge>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell>
                    {canManage(m) && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Remove ${m.displayName}`}><UserMinus /></Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove {m.displayName}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {m.email} will lose access to this workspace and its meetings immediately and be signed out.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => remove(m.id)}>Remove</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
