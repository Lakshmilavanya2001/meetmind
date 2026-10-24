/**
 * Live evaluation of Phase 11 (reminders, sandbox bookings, "the meeting we just agreed on") against the real LLM.
 * Opt-in: LLM_LIVE=1 npx vitest run tests/live
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/server/db";
import { setLlmProviderForTests } from "@/server/ai/llm";
import { decideAction, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createInstantMeeting, joinMeeting } from "@/server/services/meetings";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

const LIVE = process.env.LLM_LIVE === "1";
const TZ = "Asia/Kolkata";
type Ctx = { userId: string; organizationId: string; orgRole: "OWNER" | "MEMBER"; sessionId: string; user: { id: string; email: string; displayName: string; timezone: string } };
let aisha: Ctx;
let priyaId = "";
let call: { id: string; joinCode: string };

async function turn(message: string, opts: { conversationId?: string; meetingRef?: string } = {}) {
  const events: AgentEvent[] = [];
  let text = "";
  const { conversationId } = await runAgentTurn(aisha, { message, ...opts }, (e) => {
    events.push(e);
    if (e.type === "delta") text += e.text;
  });
  const tools = events.filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end");
  console.log(`\n▶ ${message}\n  tools: ${tools.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(", ") || "(none)"}\n  reply: ${text.replace(/\s+/g, " ").slice(0, 260)}`);
  const conf = events.find((e): e is Extract<AgentEvent, { type: "confirmation" }> => e.type === "confirmation");
  if (conf) console.log(`  confirm: ${conf.summary}`);
  return { events, text, conversationId, tools, conf, guard: events.some((e) => e.type === "guard") };
}

describe.skipIf(!LIVE)("live: tasks, bookings and the meeting just agreed on", () => {
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
    const priya = await mk("Priya Patel", "priya@acme.test");
    priyaId = priya.userId;
    call = await createInstantMeeting(aisha, { title: "Roadmap chat" });
    await joinMeeting(aisha, call.joinCode, { publicUrl: "wss://x" });
    await joinMeeting(priya, call.joinCode, { publicUrl: "wss://x" });
    const t = await db.meetingTranscript.create({ data: { meetingId: call.id, status: "PROCESSING" } });
    const lines: [string, string, string][] = [
      [aisha.userId, "Aisha Khan", "We should go through the Q3 roadmap properly, this call is too short."],
      [priya.userId, "Priya Patel", "Agreed. How about Thursday at 11 in the morning, for an hour?"],
      [aisha.userId, "Aisha Khan", "Thursday 11 works for me. Let's call it the Q3 roadmap review."],
    ];
    let ms = 60_000;
    for (const [uid, label, text] of lines) {
      await db.transcriptSegment.create({ data: { transcriptId: t.id, meetingId: call.id, speakerUserId: uid, speakerLabel: label, startMs: (ms += 6000), endMs: ms + 5000, text, language: "en", source: "LIVE_CAPTURE" } });
    }
  }, 60_000);
  afterAll(() => setCallingProviderForTests("LIVEKIT", null));

  it("“Set up the meeting we just agreed on” → Q3 roadmap review, Thursday 11:00–12:00, with Priya, awaiting confirmation", async () => {
    const r = await turn("Set up the meeting we just agreed on", { meetingRef: call.joinCode });
    expect(r.tools.map((t) => t.name)).toContain("get_recent_conversation");
    expect(r.conf?.toolName).toBe("create_meeting");
    expect(r.conf?.summary).toMatch(/roadmap/i);
    expect(r.conf?.summary).toMatch(/Thu/);
    expect(r.conf?.summary).toMatch(/11:00/);
    expect(r.conf?.summary).toMatch(/priya@acme\.test/);
    await decideAction(aisha, r.conf!.actionId, "confirm");
    const m = await db.meeting.findFirstOrThrow({ where: { title: { contains: "oadmap", mode: "insensitive" }, status: "SCHEDULED" }, include: { participants: true } });
    expect(formatInTimeZone(m.scheduledStart!, TZ, "EEEE HH:mm")).toBe("Thursday 11:00");
    expect((m.scheduledEnd!.getTime() - m.scheduledStart!.getTime()) / 60_000).toBe(60);
    expect(m.participants.map((p) => p.userId)).toContain(priyaId);
  });

  it("“Remind me tomorrow at 9 am to send the roadmap deck” → confirmed reminder at 09:00 local", async () => {
    const r = await turn("Remind me tomorrow at 9 am to send the roadmap deck");
    expect(r.guard).toBe(false);
    expect(r.conf?.toolName).toBe("create_reminder");
    await decideAction(aisha, r.conf!.actionId, "confirm");
    const rem = await db.reminder.findFirstOrThrow({ where: { userId: aisha.userId } });
    expect(rem.text).toMatch(/deck/i);
    expect(formatInTimeZone(rem.dueAt, TZ, "yyyy-MM-dd HH:mm")).toBe(`${formatInTimeZone(new Date(Date.now() + 86400_000), TZ, "yyyy-MM-dd")} 09:00`);
  });

  it("“Order food” without an address → asks for it instead of guessing", async () => {
    const r = await turn("Order two masala dosas and a filter coffee from Dosa Corner");
    expect(r.conf).toBeUndefined();
    expect(await db.booking.count()).toBe(0);
    expect(r.text).toMatch(/address|deliver/i);
    const r2 = await turn("Deliver to Acme office, 80 Feet Road, Koramangala", { conversationId: r.conversationId });
    expect(r2.conf?.toolName).toBe("order_food");
    expect(r2.conf?.summary).toMatch(/2× Masala Dosa.*1× Filter Coffee/);
    expect(r2.conf?.summary).toMatch(/Sandbox/);
    expect(r2.text).toMatch(/sandbox|no real order|not.*real/i);
  });

  it("“Book a sedan from Indiranagar to the airport at 11:30 pm today” → book_cab confirmation with fare", async () => {
    const r = await turn("Book a sedan from Indiranagar metro station to Kempegowda Airport at 11:30 pm today");
    expect(r.conf?.toolName).toBe("book_cab");
    expect(r.conf?.summary).toMatch(/Sedan.*Indiranagar.*Kempegowda/i);
    expect(r.conf?.summary).toMatch(/₹/);
  });

  it("“Book a table for 4 at Pasta Street the day after tomorrow at 8 pm” → checks slots, then asks to confirm", async () => {
    const r = await turn("Book a table for 4 at Pasta Street the day after tomorrow at 8 pm");
    expect(r.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["find_table_slots"]));
    if (r.conf) {
      expect(r.conf.toolName).toBe("reserve_table");
      expect(r.conf.summary).toMatch(/table for 4 at Pasta Street/);
    } else {
      // 8 pm may be full in the sandbox: then it must offer other times, not book silently.
      expect(r.text).toMatch(/full|not available|unavailable|other|instead/i);
    }
    expect(await db.booking.count({ where: { kind: "TABLE" } })).toBe(0);
  });
});
