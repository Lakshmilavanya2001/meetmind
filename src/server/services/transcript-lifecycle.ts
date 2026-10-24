import "server-only";
import { db } from "../db";

/**
 * Mark a meeting's transcript COMPLETED once the meeting is over and no audio is still being
 * processed. Applies the workspace retention policy. Safe to call repeatedly.
 */
export async function finalizeTranscriptIfIdle(meetingId: string) {
  const meeting = await db.meeting.findUnique({
    where: { id: meetingId },
    select: { status: true, organization: { select: { transcriptRetentionDays: true } }, transcript: { select: { id: true, status: true } } },
  });
  if (!meeting?.transcript || meeting.status === "LIVE" || meeting.status === "SCHEDULED") return;
  if (meeting.transcript.status === "COMPLETED") return;
  const pending = await db.transcriptionJob.count({ where: { meetingId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (pending > 0) return;
  const [segments, failed] = await Promise.all([
    db.transcriptSegment.count({ where: { meetingId } }),
    db.transcriptionJob.count({ where: { meetingId, status: "FAILED" } }),
  ]);
  const days = meeting.organization.transcriptRetentionDays;
  await db.meetingTranscript.update({
    where: { id: meeting.transcript.id },
    data: {
      status: segments === 0 && failed > 0 ? "FAILED" : "COMPLETED",
      error: failed > 0 ? `${failed} audio chunk(s) could not be transcribed.` : null,
      expiresAt: days ? new Date(Date.now() + days * 86400_000) : null,
    },
  });
}
