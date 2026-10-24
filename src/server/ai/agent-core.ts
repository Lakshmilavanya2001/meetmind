import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { ZodError } from "zod";
import { db } from "../db";
import { AppError, isAppError } from "../errors";
import type { AuthContext } from "../auth/session";
import { getAccessibleMeeting, parseMeetingRef } from "../services/meetings";
import { getLlmProvider, type ChatMessage, type ToolCall } from "./llm";
import { systemPrompt } from "./prompt";
import { TOOL_BY_NAME, toolSpecs, UNTRUSTED_OUTPUT_TOOLS, type AgentContext, type ToolDef, type ToolOutput } from "./tools";
import { findUnbackedClaims, type HistoryEntry, type SearchResolution } from "./guards";
import { routeRequest, SPECIALIST_BY_ID, type AgentId, type RouteContextLine, type RouteStep, type Specialist } from "./agents";
import { createPlan, planView, type PlanView, type ProposedStep } from "./plans";
import type { Citation } from "../services/rag";

/**
 * The building blocks of an assistant turn, shared by both orchestration engines:
 * the LangGraph graph (agent-graph.ts) and the original loop (agent.ts). Each block does one
 * step exactly as before: load the conversation, ask the coordinator, hand a task to a specialist,
 * one model round, run its tool calls (with confirmations), and finish the turn with the guards.
 */

export const MAX_ROUNDS = 6;
export const PLANNER_MAX_ROUNDS = 10; // planning needs more research steps than a single action
const HISTORY_LIMIT = 40;
const TOOL_RESULT_MAX_CHARS = 8000;
export const CONFIRMATION_TTL_MS = 15 * 60_000;

export type AgentEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "handoff"; agent: AgentId; name: string; task: string; index: number; total: number; fallback: boolean }
  | { type: "delta"; text: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary: string; link?: string; candidates?: SearchResolution["candidates"]; status?: string; citations?: Citation[] }
  | { type: "confirmation"; actionId: string; summary: string; toolName: string }
  | { type: "plan"; plan: PlanView }
  | { type: "guard"; message: string }
  | { type: "done"; conversationId: string }
  | { type: "error"; message: string };

export type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole" | "user">;

export type ToolMessageMeta = {
  label: string;
  ok: boolean;
  summary: string;
  link?: string;
  status?: "pending_confirmation" | "plan_proposed";
  actionId?: string;
  planId?: string;
  resolution?: SearchResolution | null;
  citations?: Citation[];
  errorCode?: string;
  /** The specialist that ran this step. */
  agent?: AgentId;
};

export type TurnInput = { conversationId?: string; message: string; meetingRef?: string; channel?: "text" | "voice"; /** Reply language for this turn (e.g. the language picked in a call). */ language?: string };

// ─── Conversation loading ────────────────────────────────────────────────

export async function loadConversation(ctx: Ctx, conversationId: string | undefined, meetingRef: string | undefined, firstMessage: string) {
  if (conversationId) {
    const c = await db.agentConversation.findFirst({
      where: { id: conversationId, userId: ctx.userId, organizationId: ctx.organizationId },
      include: { meeting: { select: { joinCode: true, title: true } } },
    });
    if (!c) throw new AppError("NOT_FOUND", "Conversation not found.");
    return c;
  }
  let meetingId: string | null = null;
  if (meetingRef) meetingId = (await getAccessibleMeeting(ctx, parseMeetingRef(meetingRef))).meeting.id;
  return db.agentConversation.create({
    data: { userId: ctx.userId, organizationId: ctx.organizationId, meetingId, title: firstMessage.slice(0, 80) },
    include: { meeting: { select: { joinCode: true, title: true } } },
  });
}

export type Conv = Awaited<ReturnType<typeof loadConversation>>;
export type StoredMessage = Awaited<ReturnType<typeof db.agentMessage.findMany>>[number];

/** Rebuild the model context, dropping any tool messages whose assistant call fell outside the window. */
function toChatMessages(rows: StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const openCalls = new Set<string>();
  for (const m of rows) {
    if (m.role === "USER") out.push({ role: "user", content: m.content });
    else if (m.role === "ASSISTANT") {
      const calls = (m.toolCalls as ToolCall[] | null) ?? undefined;
      calls?.forEach((c) => openCalls.add(c.id));
      out.push({ role: "assistant", content: m.content || null, ...(calls?.length ? { tool_calls: calls } : {}) });
    } else if (m.role === "TOOL" && m.toolCallId && openCalls.has(m.toolCallId)) {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  // An assistant message with tool calls must be followed by all its results; trim a dangling tail.
  while (out.length) {
    const last = out[out.length - 1];
    if (last.role === "assistant" && last.tool_calls?.length) out.pop();
    else break;
  }
  return out;
}

export function toHistory(rows: StoredMessage[]): HistoryEntry[] {
  return rows.flatMap<HistoryEntry>((m) => {
    if (m.role === "USER") return [{ role: "USER", content: m.content }];
    if (m.role === "ASSISTANT") return [{ role: "ASSISTANT", content: m.content }];
    if (m.role === "TOOL") return [{ role: "TOOL", toolName: m.toolName ?? "", resolution: (m.metadata as ToolMessageMeta | null)?.resolution ?? null }];
    return [];
  });
}

// ─── Tool execution ──────────────────────────────────────────────────────

export type ToolResultPayload = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };

export function errorPayload(err: unknown): ToolResultPayload {
  if (err instanceof ZodError) {
    return { ok: false, error: { code: "INVALID_ARGUMENTS", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
  }
  if (isAppError(err)) return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
  console.error("[agent] tool crashed", err);
  return { ok: false, error: { code: "INTERNAL", message: "The action failed due to an internal error. Nothing was changed by this step." } };
}

export async function logAction(ctx: Ctx, conversationId: string, toolName: string, args: unknown, status: "SUCCEEDED" | "FAILED" | "PENDING_CONFIRMATION", extra: { result?: unknown; error?: string; durationMs?: number; requiresConfirmation?: boolean; agent?: string } = {}) {
  return db.agentActionLog.create({
    data: {
      conversationId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      toolName,
      arguments: (args ?? {}) as Prisma.InputJsonValue,
      result: extra.result === undefined ? undefined : (JSON.parse(JSON.stringify(extra.result)) as Prisma.InputJsonValue),
      status,
      errorMessage: extra.error,
      durationMs: extra.durationMs,
      requiresConfirmation: extra.requiresConfirmation ?? false,
      agent: extra.agent,
    },
  });
}

/** Run one tool for real, with validation, logging and structured errors. Never throws. */
export async function executeTool(agentCtx: AgentContext, tool: ToolDef, rawArgs: unknown): Promise<{ payload: ToolResultPayload; output?: ToolOutput }> {
  const started = Date.now();
  try {
    const args = tool.schema.parse(rawArgs);
    const output = await tool.run(agentCtx, args);
    if (tool.kind !== "read") {
      await logAction(agentCtx.auth, agentCtx.conversationId, tool.name, args, "SUCCEEDED", { result: output.data, durationMs: Date.now() - started, agent: agentCtx.agent });
    }
    return { payload: { ok: true, data: output.data }, output };
  } catch (err) {
    const payload = errorPayload(err);
    if (tool.kind !== "read" && payload.ok === false) {
      await logAction(agentCtx.auth, agentCtx.conversationId, tool.name, rawArgs, "FAILED", { error: payload.error.message, durationMs: Date.now() - started, agent: agentCtx.agent });
    }
    return { payload };
  }
}

const truncate = (s: string) => (s.length > TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TOOL_RESULT_MAX_CHARS)}… [truncated]` : s);

// ─── Turn start: conversation, coordinator ───────────────────────────────

export type TurnStart = { conv: Conv; message: string; prior: StoredMessage[]; autoExecute: boolean; now: Date };

/** Validate, load the conversation, store the user's message. */
export async function beginTurn(ctx: Ctx, input: TurnInput, emit: (e: AgentEvent) => void, now: Date): Promise<TurnStart> {
  const message = input.message.trim();
  if (!message) throw new AppError("VALIDATION", "Type a message.");
  if (message.length > 4000) throw new AppError("VALIDATION", "Message is too long (max 4000 characters).");
  getLlmProvider(); // fail fast with NOT_CONFIGURED
  const conv = await loadConversation(ctx, input.conversationId, input.meetingRef, message);
  emit({ type: "conversation", id: conv.id, title: conv.title });
  const prior = (await db.agentMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" }, take: 30 })).reverse();
  await db.agentMessage.create({ data: { conversationId: conv.id, role: "USER", content: message } });
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { agentAutoExecute: true } });
  return { conv, message, prior, autoExecute: org.agentAutoExecute, now };
}

/** What the coordinator sees of the conversation: user and assistant text, handoffs, pending confirmations. */
function routeContext(rows: StoredMessage[]): RouteContextLine[] {
  return rows.flatMap<RouteContextLine>((m) => {
    const meta = (m.metadata ?? {}) as Partial<ToolMessageMeta> & { agent?: AgentId; handoff?: { agent: AgentId; task: string }; waiting?: RouteStep[] };
    if (m.role === "USER") return [{ role: "user", text: m.content }];
    if (m.role === "ASSISTANT" && m.content.trim()) return [{ role: "assistant", agent: meta.agent, text: m.content }];
    if (m.role === "SYSTEM" && meta.handoff) return [{ role: "handoff", agent: meta.handoff.agent, text: meta.handoff.task }];
    if (m.role === "SYSTEM" && meta.waiting) return meta.waiting.map((w) => ({ role: "waiting" as const, agent: w.agent, text: w.task }));
    if (m.role === "TOOL" && meta.status === "pending_confirmation") return [{ role: "assistant", agent: meta.agent, text: `Proposed, waiting for the user to confirm: ${meta.summary}` }];
    if (m.role === "TOOL" && meta.status === "plan_proposed") return [{ role: "assistant", agent: meta.agent, text: `Proposed a plan (${meta.label}), waiting for the user to approve it` }];
    return [];
  });
}

/** The coordinator decides which specialists handle this message, in order. */
export function coordinate(t: TurnStart) {
  return routeRequest({ message: t.message, context: routeContext(t.prior), currentMeeting: t.conv.meeting?.title ?? null });
}

// ─── Handing a task to a specialist ──────────────────────────────────────

/** The shared system prompt plus this specialist's team role. */
export async function specialistSystem(o: { ctx: Ctx; conv: Conv; spec: Specialist; task: string; teammates: string[]; channel?: "text" | "voice"; language?: string; now: Date }) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: o.ctx.organizationId }, select: { name: true } });
  const language = o.language ?? (await db.user.findUnique({ where: { id: o.ctx.userId }, select: { preferredLanguage: true } }))?.preferredLanguage;
  return systemPrompt({
    userName: o.ctx.user.displayName,
    userEmail: o.ctx.user.email,
    timezone: o.ctx.user.timezone,
    workspaceName: org.name,
    now: o.now,
    currentMeeting: o.conv.meeting ? { title: o.conv.meeting.title, code: o.conv.meeting.joinCode } : null,
    channel: o.channel,
    language,
    specialist: { name: o.spec.name, focus: o.spec.focus, task: o.task, teammates: o.teammates },
  });
}

/** Everything one specialist needs to work on its part of the turn. */
export type SpecialistRun = {
  ctx: Ctx;
  conv: Conv;
  spec: Specialist;
  system: string;
  emit: (e: AgentEvent) => void;
  autoExecute: boolean;
  channel?: "text" | "voice";
  now: Date;
  /** Set when the Planner is revising a plan after a failure. */
  revisionOf?: { id: string; revision: number };
  /** Not stored: tells this agent where its own task starts after another agent's turn. */
  handoffNote?: string;
};

/** Record and announce the handoff of step `i`, and prepare that specialist's run. */
export async function startStep(ctx: Ctx, t: TurnStart, input: TurnInput, steps: RouteStep[], fallback: boolean, i: number, emit: (e: AgentEvent) => void): Promise<SpecialistRun> {
  const step = steps[i];
  const spec = SPECIALIST_BY_ID.get(step.agent) ?? SPECIALIST_BY_ID.get("general")!;
  const handoff = { agent: spec.id, name: spec.name, task: step.task, index: i, total: steps.length, fallback };
  await db.agentMessage.create({ data: { conversationId: t.conv.id, role: "SYSTEM", content: step.task, metadata: { handoff } as unknown as Prisma.InputJsonValue } });
  emit({ type: "handoff", ...handoff });
  const teammates = steps.filter((_, j) => j !== i).map((s) => `${SPECIALIST_BY_ID.get(s.agent)?.name}: ${s.task}`);
  const system = await specialistSystem({ ctx, conv: t.conv, spec, task: step.task, teammates, channel: input.channel, language: input.language, now: t.now });
  // After another agent has worked, make the handoff explicit so this agent starts its own task
  // instead of continuing (or summarising) the previous agent's turn.
  const handoffNote = i > 0 ? `(Coordinator) ${spec.name} agent, your turn. The messages above include work by other agents; don't repeat or summarise it. Your task now: ${step.task}` : undefined;
  return { ctx, conv: t.conv, spec, system, emit, autoExecute: t.autoExecute, channel: input.channel, now: t.now, handoffNote };
}

/** The specialist needs an answer from the user: the remaining parts wait for it. */
export async function parkRemainingSteps(conv: Conv, rest: RouteStep[], emit: (e: AgentEvent) => void) {
  await db.agentMessage.create({ data: { conversationId: conv.id, role: "SYSTEM", content: "", metadata: { waiting: rest } as unknown as Prisma.InputJsonValue } });
  const note = `(${rest.map((s) => SPECIALIST_BY_ID.get(s.agent)?.name).join(", ")} will continue once you answer.)`;
  emit({ type: "delta", text: `\n\n${note}` });
  await db.agentMessage.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: note, metadata: { coordinator: true } } });
}

// ─── One specialist: model rounds and tool calls ─────────────────────────

export const maxRoundsFor = (spec: Specialist) => (spec.id === "planner" ? PLANNER_MAX_ROUNDS : MAX_ROUNDS);

/** Streaming detail: the first text of a later agent starts a new paragraph. */
export type DeltaState = { first: boolean };

/** True when this turn already produced visible assistant text (so the next agent's text starts a new paragraph). */
function turnHasText(rows: StoredMessage[]) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    if (m.role === "USER") return false;
    if (m.role === "ASSISTANT" && m.content.trim()) return true;
  }
  return false;
}

/** One model call for a specialist, with only its own tools; the reply is stored in the conversation. */
export async function modelRound(o: SpecialistRun, round: number, delta: DeltaState) {
  const rows = (await db.agentMessage.findMany({ where: { conversationId: o.conv.id }, orderBy: { createdAt: "desc" }, take: HISTORY_LIMIT })).reverse();
  const agentCtx: AgentContext = { auth: o.ctx, conversationId: o.conv.id, currentMeetingRef: o.conv.meeting?.joinCode ?? null, now: o.now, history: toHistory(rows), agent: o.spec.id };
  const context = toChatMessages(rows);
  if (round === 0 && o.handoffNote) context.push({ role: "user", content: o.handoffNote });
  const result = await getLlmProvider().complete({
    messages: [{ role: "system", content: o.system }, ...context],
    tools: toolSpecs(o.spec.tools),
    onDelta: (text) => {
      o.emit({ type: "delta", text: delta.first && turnHasText(rows) ? `\n\n${text}` : text });
      delta.first = false;
    },
  });
  await db.agentMessage.create({
    data: {
      conversationId: o.conv.id,
      role: "ASSISTANT",
      content: result.content,
      toolCalls: result.toolCalls.length ? (result.toolCalls as unknown as Prisma.InputJsonValue) : undefined,
      metadata: { agent: o.spec.id },
    },
  });
  return { content: result.content, toolCalls: result.toolCalls, agentCtx };
}

export type ToolCallsOutcome = { succeeded: string[]; paused: boolean; planId: string | null };

/**
 * Run the tool calls from one model round. Read tools run at once; sensitive ones are checked and
 * wait for the user's confirmation (unless the workspace allows auto-run for typed requests);
 * a Planner proposal becomes one plan card. Every result is stored for the next round.
 */
export async function runToolCalls(o: SpecialistRun, calls: ToolCall[], agentCtx: AgentContext, state: { paused: boolean; planId: string | null }): Promise<ToolCallsOutcome> {
  const { ctx, conv, spec, emit } = o;
  const allowed = new Set(spec.tools);
  const succeeded: string[] = [];
  let pausedForConfirmation = state.paused;
  let planId = state.planId;

  for (const call of calls) {
    const tool = allowed.has(call.function.name) ? TOOL_BY_NAME.get(call.function.name) : undefined;
    let rawArgs: unknown = {};
    try {
      rawArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      rawArgs = { __invalid_json__: call.function.arguments };
    }

    let payload: ToolResultPayload | Record<string, unknown>;
    let meta: ToolMessageMeta;

    if (!tool) {
      // Includes tools that exist but belong to another specialist.
      payload = { ok: false, error: { code: "UNKNOWN_TOOL", message: `${call.function.name} isn't available to the ${spec.name} agent. Tell the user which part you couldn't do.` } };
      meta = { label: call.function.name, ok: false, summary: "Not available to this agent", errorCode: "UNKNOWN_TOOL", agent: spec.id };
    } else if (tool.kind === "plan") {
      // The Planner's proposal becomes one plan card for a single approval.
      emit({ type: "tool_start", id: call.id, name: tool.name, label: "Checking the plan" });
      try {
        const args = tool.schema.parse(rawArgs) as { goal: string; steps: ProposedStep[] };
        const plan = await createPlan(agentCtx, args, o.revisionOf ? { parentId: o.revisionOf.id, revision: o.revisionOf.revision + 1 } : {});
        planId = plan.id;
        const view = planView(plan);
        payload = { ok: true, data: { status: "plan_proposed", planId: plan.id, steps: view.steps.map((x) => x.summary), note: "Shown to the user for approval. Nothing has been done yet. Stop here." } };
        meta = { label: `Plan: ${args.goal}`, ok: true, summary: `${view.steps.length}-step plan`, status: "plan_proposed", planId: plan.id, agent: spec.id };
        emit({ type: "tool_end", id: call.id, name: tool.name, ok: true, summary: `${view.steps.length}-step plan ready for approval` });
        emit({ type: "plan", plan: view });
      } catch (err) {
        const failed = errorPayload(err);
        payload = failed;
        const msg = failed.ok ? "" : failed.error.message;
        meta = { label: "Checking the plan", ok: false, summary: msg, errorCode: failed.ok ? undefined : failed.error.code, agent: spec.id };
        emit({ type: "tool_end", id: call.id, name: tool.name, ok: false, summary: msg });
      }
    } else if (pausedForConfirmation && tool.kind !== "sensitive") {
      // Don't run further actions while confirmations are pending; reads are harmless but pointless now.
      payload = { ok: false, error: { code: "SKIPPED", message: "Skipped: waiting for the user to confirm the pending action(s)." } };
      meta = { label: tool.name, ok: false, summary: "Skipped", errorCode: "SKIPPED", agent: spec.id };
    } else {
      let label = tool.name;
      try {
        label = tool.label(tool.schema.parse(rawArgs));
      } catch {
        /* invalid args — reported below */
      }
      emit({ type: "tool_start", id: call.id, name: tool.name, label });

      const sawUntrustedText = agentCtx.history.some((h) => h.role === "TOOL" && UNTRUSTED_OUTPUT_TOOLS.has(h.toolName));
      // Voice never auto-executes: a nearby speaker or echo could be heard as the user.
      if (tool.kind === "sensitive" && (!o.autoExecute || sawUntrustedText || o.channel === "voice")) {
        // Validate + permission-check now, but execute only after the user confirms in the UI.
        try {
          const args = tool.schema.parse(rawArgs);
          const summary = await tool.preflight!(agentCtx, args);
          const action = await logAction(ctx, conv.id, tool.name, args, "PENDING_CONFIRMATION", { requiresConfirmation: true, agent: spec.id });
          payload = { ok: true, data: { status: "awaiting_user_confirmation", summary, note: "Not done yet. The user must press Confirm." } };
          meta = { label, ok: true, summary, status: "pending_confirmation", actionId: action.id, agent: spec.id };
          pausedForConfirmation = true;
          emit({ type: "tool_end", id: call.id, name: tool.name, ok: true, summary, status: "pending_confirmation" });
          emit({ type: "confirmation", actionId: action.id, summary, toolName: tool.name });
        } catch (err) {
          const failed = errorPayload(err);
          payload = failed;
          const msg = failed.ok ? "" : failed.error.message;
          meta = { label, ok: false, summary: msg, errorCode: failed.ok ? undefined : failed.error.code, agent: spec.id };
          emit({ type: "tool_end", id: call.id, name: tool.name, ok: false, summary: msg });
        }
      } else {
        const { payload: p, output } = await executeTool(agentCtx, tool, rawArgs);
        payload = p;
        if (p.ok) succeeded.push(tool.name);
        const summary = p.ok ? output!.summary : p.error.message;
        meta = { label, ok: p.ok, summary, link: output?.link, resolution: output?.resolution ?? null, citations: output?.citations, errorCode: p.ok ? undefined : p.error.code, agent: spec.id };
        emit({ type: "tool_end", id: call.id, name: tool.name, ok: p.ok, summary, link: output?.link, candidates: output?.resolution?.status === "ambiguous" ? output.resolution.candidates : undefined, citations: output?.citations });
      }
    }

    await db.agentMessage.create({
      data: {
        conversationId: conv.id,
        role: "TOOL",
        toolCallId: call.id,
        toolName: call.function.name,
        content: truncate(JSON.stringify(payload)),
        metadata: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return { succeeded, paused: pausedForConfirmation, planId };
}

/** The specialist ran out of rounds. */
export async function roundLimitReached(o: SpecialistRun) {
  const text = "I stopped here because this request needed too many steps. Please try a more specific request.";
  o.emit({ type: "delta", text });
  await db.agentMessage.create({ data: { conversationId: o.conv.id, role: "ASSISTANT", content: text, metadata: { agent: o.spec.id } } });
}

export type SpecialistResult = { finalText: string; succeeded: string[]; paused: boolean; askedUser: boolean; planId: string | null };

/** A question near the end (often followed by a short note) means the agent is waiting for the user. */
export const askedUser = (r: { finalText: string; paused: boolean; planId: string | null }) => !r.paused && !r.planId && /\?/.test(r.finalText.trim().slice(-300));

// ─── Turn end ────────────────────────────────────────────────────────────

/** Closing notes (plan to review, actions to confirm), the claim guard, and the end of the turn. */
export async function finishTurn(ctx: Ctx, conv: Conv, input: TurnInput, o: { texts: string[]; succeeded: string[]; paused: boolean; planned: boolean }, emit: (e: AgentEvent) => void) {
  if (o.planned) {
    const text = input.channel === "voice" ? "I've put together a plan. Open the assistant panel to review and approve it; nothing happens until you do." : "Review the plan above. Nothing happens until you approve it.";
    emit({ type: "delta", text: `\n\n${text}` });
    await db.agentMessage.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: text, metadata: { coordinator: true } } });
  }
  if (o.paused) {
    const text = "Please confirm the action(s) above — nothing has been changed yet.";
    emit({ type: "delta", text: `\n\n${text}` });
    await db.agentMessage.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: text, metadata: { coordinator: true } } });
  }

  // Hallucination guard: completion claims must be backed by a successful tool call this turn.
  const finalText = o.texts.join("\n\n");
  const unbacked = findUnbackedClaims(finalText, o.succeeded);
  if (unbacked.length > 0) {
    const note = `⚠️ Correction: no ${unbacked.join(" or ")} was actually performed — nothing was changed. Please ask again if you want me to do it.`;
    emit({ type: "guard", message: note });
    await db.agentMessage.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: note, metadata: { guard: true, unbacked } } });
    await logAction(ctx, conv.id, "guard.unbacked_claim", { text: finalText.slice(0, 500), unbacked }, "FAILED", { error: "Assistant claimed an action without a successful tool call" });
  }

  await db.agentConversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
  emit({ type: "done", conversationId: conv.id });
}
