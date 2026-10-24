import { describe, expect, it } from "vitest";
import { agentGraphMermaid } from "@/server/ai/agent-graph";
import { agentEngine } from "@/server/ai/agent";

describe("LangGraph orchestration", () => {
  it("is the default engine; AGENT_ENGINE=classic switches back", () => {
    const before = process.env.AGENT_ENGINE;
    delete process.env.AGENT_ENGINE;
    expect(agentEngine()).toBe("langgraph");
    process.env.AGENT_ENGINE = "classic";
    expect(agentEngine()).toBe("classic");
    if (before === undefined) delete process.env.AGENT_ENGINE;
    else process.env.AGENT_ENGINE = before;
  });

  it("turn graph: receive → coordinator → handoff → specialist → (handoff | finish)", async () => {
    const { turn } = await agentGraphMermaid();
    for (const edge of ["__start__ --> receive", "receive --> coordinator", "coordinator -.-> handoff", "coordinator -.-> finish", "handoff --> specialist", "specialist -.-> handoff", "specialist -.-> finish", "finish --> __end__"]) {
      expect(turn, edge).toContain(edge);
    }
  });

  it("specialist graph: model ⇄ tools, stopping to wait for the user or at the round limit", async () => {
    const { specialist } = await agentGraphMermaid();
    for (const edge of ["__start__ --> model", "model -.-> tools", "model -.-> __end__", "tools -.-> model", "tools -.-> round_limit", "tools -.-> __end__", "round_limit --> __end__"]) {
      expect(specialist, edge).toContain(edge);
    }
  });
});
