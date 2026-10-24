import "server-only";
import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ToolCall } from "./llm";
import type { AgentContext } from "./tools";
import type { RouteStep } from "./agents";
import {
  askedUser,
  beginTurn,
  coordinate,
  finishTurn,
  maxRoundsFor,
  modelRound,
  parkRemainingSteps,
  roundLimitReached,
  runToolCalls,
  startStep,
  type AgentEvent,
  type Ctx,
  type DeltaState,
  type SpecialistResult,
  type SpecialistRun,
  type TurnInput,
  type TurnStart,
} from "./agent-core";

/**
 * The assistant's orchestration as LangGraph graphs.
 *
 *   Turn graph:        receive → coordinator → handoff → specialist ─┬→ handoff (next part of the request)
 *                                                                   └→ finish (notes, claim guard) → END
 *   Specialist graph:  model ─┬→ tools ─┬→ model (next round)
 *                             │         ├→ END (waiting for the user's confirmation, or a plan to approve)
 *                             │         └→ round_limit → END
 *                             └→ END (answered)
 *
 * Every node calls the same building blocks as the original loop (agent-core.ts), so behaviour,
 * stored messages and streamed events are identical. Human approval stays outside the graph: a
 * sensitive tool ends the specialist's run with a confirmation card, and the user's Confirm runs the
 * action later (decideAction), so the user can keep talking meanwhile. No checkpointer is needed:
 * the conversation itself is stored in Postgres, as before.
 */

const or = (a: boolean, b: boolean) => a || b;
const concat = <T,>(a: T[], b: T[]) => a.concat(b);

// ─── Specialist graph: one agent's model ⇄ tools loop ────────────────────

const SpecialistState = Annotation.Root({
  maxRounds: Annotation<number>(),
  round: Annotation<number>(),
  calls: Annotation<ToolCall[]>(),
  agentCtx: Annotation<AgentContext | null>(),
  finalText: Annotation<string>(),
  succeeded: Annotation<string[]>({ reducer: concat, default: () => [] }),
  paused: Annotation<boolean>(),
  planId: Annotation<string | null>(),
});
type SpecialistConfig = { run: SpecialistRun; delta: DeltaState };
const specialistCfg = (config: LangGraphRunnableConfig) => config.configurable as SpecialistConfig;

const specialistGraph = new StateGraph(SpecialistState)
  .addNode("model", async (s, config) => {
    const { run, delta } = specialistCfg(config);
    const r = await modelRound(run, s.round, delta);
    return { calls: r.toolCalls, agentCtx: r.agentCtx, finalText: r.toolCalls.length ? s.finalText : r.content };
  })
  .addNode("tools", async (s, config) => {
    const out = await runToolCalls(specialistCfg(config).run, s.calls, s.agentCtx!, { paused: s.paused, planId: s.planId });
    return { succeeded: out.succeeded, paused: out.paused, planId: out.planId, round: s.round + 1, calls: [] };
  })
  .addNode("round_limit", async (_s, config) => {
    await roundLimitReached(specialistCfg(config).run);
    return {};
  })
  .addEdge(START, "model")
  .addConditionalEdges("model", (s) => (s.calls.length ? "tools" : END), ["tools", END])
  .addConditionalEdges("tools", (s) => (s.paused || s.planId ? END : s.round >= s.maxRounds ? "round_limit" : "model"), ["model", "round_limit", END])
  .addEdge("round_limit", END)
  .compile({ name: "specialist" });

export async function runSpecialistWithGraph(run: SpecialistRun): Promise<SpecialistResult> {
  const maxRounds = maxRoundsFor(run.spec);
  const s = await specialistGraph.invoke(
    { maxRounds, round: 0, calls: [], agentCtx: null, finalText: "", paused: false, planId: null },
    { configurable: { run, delta: { first: true } } satisfies SpecialistConfig, recursionLimit: maxRounds * 2 + 5 },
  );
  return { finalText: s.finalText, succeeded: s.succeeded, paused: s.paused, planId: s.planId, askedUser: askedUser(s) };
}

// ─── Turn graph: coordinator and the specialists it hands work to ────────

const TurnState = Annotation.Root({
  turn: Annotation<TurnStart | null>(),
  steps: Annotation<RouteStep[]>(),
  fallback: Annotation<boolean>(),
  index: Annotation<number>(),
  current: Annotation<SpecialistRun | null>(),
  texts: Annotation<string[]>({ reducer: concat, default: () => [] }),
  succeeded: Annotation<string[]>({ reducer: concat, default: () => [] }),
  paused: Annotation<boolean>({ reducer: or, default: () => false }),
  planned: Annotation<boolean>({ reducer: or, default: () => false }),
  stop: Annotation<boolean>(),
});
type TurnConfig = { ctx: Ctx; input: TurnInput; emit: (e: AgentEvent) => void; now: Date };
const turnCfg = (config: LangGraphRunnableConfig) => config.configurable as TurnConfig;

const turnGraph = new StateGraph(TurnState)
  .addNode("receive", async (_s, config) => {
    const { ctx, input, emit, now } = turnCfg(config);
    return { turn: await beginTurn(ctx, input, emit, now) };
  })
  .addNode("coordinator", async (s) => {
    const route = await coordinate(s.turn!);
    return { steps: route.steps, fallback: route.fallback, index: 0, stop: false };
  })
  .addNode("handoff", async (s, config) => {
    const { ctx, input, emit } = turnCfg(config);
    return { current: await startStep(ctx, s.turn!, input, s.steps, s.fallback, s.index, emit) };
  })
  .addNode("specialist", async (s, config) => {
    const r = await runSpecialistWithGraph(s.current!);
    const more = s.index < s.steps.length - 1;
    // The specialist needs an answer from the user: the remaining parts wait for it.
    if (r.askedUser && more) await parkRemainingSteps(s.turn!.conv, s.steps.slice(s.index + 1), turnCfg(config).emit);
    return { texts: r.finalText ? [r.finalText] : [], succeeded: r.succeeded, paused: r.paused, planned: !!r.planId, index: s.index + 1, stop: r.askedUser && more };
  })
  .addNode("finish", async (s, config) => {
    const { ctx, input, emit } = turnCfg(config);
    await finishTurn(ctx, s.turn!.conv, input, { texts: s.texts, succeeded: s.succeeded, paused: s.paused, planned: s.planned }, emit);
    return {};
  })
  .addEdge(START, "receive")
  .addEdge("receive", "coordinator")
  .addConditionalEdges("coordinator", (s) => (s.steps.length ? "handoff" : "finish"), ["handoff", "finish"])
  .addEdge("handoff", "specialist")
  .addConditionalEdges("specialist", (s) => (s.stop || s.index >= s.steps.length ? "finish" : "handoff"), ["handoff", "finish"])
  .addEdge("finish", END)
  .compile({ name: "assistant_turn" });

export async function runTurnWithGraph(ctx: Ctx, input: TurnInput, emit: (e: AgentEvent) => void, now: Date) {
  const s = await turnGraph.invoke(
    { turn: null, steps: [], fallback: false, index: 0, current: null, stop: false },
    { configurable: { ctx, input, emit, now } satisfies TurnConfig, recursionLimit: 50 },
  );
  return { conversationId: s.turn!.conv.id, route: s.steps };
}

/** Mermaid drawings of both graphs, generated by LangGraph itself (for the docs). */
export async function agentGraphMermaid() {
  return { turn: (await turnGraph.getGraphAsync()).drawMermaid(), specialist: (await specialistGraph.getGraphAsync()).drawMermaid() };
}
