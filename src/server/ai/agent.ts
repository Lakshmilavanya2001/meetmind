import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { AppError } from "../errors";
import { TOOL_BY_NAME, type AgentContext } from "./tools";
import { SPECIALIST_BY_ID } from "./agents";
import { executePlan, MAX_REVISIONS, PLAN_TTL_MS, planView, type PlanStep, type PlanView } from "./plans";
import {
  askedUser,
  beginTurn,
  CONFIRMATION_TTL_MS,
  coordinate,
  errorPayload,
  finishTurn,
  maxRoundsFor,
  modelRound,
  parkRemainingSteps,
  roundLimitReached,
  runToolCalls,
  specialistSystem,
  startStep,
  toHistory,
  type AgentEvent,
  type Ctx,
  type SpecialistResult,
  type SpecialistRun,
  type ToolMessageMeta,
  type TurnInput,
} from "./agent-core";
import { runSpecialistWithGraph, runTurnWithGraph } from "./agent-graph";

export { CONFIRMATION_TTL_MS, executeTool, toHistory } from "./agent-core";
export type { AgentEvent, ToolMessageMeta, ToolResultPayload } from "./agent-core";

/**
 * The assistant. A turn is orchestrated by LangGraph (agent-graph.ts): coordinator → specialist
 * (model ↔ tools) → next specialist → finish. `AGENT_ENGINE=classic` switches to the original
 * loop below, which runs the same steps (agent-core.ts) in plain TypeScript.
 */
export type AgentEngine = "langgraph" | "classic";
export const agentEngine = (): AgentEngine => (process.env.AGENT_ENGINE === "classic" ? "classic" : "langgraph");

export async function runAgentTurn(ctx: Ctx, input: TurnInput, emit: (e: AgentEvent) => void, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return agentEngine() === "classic" ? runTurnClassic(ctx, input, emit, now) : runTurnWithGraph(ctx, input, emit, now);
}

const runSpecialist = (o: SpecialistRun) => (agentEngine() === "classic" ? runSpecialistClassic(o) : runSpecialistWithGraph(o));

// ─── The original loop ───────────────────────────────────────────────────

async function runTurnClassic(ctx: Ctx, input: TurnInput, emit: (e: AgentEvent) => void, now: Date) {
  const t = await beginTurn(ctx, input, emit, now);
  const route = await coordinate(t);
  const succeeded: string[] = [];
  const texts: string[] = [];
  let paused = false;
  let planned = false;
  for (let i = 0; i < route.steps.length; i++) {
    const run = await startStep(ctx, t, input, route.steps, route.fallback, i, emit);
    const r = await runSpecialistClassic(run);
    succeeded.push(...r.succeeded);
    if (r.finalText) texts.push(r.finalText);
    paused ||= r.paused;
    planned ||= !!r.planId;
    if (r.askedUser && i < route.steps.length - 1) {
      await parkRemainingSteps(t.conv, route.steps.slice(i + 1), emit);
      break;
    }
  }
  await finishTurn(ctx, t.conv, input, { texts, succeeded, paused, planned }, emit);
  return { conversationId: t.conv.id, route: route.steps };
}

/** One specialist's tool loop: its own prompt, only its own tools, the shared conversation. */
async function runSpecialistClassic(o: SpecialistRun): Promise<SpecialistResult> {
  const delta = { first: true };
  const succeeded: string[] = [];
  let state = { paused: false, planId: null as string | null };
  let finalText = "";
  const max = maxRoundsFor(o.spec);
  for (let round = 0; round < max; round++) {
    const r = await modelRound(o, round, delta);
    if (r.toolCalls.length === 0) {
      finalText = r.content;
      break;
    }
    const out = await runToolCalls(o, r.toolCalls, r.agentCtx, state);
    succeeded.push(...out.succeeded);
    state = { paused: out.paused, planId: out.planId };
    if (state.paused || state.planId) break;
    if (round === max - 1) await roundLimitReached(o);
  }
  return { finalText, succeeded, paused: state.paused, planId: state.planId, askedUser: askedUser({ finalText, ...state }) };
}

// ─── Confirmations ───────────────────────────────────────────────────────

/** Confirm or reject a pending sensitive action. Only the user who requested it can decide. */
export async function decideAction(ctx: Ctx, actionId: string, decision: "confirm" | "reject") {
  const action = await db.agentActionLog.findFirst({
    where: { id: actionId, userId: ctx.userId, organizationId: ctx.organizationId },
  });
  if (!action || !action.conversationId) throw new AppError("NOT_FOUND", "That action was not found.");
  if (action.status !== "PENDING_CONFIRMATION") throw new AppError("CONFLICT", "This action was already handled.");
  if (Date.now() - action.createdAt.getTime() > CONFIRMATION_TTL_MS) {
    await db.agentActionLog.update({ where: { id: action.id }, data: { status: "CANCELED", errorMessage: "Confirmation expired" } });
    throw new AppError("CONFLICT", "This confirmation expired. Ask the assistant again.");
  }
  // Claim the action atomically so a double-click can't execute it twice.
  const claimed = await db.agentActionLog.updateMany({
    where: { id: action.id, status: "PENDING_CONFIRMATION" },
    data: { status: decision === "confirm" ? "SUCCEEDED" : "REJECTED", confirmedAt: new Date() },
  });
  if (claimed.count === 0) throw new AppError("CONFLICT", "This action was already handled.");

  const conv = await db.agentConversation.findUniqueOrThrow({ where: { id: action.conversationId }, include: { meeting: { select: { joinCode: true } } } });

  let text: string;
  let ok = true;
  let link: string | undefined;
  if (decision === "reject") {
    text = "Okay — I didn't do it. Nothing was changed.";
  } else {
    const tool = TOOL_BY_NAME.get(action.toolName);
    if (!tool) throw new AppError("INTERNAL", "Unknown action.");
    const rows = await db.agentMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
    const agentCtx: AgentContext = { auth: ctx, conversationId: conv.id, currentMeetingRef: conv.meeting?.joinCode ?? null, now: new Date(), history: toHistory(rows) };
    const started = Date.now();
    try {
      // Permissions are re-checked inside the service at execution time.
      const output = await tool.run(agentCtx, tool.schema.parse(action.arguments));
      await db.agentActionLog.update({ where: { id: action.id }, data: { result: JSON.parse(JSON.stringify(output.data)), durationMs: Date.now() - started } });
      text = `✓ Done: ${output.summary}.`;
      link = output.link;
    } catch (err) {
      const p = errorPayload(err);
      const message = p.ok ? "" : p.error.message;
      await db.agentActionLog.update({ where: { id: action.id }, data: { status: "FAILED", errorMessage: message, durationMs: Date.now() - started } });
      text = `That didn't work: ${message} Nothing was changed.`;
      ok = false;
    }
  }

  // Mark the confirmation card as decided and record the outcome in the conversation.
  const card = await db.agentMessage.findFirst({
    where: { conversationId: conv.id, role: "TOOL", metadata: { path: ["actionId"], equals: action.id } },
  });
  if (card) {
    const meta = card.metadata as unknown as ToolMessageMeta;
    await db.agentMessage.update({
      where: { id: card.id },
      data: { metadata: { ...meta, status: undefined, decision: decision === "confirm" ? (ok ? "confirmed" : "failed") : "rejected" } as unknown as Prisma.InputJsonValue },
    });
  }
  const msg = await db.agentMessage.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: text, metadata: link ? { link } : undefined } });
  await db.agentConversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
  return { ok, message: { id: msg.id, content: text, link } };
}

// ─── Plans ───────────────────────────────────────────────────────────────

/**
 * Approve or reject a plan from the Planner. Approval runs every step in order; if anything
 * fails, the Planner researches alternatives for just those parts and proposes a revised plan.
 * Only the user who asked can decide; a plan is decided once and expires after 15 minutes.
 */
export async function decidePlan(ctx: Ctx, planId: string, decision: "approve" | "reject", opts: { now?: Date } = {}) {
  const plan = await db.agentPlan.findFirst({ where: { id: planId, userId: ctx.userId, organizationId: ctx.organizationId } });
  if (!plan) throw new AppError("NOT_FOUND", "That plan was not found.");
  if (plan.status !== "PROPOSED") throw new AppError("CONFLICT", "This plan was already handled.");
  if (Date.now() - plan.createdAt.getTime() > PLAN_TTL_MS) {
    await db.agentPlan.updateMany({ where: { id: plan.id, status: "PROPOSED" }, data: { status: "EXPIRED" } });
    throw new AppError("CONFLICT", "This plan expired. Ask the assistant again.");
  }
  // Claim atomically so a double-click can't run the plan twice.
  const claimed = await db.agentPlan.updateMany({ where: { id: plan.id, status: "PROPOSED" }, data: { status: decision === "approve" ? "RUNNING" : "REJECTED", decidedAt: new Date() } });
  if (claimed.count === 0) throw new AppError("CONFLICT", "This plan was already handled.");

  const conv = await db.agentConversation.findUniqueOrThrow({ where: { id: plan.conversationId }, include: { meeting: { select: { joinCode: true, title: true } } } });
  const say = async (content: string) =>
    db.agentMessage.create({ data: { conversationId: conv.id, role: "ASSISTANT", content, metadata: { agent: "planner", planId: plan.id } } });

  if (decision === "reject") {
    const msg = await say("Okay — I didn't do any of it. Nothing was changed.");
    return { ok: true, plan: planView(await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } })), message: { id: msg.id, content: msg.content }, revision: null };
  }

  const now = opts.now ?? new Date();
  const rows = await db.agentMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
  const agentCtx: AgentContext = { auth: ctx, conversationId: conv.id, currentMeetingRef: conv.meeting?.joinCode ?? null, now, history: toHistory(rows), agent: "planner" };
  const result = await executePlan(agentCtx, plan.id);
  const notDone = result.steps.filter((x) => x.status !== "done");
  const lines = result.steps.map((x) => `${x.status === "done" ? "✓" : x.status === "skipped" ? "–" : "✗"} ${x.index}. ${x.status === "done" ? (x.resultSummary ?? x.summary) : `${x.summary} — ${x.error}`}`);
  const head = notDone.length === 0 ? `✓ Plan carried out: all ${result.steps.length} steps done.` : `Plan partly carried out: ${result.done} of ${result.steps.length} steps done.`;
  const msg = await say(`${head}\n\n${lines.join("\n")}`);

  // Adapt: ask the Planner for alternatives for what didn't work (needs approval again).
  let revision: PlanView | null = null;
  if (notDone.length && plan.revision < MAX_REVISIONS) {
    const spec = SPECIALIST_BY_ID.get("planner")!;
    const describe = (x: PlanStep) => `step ${x.index} (${x.tool}): ${x.summary}${x.error ? ` — ${x.error}` : ""}`;
    const task = [
      `Part of the approved plan for "${plan.goal}" didn't work.`,
      result.steps.some((x) => x.status === "done") ? `Already done (don't repeat): ${result.steps.filter((x) => x.status === "done").map(describe).join("; ")}.` : "",
      `Not done: ${notDone.map(describe).join("; ")}.`,
      "Research alternatives that keep the same intent (same people, a close time, a similar place) and call propose_plan with ONLY the replacement steps. If there is no reasonable alternative, explain briefly instead.",
    ].filter(Boolean).join("\n");
    await db.agentMessage.create({ data: { conversationId: conv.id, role: "SYSTEM", content: task, metadata: { handoff: { agent: "planner", name: spec.name, task, index: 0, total: 1, fallback: false } } as unknown as Prisma.InputJsonValue } });
    const system = await specialistSystem({ ctx, conv, spec, task, teammates: [], now });
    const r = await runSpecialist({ ctx, conv, spec, system, emit: () => {}, autoExecute: false, now, revisionOf: { id: plan.id, revision: plan.revision }, handoffNote: `(Coordinator) Planner, your task now: ${task}` });
    if (r.planId) {
      revision = planView(await db.agentPlan.findUniqueOrThrow({ where: { id: r.planId } }));
      await db.agentMessage.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: "Here's a revised plan for what didn't work. Nothing happens until you approve it.", metadata: { agent: "planner" } } });
    }
  }
  await db.agentConversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
  return { ok: notDone.length === 0, plan: planView(result.plan), message: { id: msg.id, content: msg.content }, revision };
}
