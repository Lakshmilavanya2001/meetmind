/**
 * Live evaluation of the agent team (coordinator + specialists) against the real LLM.
 * Opt-in: LLM_LIVE=1 npx vitest run tests/live
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { setLlmProviderForTests } from "@/server/ai/llm";
import { runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { routeRequest } from "@/server/ai/agents";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

const LIVE = process.env.LLM_LIVE === "1";
const TZ = "Asia/Kolkata";
type Ctx = { userId: string; organizationId: string; orgRole: "OWNER" | "MEMBER"; sessionId: string; user: { id: string; email: string; displayName: string; timezone: string } };
let aisha: Ctx;

async function turn(message: string) {
  const events: AgentEvent[] = [];
  let text = "";
  await runAgentTurn(aisha, { message }, (e) => {
    events.push(e);
    if (e.type === "delta") text += e.text;
  });
  const handoffs = events.filter((e): e is Extract<AgentEvent, { type: "handoff" }> => e.type === "handoff");
  const confs = events.filter((e): e is Extract<AgentEvent, { type: "confirmation" }> => e.type === "confirmation");
  console.log(`\n▶ ${message}\n  agents: ${handoffs.map((h) => `${h.agent} (${h.task})`).join(" → ")}\n  confirm: ${confs.map((c) => c.summary).join(" | ")}\n  reply: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  return { events, text, handoffs, confs };
}

describe.skipIf(!LIVE)("live: agent team", () => {
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
    await mk("Priya Patel", "priya@acme.test");
  }, 60_000);
  afterAll(() => setCallingProviderForTests("LIVEKIT", null));

  it("the coordinator sends each kind of request to the right specialist", async () => {
    const cases: [string, string][] = [
      ["Schedule a sync with Priya tomorrow at 3 PM", "meetings"],
      ["Call Priya now", "meetings"],
      ["What did we decide about the launch date in last week's meetings?", "knowledge"],
      ["Order a margherita pizza from Pasta Street to the office", "dining"],
      ["Book a table for 4 tonight at 8", "dining"],
      ["Get me a cab from Indiranagar to the airport tomorrow at 6 am", "travel"],
      ["Remind me at 5 pm to call the bank", "reminders"],
      ["Hi! What can you do?", "general"],
    ];
    const wrong: string[] = [];
    for (const [message, agent] of cases) {
      const r = await routeRequest({ message, context: [], currentMeeting: null });
      if (r.steps.length !== 1 || r.steps[0].agent !== agent) wrong.push(`${message} → ${r.steps.map((s) => s.agent).join("+")}`);
    }
    console.log("[live] misrouted:", wrong);
    expect(wrong).toEqual([]);
  }, 120_000);

  it("“review with Priya, then a table right after” → meetings then dining, two confirmations, table after the meeting", async () => {
    const day = new Date(Date.now() + 2 * 86400_000);
    const date = formatInTimeZone(day, TZ, "EEEE d MMMM");
    const r = await turn(`Schedule a one-hour roadmap review with Priya on ${date} at 11 am, and book a table for 2 at The Green Bowl right after it`);
    expect(r.handoffs.map((h) => h.agent)).toEqual(["meetings", "dining"]);
    expect(r.confs.map((c) => c.toolName)).toEqual(["create_meeting", "reserve_table"]);
    expect(r.confs[0].summary).toMatch(/11:00–12:00.*priya@acme\.test/);
    expect(r.confs[1].summary).toMatch(/table for 2 at The Green Bowl.*(12:00|12:30|13:00)/);
  }, 180_000);

  it("“cab to the airport tomorrow 6 am, and remind me tonight at 9 to pack” → travel and reminders", async () => {
    const r = await turn("Book a sedan from Indiranagar to Kempegowda Airport tomorrow at 6 am, and remind me tonight at 9 pm to pack");
    expect(new Set(r.handoffs.map((h) => h.agent))).toEqual(new Set(["travel", "reminders"]));
    expect(new Set(r.confs.map((c) => c.toolName))).toEqual(new Set(["book_cab", "create_reminder"]));
    expect(r.confs.find((c) => c.toolName === "create_reminder")!.summary).toMatch(/21:00.*pack/i);
  }, 180_000);
});
