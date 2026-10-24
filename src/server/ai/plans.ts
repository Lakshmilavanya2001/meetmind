import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { AppError, isAppError } from "../errors";
import { SPECIALISTS } from "./agents";
import { PLAN_ACTION_TOOLS, TOOL_BY_NAME, type AgentContext } from "./tools";

export const PLAN_TTL_MS = 15 * 60_000;
export const MAX_REVISIONS = 2;

export type PlanStepStatus = "pending" | "done" | "failed" | "skipped";
export type PlanStep = {
  index: number; // 1-based
  tool: (typeof PLAN_ACTION_TOOLS)[number];
  args: Record<string, unknown>;
  summary: string; // exact description from the tool's preflight
  why: string;
  dependsOn: number[];
  agent: string; // the specialist that owns this kind of action (for the UI)
  status: PlanStepStatus;
  resultSummary?: string;
  error?: string;
  link?: string;
};
export type ProposedStep = { tool: string; args: Record<string, unknown>; why: string; depends_on: number[] };

const ownerOf = (tool: string) => SPECIALISTS.find((s) => s.id !== "general" && s.id !== "planner" && s.tools.includes(tool))?.id ?? "general";

/**
 * Validate a proposed plan and turn each step into an exact, permission-checked description,
 * using the same preflight as a single confirmation. Throws a VALIDATION error naming the
 * step that's wrong, so the Planner can fix it and propose again.
 */
export async function createPlan(agentCtx: AgentContext, input: { goal: string; steps: ProposedStep[] }, opts: { parentId?: string; revision?: number } = {}) {
  const steps: PlanStep[] = [];
  for (const [i, s] of input.steps.entries()) {
    const n = i + 1;
    const tool = TOOL_BY_NAME.get(s.tool);
    if (!tool || !(PLAN_ACTION_TOOLS as readonly string[]).includes(s.tool) || !tool.preflight) {
      throw new AppError("VALIDATION", `Step ${n}: ${s.tool} can't be part of a plan.`);
    }
    const deps = [...new Set(s.depends_on)];
    if (deps.some((d) => d >= n)) throw new AppError("VALIDATION", `Step ${n}: depends_on may only name earlier steps.`);
    let args: Record<string, unknown>;
    let summary: string;
    try {
      args = tool.schema.parse(s.args) as Record<string, unknown>;
      summary = await tool.preflight(agentCtx, args);
    } catch (err) {
      const msg = isAppError(err) ? err.message : err instanceof Error && "issues" in err ? (err as { issues: { path: (string | number)[]; message: string }[] }).issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : "invalid arguments";
      throw new AppError("VALIDATION", `Step ${n} (${s.tool}) isn't valid: ${msg}. Fix this step and call propose_plan again.`);
    }
    steps.push({ index: n, tool: s.tool as PlanStep["tool"], args, summary, why: s.why, dependsOn: deps, agent: ownerOf(s.tool), status: "pending" });
  }
  const plan = await db.agentPlan.create({
    data: {
      conversationId: agentCtx.conversationId,
      userId: agentCtx.auth.userId,
      organizationId: agentCtx.auth.organizationId,
      goal: input.goal,
      steps: steps as unknown as Prisma.InputJsonValue,
      parentId: opts.parentId,
      revision: opts.revision ?? 0,
    },
  });
  return plan;
}

export type PlanView = {
  id: string;
  goal: string;
  status: "proposed" | "running" | "completed" | "partial" | "failed" | "rejected" | "expired";
  revision: number;
  steps: Pick<PlanStep, "index" | "summary" | "why" | "agent" | "status" | "resultSummary" | "error" | "link" | "dependsOn">[];
};

export function planView(p: { id: string; goal: string; status: string; revision: number; createdAt: Date; steps: Prisma.JsonValue }): PlanView {
  const expired = p.status === "PROPOSED" && Date.now() - p.createdAt.getTime() > PLAN_TTL_MS;
  return {
    id: p.id,
    goal: p.goal,
    status: expired ? "expired" : (p.status.toLowerCase() as PlanView["status"]),
    revision: p.revision,
    steps: (p.steps as unknown as PlanStep[]).map(({ index, summary, why, agent, status, resultSummary, error, link, dependsOn }) => ({ index, summary, why, agent, status, resultSummary, error, link, dependsOn })),
  };
}

/**
 * Run an approved plan in order. A step whose prerequisite didn't succeed is skipped.
 * Every executed step is written to the audit log as a confirmed action by the Planner.
 * Services re-check permissions at execution time, exactly as for single confirmations.
 */
export async function executePlan(agentCtx: AgentContext, planId: string) {
  const plan = await db.agentPlan.findUniqueOrThrow({ where: { id: planId } });
  const steps = plan.steps as unknown as PlanStep[];
  for (const step of steps) {
    const blockedBy = step.dependsOn.find((d) => steps[d - 1]?.status !== "done");
    if (blockedBy) {
      step.status = "skipped";
      step.error = `Skipped because step ${blockedBy} didn't succeed.`;
      continue;
    }
    const tool = TOOL_BY_NAME.get(step.tool)!;
    const started = Date.now();
    try {
      const output = await tool.run(agentCtx, tool.schema.parse(step.args));
      step.status = "done";
      step.resultSummary = output.summary;
      step.link = output.link;
      await db.agentActionLog.create({
        data: {
          conversationId: plan.conversationId, userId: plan.userId, organizationId: plan.organizationId, toolName: step.tool,
          arguments: step.args as Prisma.InputJsonValue, result: JSON.parse(JSON.stringify(output.data)) as Prisma.InputJsonValue,
          status: "SUCCEEDED", requiresConfirmation: true, confirmedAt: plan.decidedAt, durationMs: Date.now() - started, agent: "planner",
        },
      });
    } catch (err) {
      step.status = "failed";
      step.error = isAppError(err) ? err.message : "Internal error; nothing was changed by this step.";
      if (!isAppError(err)) console.error("[plan] step crashed", err);
      await db.agentActionLog.create({
        data: {
          conversationId: plan.conversationId, userId: plan.userId, organizationId: plan.organizationId, toolName: step.tool,
          arguments: step.args as Prisma.InputJsonValue, status: "FAILED", errorMessage: step.error, requiresConfirmation: true,
          confirmedAt: plan.decidedAt, durationMs: Date.now() - started, agent: "planner",
        },
      });
    }
  }
  const done = steps.filter((s) => s.status === "done").length;
  const status = done === steps.length ? "COMPLETED" : done === 0 ? "FAILED" : "PARTIAL";
  const updated = await db.agentPlan.update({
    where: { id: plan.id },
    data: { steps: steps as unknown as Prisma.InputJsonValue, status, completedAt: new Date() },
  });
  return { plan: updated, steps, done };
}
