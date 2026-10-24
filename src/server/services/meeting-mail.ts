import "server-only";
import { isAppError } from "../errors";
import { isEmailConfigured, sendEmail } from "../providers/email";
import { appUrl, buildIcs, invitationEmail } from "../email-templates";

export type EmailStatus = "sent" | "not_configured" | "failed";

type MeetingLike = {
  id: string;
  title: string;
  joinCode: string;
  description?: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  updatedAt?: Date;
};

/**
 * Email meeting invitations/updates. Best effort: in-app notifications are the primary channel,
 * and the per-recipient status is returned so the UI/agent can report exactly what happened.
 */
export async function emailMeetingUpdate(
  meeting: MeetingLike,
  recipients: { email: string; timezone: string; link?: string }[],
  o: { hostName: string; kind: "invite" | "reschedule" | "cancel" },
): Promise<Record<string, EmailStatus>> {
  const result: Record<string, EmailStatus> = {};
  if (!isEmailConfigured()) {
    for (const r of recipients) result[r.email] = "not_configured";
    return result;
  }
  const sequence = Math.floor((meeting.updatedAt ?? new Date()).getTime() / 1000);
  await Promise.all(
    recipients.map(async (r) => {
      const joinUrl = r.link ?? appUrl(`/m/${meeting.joinCode}`);
      const { subject, text, html } = invitationEmail(meeting, { hostName: o.hostName, recipientTz: r.timezone, joinUrl, kind: o.kind });
      const ics =
        meeting.scheduledStart && meeting.scheduledEnd
          ? buildIcs({
              uid: meeting.id,
              title: meeting.title,
              description: meeting.description ?? undefined,
              start: meeting.scheduledStart,
              end: meeting.scheduledEnd,
              url: joinUrl,
              method: o.kind === "cancel" ? "CANCEL" : "REQUEST",
              sequence,
            })
          : undefined;
      try {
        await sendEmail({ to: r.email, subject, text, html, ...(ics ? { icalEvent: { method: o.kind === "cancel" ? "CANCEL" : "REQUEST", content: ics, filename: "invite.ics" } } : {}) });
        result[r.email] = "sent";
      } catch (err) {
        result[r.email] = isAppError(err) && err.code === "NOT_CONFIGURED" ? "not_configured" : "failed";
      }
    }),
  );
  return result;
}
