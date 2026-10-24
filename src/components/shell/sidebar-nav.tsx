"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { navFor, type NavItem } from "./nav-items";

export function SidebarNav({ onNavigate, role }: { onNavigate?: () => void; role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST" }) {
  const pathname = usePathname();
  const { main, settings } = navFor(role);
  const item = ({ href, label, icon: Icon }: NavItem) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          active && "bg-sidebar-accent text-sidebar-foreground",
        )}
      >
        <Icon className={cn("size-4", active && "text-sidebar-primary")} aria-hidden />
        {label}
      </Link>
    );
  };
  return (
    <nav className="flex flex-1 flex-col gap-6 px-3" aria-label="Main">
      <div className="grid gap-1">{main.map(item)}</div>
      <div className="grid gap-1">
        <p className="px-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Settings</p>
        {settings.map(item)}
      </div>
    </nav>
  );
}
