import { CalendarDays, Presentation, LayoutDashboard, ListChecks, MessageSquareText, Search, Settings, Sparkles, UserRound, Users, Video } from "lucide-react";

type Role = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";

const ALL_NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, guest: true },
  { href: "/meetings", label: "Meetings", icon: Video, guest: true },
  { href: "/calendar", label: "Calendar", icon: CalendarDays, guest: true },
  { href: "/assistant", label: "Assistant", icon: Sparkles, guest: true },
  { href: "/tasks", label: "Tasks", icon: ListChecks, guest: true },
  { href: "/demos", label: "Demos", icon: Presentation, guest: false },
  { href: "/search", label: "Search", icon: Search, guest: true },
  { href: "/directory", label: "Directory", icon: Users, guest: false },
] as const;

const ALL_SETTINGS = [
  { href: "/settings/profile", label: "Profile", icon: UserRound, guest: true },
  { href: "/settings/messages", label: "Messages", icon: MessageSquareText, guest: true },
  { href: "/settings/workspace", label: "Workspace", icon: Settings, guest: false },
] as const;

export type NavItem = (typeof ALL_NAV)[number] | (typeof ALL_SETTINGS)[number];

export const navFor = (role: Role) => ({
  main: ALL_NAV.filter((i) => role !== "GUEST" || i.guest),
  settings: ALL_SETTINGS.filter((i) => role !== "GUEST" || i.guest),
});
