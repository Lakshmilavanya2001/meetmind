import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { SidebarNav } from "./sidebar-nav";
import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import { NotificationsBell } from "./notifications-bell";
import { AssistantLauncher } from "@/components/assistant/assistant-launcher";
import { IncomingCallWatcher } from "@/components/calls/incoming-call";

export function AppShell({
  user,
  workspaceName,
  orgRole,
  children,
}: {
  user: { displayName: string; email: string };
  workspaceName: string;
  orgRole: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar md:flex">
        <Link href="/dashboard" className="px-6 py-5">
          <Logo />
        </Link>
        <SidebarNav role={orgRole} />
        <div className="border-t px-6 py-4 text-xs text-muted-foreground">
          <p className="truncate font-medium text-foreground">{workspaceName}</p>
          <p className="capitalize">{orgRole.toLowerCase()}</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6">
          <MobileNav role={orgRole} />
          <span className="truncate text-sm font-medium md:hidden">{workspaceName}</span>
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex">{workspaceName}{orgRole === "GUEST" ? " · guest" : ""}</Badge>
            <AssistantLauncher />
            <NotificationsBell />
            <UserMenu name={user.displayName} email={user.email} />
          </div>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        <IncomingCallWatcher />
      </div>
    </div>
  );
}
