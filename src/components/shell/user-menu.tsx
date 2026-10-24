"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Building2, Check, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<{ active: string; workspaces: { id: string; name: string; role: string }[] } | null>(null);

  async function loadWorkspaces(open: boolean) {
    if (!open || workspaces) return;
    try {
      setWorkspaces(await api("/api/auth/workspaces"));
    } catch {
      /* menu still works without the switcher */
    }
  }

  async function switchTo(organizationId: string) {
    try {
      await api("/api/auth/workspaces/switch", { method: "POST", json: { organizationId } });
      setWorkspaces(null);
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch workspace");
    }
  }

  async function signOut() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } catch {
      toast.error("Could not sign out. Please try again.");
    }
  }

  return (
    <DropdownMenu onOpenChange={loadWorkspaces}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-2" aria-label="Account menu">
          <Avatar className="size-7">
            <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-40 truncate text-sm font-medium sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/profile">
            <UserRound /> Profile
          </Link>
        </DropdownMenuItem>
        {workspaces && workspaces.workspaces.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
            {workspaces.workspaces.map((w) => (
              <DropdownMenuItem key={w.id} onSelect={() => w.id !== workspaces.active && switchTo(w.id)}>
                <Building2 /> <span className="flex-1 truncate">{w.name}</span>
                {w.role === "GUEST" && <span className="text-xs text-muted-foreground">guest</span>}
                {w.id === workspaces.active && <Check aria-label="Current workspace" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light"><Sun /> Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><Moon /> Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system"><Monitor /> System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
