import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAuth } from "@/server/auth/current";
import { getTranscript } from "@/server/services/transcripts";
import { getLatestSummary } from "@/server/services/summaries";
import { isAppError } from "@/server/errors";
import { isSttConfigured } from "@/server/providers/stt";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TranscriptWorkspace } from "./transcript-workspace";

export const metadata: Metadata = { title: "Transcript" };

export default async function TranscriptPage({ params, searchParams }: PageProps<"/meetings/[code]/transcript">) {
  const ctx = await requireAuth();
  const { code } = await params;
  const openSample = (await searchParams).sample === "1";
  let data, summary;
  try {
    [data, summary] = await Promise.all([getTranscript(ctx, code), getLatestSummary(ctx, code)]);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    if (isAppError(err)) return <Alert variant="destructive" className="mx-auto max-w-lg"><AlertDescription>{err.message}</AlertDescription></Alert>;
    throw err;
  }
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <Button variant="ghost" size="sm" className="w-fit" asChild>
        <Link href={`/meetings/${data.meeting.joinCode}`}><ArrowLeft aria-hidden /> {data.meeting.title}</Link>
      </Button>
      <TranscriptWorkspace initial={JSON.parse(JSON.stringify(data))} initialSummary={JSON.parse(JSON.stringify(summary))} userTimezone={ctx.user.timezone} sttConfigured={isSttConfigured()} openSample={openSample} />
    </div>
  );
}
