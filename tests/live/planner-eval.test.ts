/**
 * Live evaluation of the Planner agent against the real LLM. Opt-in: LLM_LIVE=1 npx vitest run tests/live
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/server/db";
import { setLlmProviderForTests } from "@/server/ai/llm";
import { decidePlan, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { routeRequest } from "@/server/ai/agents";
import { findTableSlots, reserveTable } from "@/server/services/bookings";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

const LIVE = process.env.LLM_LIVE === "1";
const TZ = "Asia/Kolkata";
type Ctx = { userId: string; organizationId: string; orgRole: "OWNER" | "MEMBER"; sessionId: string; user: { id: string; email: string; displayName: string; timezone: string } };
let aisha: Ctx;
let other: Ctx;
const ids: Record<string, string> = {};
type Plan = Extract<AgentEvent, { type: "plan" }>["plan"];

async function turn(message: string, conversationId?: string) {
  const events: AgentEvent[] = [];
  let text = "";
  const r = await runAgentTurn(aisha, { message, conversationId }, (e) => {
    events.push(e);
    if (e.type === "delta") text += e.text;
  });
  const tools = events.filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end").map((t) => `${t.name}${t.ok ? "" : "✗"}`);
  const plan = (events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }> | undefined)?.plan;
  console.log(`\n▶ ${message}\n  agents: ${events.filter((e) => e.type === "handoff").map((e) => (e as { agent: string }).agent).join(" → ")}\n  tools: ${tools.join(", ")}\n  plan: ${plan ? plan.steps.map((s) => `\n    ${s.index}. [${s.agent}] ${s.summary}${s.dependsOn.length ? ` (after ${s.dependsOn})` : ""}`).join("") : "(none)"}\n  reply: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  return { ...r, events, text, plan };
}
const logPlan = (label: string, p: { status: string; steps: { index: number; status: string; summary: string; error?: string }[] }) =>
  console.log(`  ${label}: ${p.status}${p.steps.map((s) => `\n    ${s.status} ${s.index}. ${s.summary}${s.error ? ` — ${s.error}` : ""}`).join("")}`);

describe.skipIf(!LIVE)("live: planner agent", () => {
  beforeAll(async () => {
    setLlmProviderForTests(null);
    setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
    await resetDb();
    const org = await createOrg("Acme");
    const mk = async (name: string, email: string, role: "OWNER" | "MEMBER" = "MEMBER") => {
      const u = await createUser(org.id, name, { email, role, timezone: TZ });
      return { userId: u.id, organizationId: org.id, orgRole: role, sessionId: "s", user: { id: u.id, email, displayName: name, timezone: TZ } } as Ctx;
    };
    aisha = await mk("Aisha Khan", "aisha@acme.test", "OWNER");
    ids.priya = (await mk("Priya Patel", "priya@acme.test")).userId;
    ids.amit = (await mk("Amit Kumar", "amit@acme.test")).userId;
    other = await mk("Olga Other", "olga@acme.test");
  }, 60_000);
  afterAll(() => setCallingProviderForTests("LIVEKIT", null));

  it("goals go to the planner; explicit multi-part instructions still split across specialists", async () => {
    const goal = await routeRequest({ message: "Plan a team dinner next Friday evening for Priya, Amit and me", context: [], currentMeeting: null });
    expect(goal.steps.map((s) => s.agent)).toEqual(["planner"]);
    const organise = await routeRequest({ message: "Organise lunch for the client visit tomorrow and get them a cab back to the airport", context: [], currentMeeting: null });
    expect(organise.steps.map((s) => s.agent)).toEqual(["planner"]);
    const explicit = await routeRequest({ message: "Schedule a review with Priya on Thursday at 11 and remind me at 10 to prepare", context: [], currentMeeting: null });
    expect(explicit.steps.map((s) => s.agent)).toEqual(["meetings", "reminders"]);
  }, 60_000);

  it("“plan a team dinner” → researched plan (event + table for 3 + cab after the table) → approve → all done", async () => {
    const when = new Date(Date.now() + 3 * 86400_000);
    const day = formatInTimeZone(when, TZ, "EEEE d MMMM");
    // Pick an evening time that's actually free in the sandbox that day.
    const free = (await findTableSlots(aisha, "r-green-bowl", formatInTimeZone(when, TZ, "yyyy-MM-dd"), 3)).find((s) => s.available && s.local.match(/ (19|20|21):/))!;
    const hhmm = formatInTimeZone(new Date(free.start), TZ, "HH:mm");
    const spoken = formatInTimeZone(new Date(free.start), TZ, "h:mm a").toLowerCase();
    const r = await turn(`Plan a team dinner on ${day} at ${spoken} for Priya, Amit and me at The Green Bowl, and book me a sedan there from the Acme office in Indiranagar`);
    expect(r.plan).toBeDefined();
    const plan = r.plan as Plan;
    const tools = plan.steps.map((s) => s.agent);
    expect(tools).toEqual(expect.arrayContaining(["meetings", "dining", "travel"]));
    const meeting = plan.steps.find((s) => s.agent === "meetings")!;
    expect(meeting.summary).toMatch(/priya@acme\.test/);
    expect(meeting.summary).toMatch(/amit@acme\.test/);
    expect(meeting.summary).toContain(hhmm);
    expect(plan.steps.find((s) => s.agent === "dining")!.summary).toMatch(new RegExp(`table for 3 at The Green Bowl .*${hhmm}`));
    expect(r.text).not.toMatch(/\?/); // a plan, not a question
    const cab = plan.steps.find((s) => s.agent === "travel")!;
    expect(cab.summary).toMatch(/Indiranagar/);
    expect(await db.booking.count()).toBe(0);

    const res = await decidePlan(aisha, plan.id, "approve");
    logPlan("after approval", res.plan);
    expect(res.plan.status).toBe("completed");
    expect(await db.booking.count({ where: { userId: aisha.userId, status: "CONFIRMED" } })).toBe(2);
    const m = await db.meeting.findFirstOrThrow({ where: { hostId: aisha.userId, status: "SCHEDULED" }, include: { participants: true } });
    expect(m.participants.map((p) => p.userId)).toEqual(expect.arrayContaining([ids.priya, ids.amit]));
  }, 300_000);

  it("adapts: the table fills up before approval → that step fails, the cab is skipped, a revised plan is proposed and works", async () => {
    const day = formatInTimeZone(new Date(Date.now() + 4 * 86400_000), TZ, "EEEE d MMMM");
    const r = await turn(`Plan dinner for Priya and me on ${day} at 7:30 pm at Dosa Corner, with a sedan there from the Acme office in Indiranagar`);
    const plan = r.plan as Plan;
    expect(plan).toBeDefined();
    const table = await db.agentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    const reserve = (table.steps as { tool: string; args: { start_time: string } }[]).find((s) => s.tool === "reserve_table")!;
    // Someone else books every remaining seat at that time.
    for (let i = 0; i < 10; i++) {
      try {
        await reserveTable({ ...other, user: other.user }, { restaurantId: "r-dosa-corner", start: new Date(reserve.args.start_time), partySize: 2 });
      } catch {
        break;
      }
    }
    const res = await decidePlan(aisha, plan.id, "approve");
    logPlan("first attempt", res.plan);
    expect(res.plan.steps.find((s) => s.agent === "dining")!.status).toBe("failed");
    expect(res.revision).toBeTruthy();
    logPlan("revision", res.revision!);
    expect(res.revision!.steps.map((s) => s.agent)).toContain("dining");
    expect(res.revision!.steps.find((s) => s.agent === "dining")!.summary).not.toMatch(new RegExp(formatInTimeZone(new Date(reserve.args.start_time), TZ, "HH:mm") + "\\."));
    const again = await decidePlan(aisha, res.revision!.id, "approve");
    logPlan("revision result", again.plan);
    expect(again.plan.status).toBe("completed");
  }, 300_000);

  it("doesn't invent a pickup point: asks, or leaves the cab out", async () => {
    const r = await turn("Plan lunch for Amit and me tomorrow at 1 pm at Pasta Street and get us a cab");
    if (r.plan) expect(r.plan.steps.map((s) => s.agent)).not.toContain("travel");
    else expect(r.text).toMatch(/pick ?up|where.*from|from where|starting/i);
  }, 300_000);
});
