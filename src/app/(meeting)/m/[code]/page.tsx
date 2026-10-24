import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { requireAuth } from "@/server/auth/current";
import { getAccessibleMeeting } from "@/server/services/meetings";
import { isAppError } from "@/server/errors";
import { db } from "@/server/db";
import { Button } from "@/components/ui/button";
import { MeetingClient } from "@/components/meeting/meeting-client";

export const metadata: Metadata = { title: "Meeting" };

export default async function MeetingPage({ params, searchParams }: PageProps<"/m/[code]">) {
  const ctx = await requireAuth();
  const { code } = await params;
  const autoJoin = (await searchParams).join === "1";
  let data;
  try {
    data = await getAccessibleMeeting(ctx, code);
  } catch (err) {
    if (!isAppError(err)) throw err;
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
        <AlertTriangle className="size-10 text-destructive" aria-hidden />
        <h1 className="text-xl font-semibold">Can&apos;t open this meeting</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{err.message}</p>
        <Button asChild><Link href="/dashboard">Back to dashboard</Link></Button>
      </main>
    );
  }
  const { meeting, myRole } = data;
  const prefs = await db.user.findUnique({ where: { id: ctx.userId }, select: { preferredLanguage: true } });
  return (
    <MeetingClient
      meeting={{
        id: meeting.id,
        title: meeting.title,
        joinCode: meeting.joinCode,
        status: meeting.status,
        hostName: meeting.host.displayName,
        transcriptionEnabled: meeting.transcriptionEnabled,
        recordingEnabled: meeting.recordingEnabled,
        callType: meeting.callType,
        isDirectCall: meeting.isDirectCall,
      }}
      autoJoin={autoJoin && meeting.status !== "ENDED"}
      me={{ id: ctx.userId, displayName: ctx.user.displayName, role: myRole, language: prefs?.preferredLanguage ?? "en" }}
    />
  );
}
