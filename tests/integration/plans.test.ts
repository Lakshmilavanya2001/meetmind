import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/server/db";
import { setLlmProviderForTests, type CompletionRequest, type CompletionResult } from "@/server/ai/llm";
import { decidePlan, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { SPECIALISTS } from "@/server/ai/agents";
import { getConversationMessages } from "@/server/ai/conversations";
import { reserveTable } from "@/server/services/bookings";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

let n = 0;
const call = (name: string, args: object) => ({ id: `p${++n}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const lastTool = (req: CompletionRequest) => JSON.parse([...req.messages].reverse().find((m) => m.role === "tool")!.content as string);
type Step = (req: CompletionRequest) => Partial<CompletionResult>;
let plannerCalls: CompletionRequest[] = [];

/** Coordinator → planner; the planner follows the script. */
function planner(steps: Step[]) {
  plannerCalls = [];
  setLlmProviderForTests({
    model: "s",
    complete: async (req) => {
      if (req.jsonSchema?.name === "route_request") return { content: JSON.stringify({ steps: [{ agent: "planner", task: "Plan the team dinner" }] }), toolCalls: [], finishReason: "stop" };
      plannerCalls.push(req);
      const step = steps.shift();
      if (!step) throw new Error("planner script exhausted");
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

const TZ = "Asia/Kolkata";
async function setup() {
  const org = await createOrg();
  const mk = async (name: string, email: string) => {
    const u = await createUser(org.id, name, { email, timezone: TZ });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, email, displayName: name, timezone: TZ } };
  };
  const aisha = await mk("Aisha Khan", "aisha@acme.test");
  const priya = await mk("Priya Patel", "priya@acme.test");
  const date = formatInTimeZone(new Date(Date.now() + 3 * 86400_000), TZ, "yyyy-MM-dd");
  return { aisha, priya, date };
}
const slotsOf = (req: CompletionRequest) => (lastTool(req).data.slots as { start_time: string; available: boolean }[]).filter((s) => s.available && Number(formatInTimeZone(new Date(s.start_time), TZ, "H")) >= 19);

async function proposeDinner(aisha: Awaited<ReturnType<typeof setup>>["aisha"], priyaId: string, date: string) {
  let slot = "";
  planner([
    () => ({ toolCalls: [call("search_users", { query: "Priya" })] }),
    () => ({ toolCalls: [call("find_table_slots", { restaurant_id: "r-green-bowl", date, party_size: 2 })] }),
    (req) => {
      slot = slotsOf(req)[0].start_time;
      const end = new Date(new Date(slot).getTime() + 90 * 60_000).toISOString();
      return {
        toolCalls: [call("propose_plan", {
          goal: "Team dinner with Priya",
          steps: [
            { tool: "create_meeting", args: { title: "Team dinner", start_time: slot, end_time: end, participant_ids: [priyaId] }, why: "Put it on everyone's calendar" },
            { tool: "reserve_table", args: { restaurant_id: "r-green-bowl", start_time: slot, party_size: 2 }, why: "Table for both of us" },
            { tool: "book_cab", args: { pickup: "Acme office, Indiranagar", drop: "The Green Bowl, Whitefield", cab_type: "SEDAN", pickup_time: new Date(new Date(slot).getTime() - 45 * 60_000).toISOString() }, why: "Get there on time", depends_on: [2] },
          ],
        })],
      };
    },
  ]);
  const events: AgentEvent[] = [];
  const r = await runAgentTurn(aisha, { message: "Plan a team dinner with Priya on " + date + " at The Green Bowl in Whitefield, with a cab from the Acme office in Indiranagar" }, (e) => events.push(e));
  return { ...r, events, slot: () => slot };
}

describe("planner: one plan, one approval", () => {
  it("researches, proposes an exact plan, runs nothing until approved, then executes every step", async () => {
    const { aisha, priya, date } = await setup();
    const r = await proposeDinner(aisha, priya.userId, date);
    const planEv = r.events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>;
    expect(planEv.plan.status).toBe("proposed");
    expect(planEv.plan.steps.map((s) => s.agent)).toEqual(["meetings", "dining", "travel"]);
    expect(planEv.plan.steps[0].summary).toMatch(/^Schedule “Team dinner” .* invite Priya Patel \(priya@acme\.test\)/);
    expect(planEv.plan.steps[1].summary).toMatch(/Reserve a table for 2 at The Green Bowl .*Sandbox/);
    expect(planEv.plan.steps[2].summary).toMatch(/Book a Sedan .*₹/);
    expect(r.events.some((e) => e.type === "confirmation")).toBe(false);
    expect(await db.meeting.count({ where: { title: "Team dinner" } })).toBe(0);
    expect(await db.booking.count()).toBe(0);
    // The planner only ever had read-only tools plus propose_plan.
    const offered = (plannerCalls[0].tools ?? []).map((t) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(["propose_plan", "find_table_slots"]));
    expect(offered).not.toContain("reserve_table");
    expect(offered).not.toContain("create_meeting");

    await expect(decidePlan(priya, planEv.plan.id, "approve")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const res = await decidePlan(aisha, planEv.plan.id, "approve");
    expect(res.ok).toBe(true);
    expect(res.plan.status).toBe("completed");
    expect(res.plan.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(res.message.content).toMatch(/^✓ Plan carried out: all 3 steps done/);
    expect(await db.meeting.count({ where: { title: "Team dinner" } })).toBe(1);
    expect((await db.booking.findMany({ orderBy: { createdAt: "asc" } })).map((b) => b.kind)).toEqual(["TABLE", "CAB"]);
    expect(await db.agentActionLog.count({ where: { agent: "planner", status: "SUCCEEDED", requiresConfirmation: true } })).toBe(3);
    await expect(decidePlan(aisha, planEv.plan.id, "approve")).rejects.toMatchObject({ code: "CONFLICT" });

    const view = await getConversationMessages(aisha, r.conversationId);
    expect(view.messages.find((m) => m.kind === "plan")).toMatchObject({ plan: { status: "completed" } });
  });

  it("an invalid step is sent back to the planner to fix before anything is shown", async () => {
    const { aisha, date } = await setup();
    planner([
      () => ({ toolCalls: [call("propose_plan", { goal: "Dinner", steps: [{ tool: "reserve_table", args: { restaurant_id: "r-biryani-house", start_time: new Date(Date.now() + 86400_000).toISOString(), party_size: 2 }, why: "Table" }] })] }),
      (req) => {
        expect(lastTool(req).error.message).toMatch(/Step 1 \(reserve_table\) isn't valid: .*delivery-only/);
        return { toolCalls: [call("find_table_slots", { restaurant_id: "r-green-bowl", date, party_size: 2 })] };
      },
      (req) => ({ toolCalls: [call("propose_plan", { goal: "Dinner", steps: [{ tool: "reserve_table", args: { restaurant_id: "r-green-bowl", start_time: slotsOf(req)[0].start_time, party_size: 2 }, why: "Table" }] })] }),
    ]);
    const events: AgentEvent[] = [];
    await runAgentTurn(aisha, { message: "Plan dinner" }, (e) => events.push(e));
    expect(events.filter((e) => e.type === "plan")).toHaveLength(1);
    expect(await db.agentPlan.count()).toBe(1);
  });

  it("a plan can't invent a pickup point", async () => {
    const { aisha } = await setup();
    planner([
      () => ({ toolCalls: [call("propose_plan", { goal: "Cab", steps: [{ tool: "book_cab", args: { pickup: "Aisha's home", drop: "Pasta Street, MG Road", cab_type: "AUTO" }, why: "Ride" }] })] }),
      (req) => {
        expect(lastTool(req).error.message).toMatch(/pickup point “Aisha's home” isn't what the user said/);
        return { content: "Where should the cab pick you up?" };
      },
    ]);
    await runAgentTurn(aisha, { message: "Plan lunch at Pasta Street on MG Road and get me a cab" }, () => {});
    expect(await db.agentPlan.count()).toBe(0);
  });

  it("plans can't contain other actions, and only the planner can propose them", async () => {
    const { aisha } = await setup();
    planner([
      () => ({ toolCalls: [call("propose_plan", { goal: "x", steps: [{ tool: "end_meeting", args: { meeting: "current" }, why: "x" }] })] }),
      (req) => {
        expect(lastTool(req).error.code).toBe("INVALID_ARGUMENTS");
        return { content: "I can't do that in a plan." };
      },
    ]);
    await runAgentTurn(aisha, { message: "Plan something" }, () => {});
    expect(await db.agentPlan.count()).toBe(0);
    expect(SPECIALISTS.find((s) => s.id === "general")!.tools).not.toContain("propose_plan");
  });

  it("when a step fails at execution, dependent steps are skipped and a revised plan is proposed", async () => {
    const { aisha, priya, date } = await setup();
    const r = await proposeDinner(aisha, priya.userId, date);
    const planId = (r.events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>).plan.id;
    // Someone else takes the last seats before the user approves.
    const other = await createUser(aisha.organizationId, "Olga Other", { timezone: TZ });
    const octx = { ...aisha, userId: other.id, user: { ...aisha.user, id: other.id } };
    while (true) {
      try {
        await reserveTable(octx, { restaurantId: "r-green-bowl", start: r.slot(), partySize: 2 });
      } catch {
        break;
      }
    }
    let altSlot = "";
    planner([
      (req) => {
        expect(req.messages[0].content).toMatch(/Not done: step 2 \(reserve_table\)[\s\S]*full[\s\S]*step 3 \(book_cab\)[\s\S]*Skipped because step 2/);
        expect(req.messages[0].content).toMatch(/Already done \(don't repeat\): step 1 \(create_meeting\)/);
        return { toolCalls: [call("find_table_slots", { restaurant_id: "r-green-bowl", date, party_size: 2 })] };
      },
      (req) => {
        altSlot = slotsOf(req).find((s) => s.start_time !== r.slot())!.start_time;
        return {
          toolCalls: [call("propose_plan", {
            goal: "Team dinner with Priya (new table time)",
            steps: [
              { tool: "reserve_table", args: { restaurant_id: "r-green-bowl", start_time: altSlot, party_size: 2 }, why: "The original time filled up" },
              { tool: "book_cab", args: { pickup: "Acme office, Indiranagar", drop: "The Green Bowl, Whitefield", cab_type: "SEDAN", pickup_time: new Date(new Date(altSlot).getTime() - 45 * 60_000).toISOString() }, why: "Get there on time", depends_on: [1] },
            ],
          })],
        };
      },
    ]);
    const res = await decidePlan(aisha, planId, "approve");
    expect(res.ok).toBe(false);
    expect(res.plan.status).toBe("partial");
    expect(res.plan.steps.map((s) => s.status)).toEqual(["done", "failed", "skipped"]);
    expect(res.revision).toMatchObject({ status: "proposed", revision: 1 });
    expect(res.revision!.steps.map((s) => s.agent)).toEqual(["dining", "travel"]);

    const again = await decidePlan(aisha, res.revision!.id, "approve");
    expect(again.plan.status).toBe("completed");
    expect(await db.booking.count({ where: { userId: aisha.userId } })).toBe(2);
    expect(await db.agentPlan.findUniqueOrThrow({ where: { id: res.revision!.id } })).toMatchObject({ parentId: planId });
  });

  it("rejecting does nothing; an expired plan can't be approved", async () => {
    const { aisha, priya, date } = await setup();
    const r = await proposeDinner(aisha, priya.userId, date);
    const planId = (r.events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>).plan.id;
    const res = await decidePlan(aisha, planId, "reject");
    expect(res.plan.status).toBe("rejected");
    expect(await db.booking.count()).toBe(0);

    const r2 = await proposeDinner(aisha, priya.userId, date);
    const id2 = (r2.events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>).plan.id;
    await db.agentPlan.update({ where: { id: id2 }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    await expect(decidePlan(aisha, id2, "approve")).rejects.toThrow(/expired/);
    expect(await db.meeting.count({ where: { title: "Team dinner" } })).toBe(0);
  });
});
