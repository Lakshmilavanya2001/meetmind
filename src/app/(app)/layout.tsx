import { requireAuth } from "@/server/auth/current";
import { db } from "@/server/db";
import { AppShell } from "@/components/shell/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAuth();
  const org = await db.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { name: true },
  });
  return (
    <AppShell user={ctx.user} workspaceName={org.name} orgRole={ctx.orgRole}>
      {children}
    </AppShell>
  );
}
