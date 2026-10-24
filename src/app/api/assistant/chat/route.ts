import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { isAppError } from "@/server/errors";
import { runAgentTurn, type AgentEvent } from "@/server/ai/agent";

const body = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
  meetingRef: z.string().max(300).optional(),
  // "voice": the question was spoken and the answer will be read aloud, so keep it short and plain.
  channel: z.enum(["text", "voice"]).optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
});

// POST /api/assistant/chat — streams agent events as Server-Sent Events.
export const POST = authed(async (req, ctx) => {
  rateLimit(`assistant:${ctx.userId}`, 20, 60_000);
  const input = body.parse(await readJson(req));
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: AgentEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        await runAgentTurn(ctx, input, send);
      } catch (err) {
        if (!isAppError(err)) console.error("[assistant] turn failed", err);
        send({ type: "error", message: isAppError(err) ? err.message : "Something went wrong. Please try again." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
});
