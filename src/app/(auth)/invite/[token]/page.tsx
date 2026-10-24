import type { Metadata } from "next";
import Link from "next/link";
import { getAuth } from "@/server/auth/current";
import { previewExternalInvitation } from "@/server/services/invitations";
import { isAppError } from "@/server/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatRangeInZone } from "@/lib/time";
import { AcceptInvitation, GuestSignupForm } from "./invite-forms";

export const metadata: Metadata = { title: "Meeting invitation" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  let preview;
  try {
    preview = await previewExternalInvitation(token);
  } catch (err) {
    if (!isAppError(err)) throw err;
    return (
      <Card>
        <CardHeader><CardTitle>Invitation unavailable</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <Alert variant="destructive"><AlertDescription>{err.message}</AlertDescription></Alert>
          <Button variant="outline" asChild><Link href="/login">Go to sign in</Link></Button>
        </CardContent>
      </Card>
    );
  }
  const auth = await getAuth();
  const m = preview.meeting;
  const when = m.scheduledStart && m.scheduledEnd ? formatRangeInZone(m.scheduledStart, m.scheduledEnd, m.timezone) : "Happening now";

  return (
    <Card>
      <CardHeader>
        <CardDescription>{m.hostName} invited you to</CardDescription>
        <CardTitle className="text-xl">{m.title}</CardTitle>
        <CardDescription>{when} · {m.workspaceName}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {auth ? (
          auth.user.email === preview.email ? (
            <AcceptInvitation token={token} />
          ) : (
            <Alert>
              <AlertDescription>
                This invitation was sent to <strong>{preview.email}</strong>, but you&apos;re signed in as {auth.user.email}. Sign out and sign in with the invited email to accept it.
              </AlertDescription>
            </Alert>
          )
        ) : preview.hasAccount ? (
          <>
            <p className="text-sm text-muted-foreground">An account already exists for {preview.email}. Sign in to accept.</p>
            <Button asChild><Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link></Button>
          </>
        ) : (
          <GuestSignupForm token={token} email={preview.email} />
        )}
      </CardContent>
    </Card>
  );
}
