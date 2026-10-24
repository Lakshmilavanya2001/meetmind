import type { Metadata } from "next";
import { MessageSquareText } from "lucide-react";
import { requireAuth } from "@/server/auth/current";
import { listMySms } from "@/server/services/sms";
import { listMyEmails, mailMode } from "@/server/services/mail";
import { Mail } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesPage() {
  const ctx = await requireAuth();
  const [{ provider, messages }, emails] = await Promise.all([listMySms(ctx), listMyEmails(ctx)]);
  const emailMode = mailMode();
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title="Messages" description="Emails and text messages MeetMind has sent you: call summaries, reminders and verification codes." />
      <h2 className="text-lg font-semibold">Text messages</h2>
      {!provider && (
        <Alert>
          <MessageSquareText aria-hidden />
          <AlertTitle>Text messages aren&apos;t set up</AlertTitle>
          <AlertDescription>This server has no SMS provider (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM), so nothing can be texted. Reminders still appear in your notifications.</AlertDescription>
        </Alert>
      )}
      {provider === "outbox" && (
        <Alert>
          <MessageSquareText aria-hidden />
          <AlertTitle>Development outbox</AlertTitle>
          <AlertDescription>SMS isn&apos;t connected on this server (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM). Messages are recorded here instead of being sent to a phone (SMS_DEV_OUTBOX is on, for development only).</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent>
          {messages.length === 0 ? (
            <EmptyState icon={MessageSquareText} title="No text messages yet" />
          ) : (
            <ul className="divide-y" aria-label="Text messages">
              {messages.map((m) => (
                <li key={m.id} className="grid gap-1 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                    <span>To {m.to} · {formatDateTime(m.createdAt, ctx.user.timezone)}</span>
                    <Badge variant={m.status === "FAILED" ? "destructive" : m.status === "SENT" ? "default" : "outline"}>
                      {m.status === "OUTBOX" ? "Outbox (not sent)" : m.status === "SENT" ? "Sent" : "Failed"}
                    </Badge>
                  </div>
                  <p>{m.body}</p>
                  {m.error && <p className="text-sm text-destructive">{m.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <h2 className="mt-4 text-lg font-semibold">Emails</h2>
      {emailMode === "outbox" && (
        <Alert>
          <Mail aria-hidden />
          <AlertTitle>Development outbox</AlertTitle>
          <AlertDescription>EMAIL_DEV_OUTBOX is on, so emails are recorded here instead of being sent. In production they go out through your SMTP server.</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent>
          {emails.length === 0 ? (
            <EmptyState icon={Mail} title="No emails yet" />
          ) : (
            <ul className="divide-y" aria-label="Emails">
              {emails.map((m) => (
                <li key={m.id} className="py-3">
                  <details>
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{m.subject}</span>
                        <span className="block text-sm text-muted-foreground">To {m.to} · {formatDateTime(m.createdAt, ctx.user.timezone)}</span>
                      </span>
                      <Badge variant={m.status === "FAILED" ? "destructive" : m.status === "SENT" ? "default" : "outline"}>
                        {m.status === "OUTBOX" ? "Outbox (not sent)" : m.status === "SENT" ? "Sent" : "Failed"}
                      </Badge>
                    </summary>
                    <pre className="mt-3 rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">{m.text}</pre>
                    {m.error && <p className="mt-1 text-sm text-destructive">{m.error}</p>}
                  </details>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
