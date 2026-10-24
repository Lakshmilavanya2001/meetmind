import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth } from "@/server/auth/current";
import { PageHeader } from "@/components/common/page-header";
import { DirectoryBrowser } from "./directory-browser";

export const metadata: Metadata = { title: "Directory" };

export default async function DirectoryPage() {
  const ctx = await requireAuth();
  if (ctx.orgRole === "GUEST") redirect("/dashboard");
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Directory" description="Everyone in your workspace. Only members of this workspace can be invited to its meetings." />
      <DirectoryBrowser currentUserId={ctx.userId} />
    </div>
  );
}
