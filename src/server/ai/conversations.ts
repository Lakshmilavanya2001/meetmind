import "server-only";
import { db } from "../db";
import { AppError } from "../errors";
import type { ToolMessageMeta } from "./agent";
import type { Citation } from "../services/rag";
import { planView, type PlanView } from "./plans";

type Ctx = { userId: string; organizationId: string };

export async function listConversations(ctx: Ctx, opts: { meetingRef?: string } = {}) {
  return db.agentConversation.findMany({
    where: { userId: ctx.userId, organizationId: ctx.organizationId, ...(opts.meetingRef ? { meeting: { joinCode: opts.meetingRef } } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: { id: true, title: true, updatedAt: true, meeting: { select: { title: true, joinCode: true } } },
  });
}

export type DisplayMessage =
  | { id: string; kind: "user" | "assistant"; content: string; guard?: boolean; link?: string }
  | { id: string; kind: "handoff"; agent: string; name: string; task: string; total: number }
  | { id: string; kind: "plan"; plan: PlanView }
  | { id: string; kind: "tool"; name: string; label: string; ok: boolean; summary: string; link?: string; candidates?: { id: string; displayName: string; email: string; title?: string | null }[]; citations?: Citation[]; confirmation?: { actionId: string; state: "pending" | "confirmed" | "rejected" | "failed" | "expired" } };

/** Messages shaped for the chat UI. Raw tool payloads stay server-side. */
export async function getConversationMessages(ctx: Ctx, id: string): Promise<{ id: string; title: string; meeting: { title: string; joinCode: string } | null; messages: DisplayMessage[] }> {
  const conv = await db.agentConversation.findFirst({
    where: { id, userId: ctx.userId, organizationId: ctx.organizationId },
    include: { meeting: { select: { title: true, joinCode: true } }, messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conv) throw new AppError("NOT_FOUND", "Conversation not found.");
  const pendingIds = conv.messages.map((m) => (m.metadata as ToolMessageMeta | null)?.actionId).filter((x): x is string => !!x);
  const actions = new Map(
    (await db.agentActionLog.findMany({ where: { id: { in: pendingIds } }, select: { id: true, status: true, createdAt: true } })).map((a) => [a.id, a]),
  );
  const plans = new Map((await db.agentPlan.findMany({ where: { conversationId: conv.id } })).map((p) => [p.id, planView(p)]));
  const messages = conv.messages.flatMap<DisplayMessage>((m) => {
    const meta = (m.metadata ?? {}) as ToolMessageMeta & { guard?: boolean; link?: string; decision?: string; handoff?: { agent: string; name: string; task: string; total: number } };
    if (m.role === "USER") return [{ id: m.id, kind: "user", content: m.content }];
    if (m.role === "SYSTEM" && meta.handoff) return [{ id: m.id, kind: "handoff", agent: meta.handoff.agent, name: meta.handoff.name, task: meta.handoff.task, total: meta.handoff.total }];
    if (m.role === "ASSISTANT") return m.content.trim() ? [{ id: m.id, kind: "assistant", content: m.content, guard: meta.guard, link: meta.link }] : [];
    if (m.role === "TOOL" && meta.planId && plans.has(meta.planId)) return [{ id: m.id, kind: "plan", plan: plans.get(meta.planId)! }];
    if (m.role === "TOOL") {
      let confirmation: Extract<DisplayMessage, { kind: "tool" }>["confirmation"];
      if (meta.actionId) {
        const a = actions.get(meta.actionId);
        const state =
          a?.status === "PENDING_CONFIRMATION"
            ? Date.now() - a.createdAt.getTime() > 15 * 60_000
              ? "expired"
              : "pending"
            : a?.status === "SUCCEEDED"
              ? "confirmed"
              : a?.status === "REJECTED"
                ? "rejected"
                : a?.status === "CANCELED"
                  ? "expired"
                  : "failed";
        confirmation = { actionId: meta.actionId, state };
      }
      return [{
        id: m.id,
        kind: "tool",
        name: m.toolName ?? "",
        label: meta.label ?? m.toolName ?? "",
        ok: meta.ok ?? false,
        summary: meta.summary ?? "",
        link: meta.link,
        candidates: meta.resolution?.status === "ambiguous" ? meta.resolution.candidates : undefined,
        citations: meta.citations,
        confirmation,
      }];
    }
    return [];
  });
  return { id: conv.id, title: conv.title, meeting: conv.meeting, messages };
}

export async function deleteConversation(ctx: Ctx, id: string) {
  const res = await db.agentConversation.deleteMany({ where: { id, userId: ctx.userId, organizationId: ctx.organizationId } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Conversation not found.");
}
