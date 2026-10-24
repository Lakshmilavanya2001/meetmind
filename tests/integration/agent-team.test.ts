import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/server/db";
import { setLlmProviderForTests, type CompletionRequest, type CompletionResult } from "@/server/ai/llm";
import { runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { SPECIALISTS } from "@/server/ai/agents";
import { TOOLS } from "@/server/ai/tools";
import { getConversationMessages } from "@/server/ai/conversations";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

let n = 0;
const call = (name: string, args: object) => ({ id: `c${++n}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const agentOf = (req: CompletionRequest) => /TEAM ROLE: you are the "([^"]+)" agent/.exec(req.messages[0].content as string)?.[1] ?? null;
const toolNames = (req: CompletionRequest) => (req.tools ?? []).map((t) => t.function.name).sort();

type Script = { route: unknown; byAgent: Record<string, ((req: CompletionRequest) => Partial<CompletionResult>)[]> };
let seen: CompletionRequest[] = [];
function team(s: Script) {
  seen = [];
  setLlmProviderForTests({
    model: "s",
    complete: async (req) => {
      seen.push(req);
      if (req.jsonSchema?.name === "route_request") return { content: typeof s.route === "string" ? s.route : JSON.stringify(s.route), toolCalls: [], finishReason: "stop" };
      const step = s.byAgent[agentOf(req) ?? "?"]?.shift();
      if (!step) throw new Error(`No script for agent ${agentOf(req)}`);
      const r = { content: "", toolCalls: [], finishReason: "stop", ...step(req) };
      if (r.content) req.onDelta?.(r.content);
      return r;
    },
  });
}

beforeEach(async () => {
  await resetDb();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
});
afterAll(() => {
  setLlmProviderForTests(null);
  setCallingProviderForTests("LIVEKIT", null);
});

async function setup() {
  const org = await createOrg();
  const mk = async (name: string, email: string) => {
    const u = await createUser(org.id, name, { email, timezone: "Asia/Kolkata" });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, email, displayName: name, timezone: "Asia/Kolkata" } };
  };
  return { aisha: await mk("Aisha Khan", "aisha@acme.test"), priya: await mk("Priya Patel", "priya@acme.test") };
}
async function turn(ctx: Awaited<ReturnType<typeof setup>>["aisha"], message: string, conversationId?: string) {
  const events: AgentEvent[] = [];
  const r = await runAgentTurn(ctx, { message, conversationId }, (e) => events.push(e));
  return { ...r, events };
}

describe("agent team: structure", () => {
  it("every tool belongs to a specialist; specialists only list real tools; the general agent has all but planning", () => {
    const all = new Set(TOOLS.map((t) => t.name));
    const owned = new Set(SPECIALISTS.filter((s) => s.id !== "general").flatMap((s) => s.tools));
    expect([...all].filter((t) => !owned.has(t))).toEqual([]);
    for (const s of SPECIALISTS) for (const t of s.tools) expect(all.has(t), `${s.id}: ${t}`).toBe(true);
    expect(new Set(SPECIALISTS.find((s) => s.id === "general")!.tools)).toEqual(new Set([...all].filter((t) => t !== "propose_plan")));
    // Ordering food or booking a cab is never in the meetings agent's hands, and vice versa.
    expect(SPECIALISTS.find((s) => s.id === "meetings")!.tools).not.toContain("order_food");
    expect(SPECIALISTS.find((s) => s.id === "dining")!.tools).not.toContain("create_meeting");
  });
});

describe("agent team: routing and handoffs", () => {
  it("a two-part request goes to two specialists in order, each with only its own tools", async () => {
    const { aisha, priya } = await setup();
    const start = new Date(Date.now() + 3 * 86400_000);
    start.setUTCHours(5, 30, 0, 0); // 11:00 IST
    const end = new Date(start.getTime() + 3600_000);
    const date = formatInTimeZone(start, "Asia/Kolkata", "yyyy-MM-dd");
    team({
      route: { steps: [
        { agent: "meetings", task: "Schedule a 1-hour roadmap review with Priya at 11:00 on " + date },
        { agent: "dining", task: "Reserve a table for 2 at The Green Bowl on " + date + " after the review" },
      ] },
      byAgent: {
        "Meetings & calls": [
          () => ({ toolCalls: [call("search_users", { query: "Priya" })] }),
          () => ({ toolCalls: [call("create_meeting", { title: "Roadmap review", start_time: start.toISOString(), end_time: end.toISOString(), participant_ids: [priya.userId] })] }),
        ],
        "Food & dining": [
          () => ({ toolCalls: [call("find_table_slots", { restaurant_id: "r-green-bowl", date, party_size: 2 })] }),
          (req) => {
            const slots = JSON.parse([...req.messages].reverse().find((m) => m.role === "tool")!.content as string).data.slots as { start_time: string; available: boolean }[];
            const slot = slots.find((s) => s.available && new Date(s.start_time) >= end)!;
            return { toolCalls: [call("reserve_table", { restaurant_id: "r-green-bowl", start_time: slot.start_time, party_size: 2 })] };
          },
        ],
      },
    });
    const r = await turn(aisha, "Set up a roadmap review with Priya and book a table for after it");

    const handoffs = r.events.filter((e) => e.type === "handoff") as Extract<AgentEvent, { type: "handoff" }>[];
    expect(handoffs.map((h) => [h.agent, h.index, h.total])).toEqual([["meetings", 0, 2], ["dining", 1, 2]]);
    const confs = r.events.filter((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>[];
    expect(confs.map((c) => c.toolName)).toEqual(["create_meeting", "reserve_table"]);
    expect(await db.agentActionLog.findMany({ where: { status: "PENDING_CONFIRMATION" }, select: { toolName: true, agent: true }, orderBy: { createdAt: "asc" } }))
      .toEqual([{ toolName: "create_meeting", agent: "meetings" }, { toolName: "reserve_table", agent: "dining" }]);

    const meetingsReq = seen.find((q) => agentOf(q) === "Meetings & calls")!;
    const diningReq = seen.find((q) => agentOf(q) === "Food & dining")!;
    expect(toolNames(meetingsReq)).toEqual([...SPECIALISTS.find((s) => s.id === "meetings")!.tools].sort());
    expect(toolNames(diningReq)).toEqual([...SPECIALISTS.find((s) => s.id === "dining")!.tools].sort());
    expect(diningReq.messages[0].content).toMatch(/Your task from the coordinator: Reserve a table/);
    expect(diningReq.messages[0].content).toMatch(/Other agents handle the other parts of this message: Meetings & calls: Schedule/);
    // The dining agent sees the meetings agent's work in the shared conversation.
    expect(JSON.stringify(diningReq.messages)).toContain("create_meeting");

    const deltas = r.events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(deltas.match(/Please confirm/g)).toHaveLength(1);
    const view = await getConversationMessages(aisha, r.conversationId);
    expect(view.messages.filter((m) => m.kind === "handoff").map((m) => (m as { name: string }).name)).toEqual(["Meetings & calls", "Food & dining"]);
  });

  it("a specialist can't use another specialist's tools", async () => {
    const { aisha } = await setup();
    team({
      route: { steps: [{ agent: "dining", task: "Cancel my 3 pm meeting" }] },
      byAgent: { "Food & dining": [() => ({ toolCalls: [call("cancel_meeting", { meeting: "abc-defg-hij" })] }), () => ({ content: "I can't cancel meetings." })] },
    });
    const r = await turn(aisha, "Cancel my 3 pm meeting");
    const end = r.events.find((e) => e.type === "tool_end");
    expect(end).toBeUndefined(); // never even started
    const tool = await db.agentMessage.findFirstOrThrow({ where: { role: "TOOL" } });
    expect(JSON.parse(tool.content).error.code).toBe("UNKNOWN_TOOL");
    expect(await db.agentActionLog.count()).toBe(0);
  });

  it("when a specialist asks a question, later parts wait; the next message picks them up", async () => {
    const { aisha } = await setup();
    team({
      route: { steps: [{ agent: "dining", task: "Order 2 masala dosas from Dosa Corner" }, { agent: "travel", task: "Book a cab home at 7 pm" }] },
      byAgent: { "Food & dining": [() => ({ content: "Where should I deliver the dosas?" })] },
    });
    const first = await turn(aisha, "Order 2 masala dosas from Dosa Corner and book me a cab home at 7 pm");
    expect(first.events.filter((e) => e.type === "handoff")).toHaveLength(1);
    expect(seen.some((q) => agentOf(q) === "Travel")).toBe(false);
    expect(await db.agentMessage.count({ where: { role: "SYSTEM", metadata: { path: ["waiting"], not: "null" } } })).toBe(1);

    team({
      route: { steps: [{ agent: "dining", task: "Deliver to Acme office, Koramangala" }] },
      byAgent: { "Food & dining": [() => ({ content: "Got it." })] },
    });
    await turn(aisha, "Acme office, Koramangala", first.conversationId);
    const routing = seen.find((q) => q.jsonSchema?.name === "route_request")!;
    expect(routing.messages[1].content).toMatch(/\(waiting, not started\) travel: Book a cab home at 7 pm/);
    expect(routing.messages[1].content).toMatch(/Assistant \[dining\]: Where should I deliver the dosas\?/);
  });

  it("an unreadable route falls back to the general agent with every tool", async () => {
    const { aisha } = await setup();
    team({ route: "not json", byAgent: { "General assistant": [() => ({ content: "Hello!" })] } });
    const r = await turn(aisha, "hi");
    expect(r.events.find((e) => e.type === "handoff")).toMatchObject({ agent: "general", fallback: true });
    expect(toolNames(seen.find((q) => agentOf(q) === "General assistant")!)).toHaveLength(TOOLS.length - 1); // everything but propose_plan
  });
});
