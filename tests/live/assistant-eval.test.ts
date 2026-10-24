/**
 * Live evaluation against the real LLM (LLM_BASE_URL). Opt-in: LLM_LIVE=1 npx vitest run tests/live
 * Asserts on what actually happened in the database, not on the wording of replies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setLlmProviderForTests } from "@/server/ai/llm";
import { decideAction, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createInstantMeeting, joinMeeting } from "@/server/services/meetings";
import { scheduleMeeting } from "@/server/services/scheduling";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";
import { dateInZone, addDaysToDate, zonedWallTimeToUtc } from "@/lib/time";

const LIVE = process.env.LLM_LIVE === "1";
const TZ = "Asia/Kolkata";

type Ctx = { userId: string; organizationId: string; orgRole: "OWNER" | "MEMBER"; sessionId: string; user: { id: string; email: string; displayName: string; timezone: string } };
let aisha: Ctx;
const ids: Record<string, string> = {};
let liveMeeting: { id: string; joinCode: string };

async function turn(message: string, opts: { conversationId?: string; meetingRef?: string } = {}) {
  const events: AgentEvent[] = [];
  let text = "";
  const { conversationId } = await runAgentTurn(aisha, { message, ...opts }, (e) => {
    events.push(e);
    if (e.type === "delta") text += e.text;
  });
  const tools = events.filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end");
  console.log(`\n▶ ${message}\n  tools: ${tools.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(", ") || "(none)"}\n  reply: ${text.replace(/\s+/g, " ").slice(0, 220)}`);
  return { events, text, conversationId, tools, guard: events.some((e) => e.type === "guard") };
}
/** Confirm every action the assistant proposed in this turn (what the user does by clicking Confirm). */
async function confirmAll(events: AgentEvent[]) {
  for (const e of events) if (e.type === "confirmation") await decideAction(aisha, e.actionId, "confirm");
}
const confirmation = (events: AgentEvent[]) => events.find((e): e is Extract<AgentEvent, { type: "confirmation" }> => e.type === "confirmation");

describe.skipIf(!LIVE)("live assistant evaluation", () => {
  beforeAll(async () => {
    setLlmProviderForTests(null);
    setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
    await resetDb();
    const org = await createOrg("Acme");
    const mk = async (name: string, email: string, department: string, role: "OWNER" | "MEMBER" = "MEMBER") => {
      const u = await createUser(org.id, name, { email, role, timezone: TZ });
      await db.user.update({ where: { id: u.id }, data: { department } });
      return { userId: u.id, organizationId: org.id, orgRole: role, sessionId: "s", user: { id: u.id, email, displayName: name, timezone: TZ } } as Ctx;
    };
    aisha = await mk("Aisha Khan", "aisha@acme.test", "Platform", "OWNER");
    ids.rahulA = (await mk("Rahul Sharma", "rahul.sharma@acme.test", "Platform")).userId;
    ids.rahulB = (await mk("Rahul Sharma", "rahul.s@acme.test", "Design")).userId;
    ids.priya = (await mk("Priya Patel", "priya@acme.test", "Product")).userId;
    ids.amit = (await mk("Amit Kumar", "amit@acme.test", "Platform")).userId;
    liveMeeting = await createInstantMeeting(aisha, { title: "Sprint sync" });
    await joinMeeting(aisha, liveMeeting.joinCode, { publicUrl: "wss://x" });
  }, 60_000);
  afterAll(() => setCallingProviderForTests("LIVEKIT", null));

  it("“Add Rahul to this call” → asks which Rahul, then invites the chosen one", async () => {
    const a = await turn("Add Rahul to this call", { meetingRef: liveMeeting.joinCode });
    expect(a.guard).toBe(false);
    expect(await db.meetingParticipant.count({ where: { meetingId: liveMeeting.id } })).toBe(1);
    expect(a.text).toMatch(/rahul\.s@acme\.test|rahul\.sharma@acme\.test|which/i);
    const b = await turn("I mean Rahul Sharma (rahul.sharma@acme.test)", { conversationId: a.conversationId, meetingRef: liveMeeting.joinCode });
    expect(confirmation(b.events)?.summary).toMatch(/rahul\.sharma@acme\.test/);
    await confirmAll(b.events);
    const p = await db.meetingParticipant.findMany({ where: { meetingId: liveMeeting.id }, select: { userId: true } });
    expect(p.map((x) => x.userId)).toContain(ids.rahulA);
    expect(p.map((x) => x.userId)).not.toContain(ids.rahulB);
  });

  it("“Invite Priya and Amit to the meeting”", async () => {
    const r = await turn("Invite Priya and Amit to the meeting", { meetingRef: liveMeeting.joinCode });
    await confirmAll(r.events);
    const p = (await db.meetingParticipant.findMany({ where: { meetingId: liveMeeting.id } })).map((x) => x.userId);
    expect(p).toEqual(expect.arrayContaining([ids.priya, ids.amit]));
    expect(r.guard).toBe(false);
  });

  it("“Who is currently in this meeting?” uses live data", async () => {
    const r = await turn("Who is currently in this meeting?", { meetingRef: liveMeeting.joinCode });
    expect(r.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_meeting_participants"]));
  });

  it("“Schedule a call with Priya tomorrow at 3 PM” → correct time in the user's zone", async () => {
    const r = await turn("Schedule a call with Priya tomorrow at 3 PM");
    expect(confirmation(r.events)?.toolName).toBe("create_meeting");
    await confirmAll(r.events);
    const tomorrow = addDaysToDate(dateInZone(new Date(), TZ), 1);
    const m = await db.meeting.findFirst({ where: { status: "SCHEDULED", participants: { some: { userId: ids.priya } } }, orderBy: { createdAt: "desc" } });
    expect(m?.scheduledStart?.toISOString()).toBe(zonedWallTimeToUtc(tomorrow, "15:00", TZ).toISOString());
    expect(r.guard).toBe(false);
  });

  it("“Reschedule my meeting with Priya to 4 PM” → needs confirmation, then moves it", async () => {
    const r = await turn("Reschedule my call with Priya tomorrow to 4 PM");
    const c = confirmation(r.events);
    expect(c?.toolName).toBe("reschedule_meeting");
    const m = await db.meeting.findFirstOrThrow({ where: { status: "SCHEDULED", participants: { some: { userId: ids.priya } } }, orderBy: { createdAt: "desc" } });
    const tomorrow = addDaysToDate(dateInZone(new Date(), TZ), 1);
    expect(m.scheduledStart?.toISOString()).toBe(zonedWallTimeToUtc(tomorrow, "15:00", TZ).toISOString()); // unchanged until confirmed
    await decideAction(aisha, c!.actionId, "confirm");
    const after = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.scheduledStart?.toISOString()).toBe(zonedWallTimeToUtc(tomorrow, "16:00", TZ).toISOString());
  });

  it("“Cancel tomorrow's project meeting” → confirmation, not cancellation", async () => {
    const tomorrow = addDaysToDate(dateInZone(new Date(), TZ), 1);
    const start = zonedWallTimeToUtc(tomorrow, "11:00", TZ);
    const { meeting } = await scheduleMeeting(aisha, { title: "Project meeting", startTime: start.toISOString(), endTime: new Date(start.getTime() + 3600_000).toISOString(), participantIds: [ids.amit] });
    const r = await turn("Cancel tomorrow's project meeting");
    expect(confirmation(r.events)?.toolName).toBe("cancel_meeting");
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).status).toBe("SCHEDULED");
  });

  it("“Show my last five meetings”", async () => {
    const r = await turn("Show my last five meetings");
    expect(r.tools.map((t) => t.name)).toContain("list_meetings");
  });

  it("“Send the meeting link to the Platform team”", async () => {
    const m = await createInstantMeeting(aisha, { title: "Design review" });
    const r = await turn("Send the meeting link to the Platform team", { meetingRef: m.joinCode });
    await confirmAll(r.events);
    const p = (await db.meetingParticipant.findMany({ where: { meetingId: m.id } })).map((x) => x.userId);
    expect(p).toEqual(expect.arrayContaining([ids.rahulA, ids.amit]));
    expect(p).not.toContain(ids.rahulB); // Design, not Platform
  });

  it("“Find a time when Priya and Amit are available” uses the calendar tool", async () => {
    const r = await turn("Find a 30 minute slot this week when Priya and Amit are both available");
    expect(r.tools.map((t) => t.name)).toContain("find_free_slots");
  });

  it("“What did Rahul say about the deadline?” with no transcript → says so, no fabrication", async () => {
    const r = await turn("What did Rahul say about the project deadline in the last meeting?");
    expect(r.guard).toBe(false);
    expect(r.text).toMatch(/no transcript|not (yet )?available|don't have|can't|cannot|unable|no past meetings|couldn't find|no (recent|previous|ended)/i);
  });
});
