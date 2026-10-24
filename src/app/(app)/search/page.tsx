import type { Metadata } from "next";
import { requireAuth } from "@/server/auth/current";
import { PageHeader } from "@/components/common/page-header";
import { SearchWorkspace } from "./search-workspace";

export const metadata: Metadata = { title: "Search meetings" };

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  await requireAuth();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 300) : "";
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Search meetings" description="Ask a question or search for a topic across transcripts of meetings you attended." />
      <SearchWorkspace key={q} initialQuery={q} />
    </div>
  );
}
