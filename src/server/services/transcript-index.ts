import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { getEmbeddingProvider, toVectorLiteral } from "../providers/embeddings";

export type ChunkInput = { startMs: number; endMs: number; speakerLabel: string; text: string };
export type BuiltChunk = { chunkIndex: number; text: string; startMs: number; endMs: number; speakerLabels: string[] };

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/**
 * Group consecutive segments into retrieval chunks of ~maxChars, overlapping by one segment so an
 * answer that spans a boundary is still retrievable. Each line keeps its timestamp and speaker.
 */
export function buildChunks(segments: ChunkInput[], maxChars = 900): BuiltChunk[] {
  const lines = segments.map((s) => ({ ...s, line: `[${clock(s.startMs)}] ${s.speakerLabel}: ${s.text}` }));
  const chunks: BuiltChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end].line.length <= maxChars)) {
      size += lines[end].line.length + 1;
      end++;
    }
    const group = lines.slice(start, end);
    chunks.push({
      chunkIndex: chunks.length,
      text: group.map((g) => g.line).join("\n"),
      startMs: group[0].startMs,
      endMs: Math.max(...group.map((g) => g.endMs)),
      speakerLabels: [...new Set(group.map((g) => g.speakerLabel))],
    });
    if (end >= lines.length) break;
    start = end - 1 > start ? end - 1 : end; // one-segment overlap
  }
  return chunks;
}

/**
 * (Re)build the search index for one meeting's transcript. Uses a compare-and-set on the
 * transcript's updatedAt so segments that arrive during indexing trigger another pass.
 */
export async function indexMeetingTranscript(meetingId: string) {
  const transcript = await db.meetingTranscript.findUnique({
    where: { meetingId },
    select: { id: true, updatedAt: true, meeting: { select: { organizationId: true, title: true, startedAt: true, scheduledStart: true } } },
  });
  if (!transcript) return { chunks: 0 };
  const startedAt = new Date();
  const segments = await db.transcriptSegment.findMany({ where: { transcriptId: transcript.id }, orderBy: [{ startMs: "asc" }, { createdAt: "asc" }] });
  const chunks = buildChunks(segments);

  let vectors: number[][] = [];
  if (chunks.length) {
    // Meeting title and date go into the embedded text (not the stored text) so meeting-level questions match.
    const when = (transcript.meeting.startedAt ?? transcript.meeting.scheduledStart)?.toISOString().slice(0, 10) ?? "";
    vectors = await getEmbeddingProvider().embed(chunks.map((c) => `Meeting: ${transcript.meeting.title} ${when}\n${c.text}`), "passage");
  }

  await db.$transaction(async (tx) => {
    await tx.transcriptChunk.deleteMany({ where: { transcriptId: transcript.id } });
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await tx.$executeRaw`
        INSERT INTO "TranscriptChunk" ("id", "transcriptId", "meetingId", "organizationId", "chunkIndex", "text", "speakerLabels", "startMs", "endMs", "embedding", "createdAt")
        VALUES (${randomUUID()}, ${transcript.id}, ${meetingId}, ${transcript.meeting.organizationId}, ${c.chunkIndex}, ${c.text}, ${c.speakerLabels}, ${c.startMs}, ${c.endMs}, ${toVectorLiteral(vectors[i])}::halfvec, now())`;
    }
    // Only mark indexed if no new segments arrived meanwhile (those reset indexedAt and bump updatedAt).
    await tx.meetingTranscript.updateMany({ where: { id: transcript.id, updatedAt: { lte: startedAt } }, data: { indexedAt: startedAt } });
  });
  return { chunks: chunks.length };
}

/** Transcripts whose search index is missing or stale (the worker rate-limits live meetings to one pass a minute). */
export async function findTranscriptsNeedingIndex(limit = 5) {
  return db.meetingTranscript.findMany({
    where: {
      indexedAt: null,
      segments: { some: {} },
      OR: [{ status: { in: ["COMPLETED", "FAILED"] } }, { updatedAt: { lt: new Date(Date.now() - 30_000) } }, { meeting: { status: "LIVE" } }],
    },
    select: { meetingId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
}
