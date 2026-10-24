import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth } from "@/server/auth/current";
import { getWorkspace } from "@/server/services/organization";
import { searchDirectory } from "@/server/services/directory";
import { PageHeader } from "@/components/common/page-header";
import { WorkspaceSettings } from "./workspace-settings";
import { MembersTable } from "./members-table";
import { IntegrationsCard } from "./integrations-card";

export const metadata: Metadata = { title: "Workspace" };

export default async function WorkspacePage() {
  const ctx = await requireAuth();
  if (ctx.orgRole === "GUEST") redirect("/dashboard");
  const isAdmin = ctx.orgRole === "OWNER" || ctx.orgRole === "ADMIN";
  const [workspace, members] = await Promise.all([getWorkspace(ctx), searchDirectory(ctx, "", 50, { includeGuests: isAdmin })]);
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <PageHeader title="Workspace" description={isAdmin ? "Manage who can join, what the AI assistant may do, and data retention." : "Workspace details. Only admins can change these settings."} />
      <WorkspaceSettings workspace={workspace} canEdit={isAdmin} />
      <MembersTable members={members} currentUserId={ctx.userId} myRole={ctx.orgRole} />
      {isAdmin && <IntegrationsCard />}
    </div>
  );
}
