import { z } from "zod";
import { authed } from "@/server/http";
import { exportTranscript } from "@/server/services/transcripts";

export const GET = authed<{ ref: string }>(async (req, ctx, { ref }) => {
  const { format } = z.object({ format: z.enum(["txt", "vtt", "srt", "json"]).default("txt") }).parse(Object.fromEntries(req.nextUrl.searchParams));
  const file = await exportTranscript(ctx, ref, format);
  return new Response(file.body, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "no-store",
    },
  });
});
