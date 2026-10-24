import "server-only";
import { escapeHtml } from "./providers/email";
import { formatRangeInZone } from "@/lib/time";

export const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "")}${path}`;

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r/g, "").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);

/** RFC 5545 calendar invite so the meeting can be added to Google/Outlook/Apple calendars. */
export function buildIcs(m: { uid: string; title: string; description?: string; start: Date; end: Date; url: string; method: "REQUEST" | "CANCEL"; sequence: number }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MeetMind//EN",
    `METHOD:${m.method}`,
    "BEGIN:VEVENT",
    `UID:${m.uid}@meetmind`,
    `SEQUENCE:${m.sequence}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(m.start)}`,
    `DTEND:${icsDate(m.end)}`,
    `SUMMARY:${icsText(m.title)}`,
    `DESCRIPTION:${icsText(`${m.description ? `${m.description}\n\n` : ""}Join: ${m.url}`)}`,
    `URL:${m.url}`,
    `STATUS:${m.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

type MeetingForEmail = { id: string; title: string; joinCode: string; description?: string | null; scheduledStart: Date | null; scheduledEnd: Date | null };

function whenLine(m: MeetingForEmail, tz: string) {
  return m.scheduledStart && m.scheduledEnd ? formatRangeInZone(m.scheduledStart, m.scheduledEnd, tz) : "Happening now";
}

export function invitationEmail(m: MeetingForEmail, o: { hostName: string; recipientTz: string; joinUrl: string; kind: "invite" | "reschedule" | "cancel" }) {
  const when = whenLine(m, o.recipientTz);
  const subject =
    o.kind === "cancel" ? `Cancelled: ${m.title}` : o.kind === "reschedule" ? `Updated: ${m.title} — ${when}` : `Invitation: ${m.title} — ${when}`;
  const lead =
    o.kind === "cancel" ? `${o.hostName} cancelled this meeting.` : o.kind === "reschedule" ? `${o.hostName} changed the time of this meeting.` : `${o.hostName} invited you to a meeting.`;
  const text = [lead, "", m.title, when, ...(o.kind === "cancel" ? [] : ["", `Join: ${o.joinUrl}`, `Meeting code: ${m.joinCode}`])].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111">
<p>${escapeHtml(lead)}</p>
<p style="font-size:16px;font-weight:600;margin:16px 0 4px">${escapeHtml(m.title)}</p>
<p style="margin:0 0 16px;color:#555">${escapeHtml(when)}</p>
${o.kind === "cancel" ? "" : `<p><a href="${escapeHtml(o.joinUrl)}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Join meeting</a></p>
<p style="color:#555">Meeting code: <code>${escapeHtml(m.joinCode)}</code></p>`}
</div>`;
  return { subject, text, html };
}
