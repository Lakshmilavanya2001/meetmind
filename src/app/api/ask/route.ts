import { z } from "zod";
import { authed, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { answerQuestion } from "@/server/services/rag";

// POST /api/ask — { question, meetings?: string[], from?, to? } → grounded answer with verified citations.
export const POST = authed(async (req, ctx) => {
  rateLimit(`ask:${ctx.userId}`, 20, 60_000);
  const input = z
    .object({
      question: z.string().trim().min(3).max(1000),
      meetings: z.array(z.string().max(300)).max(10).optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    })
    .parse(await readJson(req));
  return answerQuestion(ctx, { question: input.question, meetings: input.meetings, from: input.from ? new Date(input.from) : undefined, to: input.to ? new Date(input.to) : undefined });
});
