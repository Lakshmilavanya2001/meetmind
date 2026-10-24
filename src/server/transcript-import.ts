// Parse uploaded transcripts (WebVTT, SRT, or plain "Speaker: text" lines) into timed segments.

export type ImportedSegment = { startMs: number; endMs: number; speaker: string | null; text: string };

const TS = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;

export function parseTimestamp(s: string): number | null {
  const m = TS.exec(s.trim());
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  return ((Number(h ?? 0) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number((frac ?? "0").padEnd(3, "0"));
}

/** "<v Rahul Sharma>text</v>" (VTT voice tags) or "Rahul Sharma: text". Speaker names are capped at 6 words. */
function splitSpeaker(line: string): { speaker: string | null; text: string } {
  // Linear-time patterns: no overlapping quantifiers, so adversarial input can't trigger backtracking blow-ups.
  const voice = /^<v(?:\.[^ >]*)? ([^<>]*)>(.*?)(?:<\/v>)?$/.exec(line);
  if (voice) return { speaker: voice[1].trim(), text: voice[2].trim() };
  const colon = /^([A-Z][\w.'-]*(?:\s+[\w.'-]+){0,5}):\s+(.+)$/.exec(line);
  if (colon) return { speaker: colon[1].trim(), text: colon[2].trim() };
  return { speaker: null, text: line.trim() };
}

const stripTags = (s: string) => s.replace(/<(?!v[\s.])[^<>]*>/g, "");

function parseCues(text: string): ImportedSegment[] {
  const out: ImportedSegment[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx].split("-->");
    const startMs = parseTimestamp(a);
    const endMs = parseTimestamp(b.trim().split(/\s+/)[0]);
    if (startMs === null || endMs === null) continue;
    const body = stripTags(lines.slice(timeIdx + 1).join(" ")).trim();
    if (!body) continue;
    const { speaker, text: t } = splitSpeaker(body);
    out.push({ startMs, endMs: Math.max(endMs, startMs), speaker, text: stripTags(t).replace(/<\/?v[^>]*>/g, "").trim() });
  }
  return out;
}

/**
 * Plain text: one utterance per line, optionally "[00:01:23] Name: text" or "Name: text".
 * Lines without timestamps are spaced 5 s apart so ordering is preserved (marked as approximate by the caller).
 */
function parsePlain(text: string): { segments: ImportedSegment[]; approximateTimes: boolean } {
  const segments: ImportedSegment[] = [];
  let approximate = false;
  let clock = 0;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    let startMs: number | null = null;
    const ts = /^\[?\(?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\)?\s*[-–]?\s*/.exec(line);
    if (ts) {
      startMs = parseTimestamp(ts[1]);
      line = line.slice(ts[0].length);
    }
    if (startMs === null) {
      approximate = true;
      startMs = clock;
    }
    const { speaker, text: t } = splitSpeaker(line);
    if (!t) continue;
    segments.push({ startMs, endMs: startMs, speaker, text: t });
    clock = startMs + 5000;
  }
  // End each segment where the next begins.
  for (let i = 0; i < segments.length; i++) segments[i].endMs = segments[i + 1]?.startMs ?? segments[i].startMs + 5000;
  return { segments, approximateTimes: approximate };
}

const MAX_LINE = 5000;

export function parseTranscriptFile(content: string, fileName = ""): { format: "vtt" | "srt" | "text"; segments: ImportedSegment[]; approximateTimes: boolean } {
  // Strip a byte-order mark and cap line length so no single line can make parsing expensive.
  const text = content
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l))
    .join("\n");
  if (/^WEBVTT/.test(text.trimStart()) || fileName.toLowerCase().endsWith(".vtt")) return { format: "vtt", segments: parseCues(text), approximateTimes: false };
  if (/-->/.test(text)) return { format: "srt", segments: parseCues(text), approximateTimes: false };
  return { format: "text", ...parsePlain(text) };
}
