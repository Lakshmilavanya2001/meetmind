import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setLlmProviderForTests, type ChatMessage, type CompletionResult, type LlmProvider } from "@/server/ai/llm";
import { decideAction, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { toolSpecs } from "@/server/ai/tools";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createInstantMeeting } from "@/server/services/meetings";
import { scheduleMeeting } from "@/server/services/scheduling";
import { createFakeCallingProvider } from "../fake-calling";
import { routeReply } from "../fake-llm";
import { createOrg, createUser, resetDb } from "../helpers";
import type { OrgRole } from "@/generated/prisma/enums";

// ─── Scripted model ─────────────────────────────────────────────────────
type Step = (messages: ChatMessage[]) => Partial<CompletionResult>;
let calls = 0;
const call = (name: string, args: object) => ({ id: `call_${++calls}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
function scripted(steps: Step[]): LlmProvider & { requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  return {
    model: "scripted",
    requests,
    async complete(req) {
      const routed = routeReply(req);
      if (routed) return routed;
      requests.push(req.messages);
      const step = steps.shift();
      if (!step) throw new Error("Script exhausted");
      const r = { content: "", toolCalls: [], finishReason: "stop", ...step(req.messages) };
      if (r.content) req.onDelta?.(r.content);
      return r;
    },
  };
}
/** Last tool result in the context, parsed. */
const lastTool = (m: ChatMessage[]) => JSON.parse([...m].reverse().find((x) => x.role === "tool")!.content as string);

async function run(ctx: Ctx, message: string, steps: Step[], extra: { conversationId?: string; meetingRef?: string } = {}) {
  const llm = scripted(steps);
  setLlmProviderForTests(llm);
  const events: AgentEvent[] = [];
  const { conversationId } = await runAgentTurn(ctx, { message, ...extra }, (e) => events.push(e));
  return { events, conversationId, llm };
}

type Ctx = Awaited<ReturnType<typeof setup>>["aisha"];
async function setup() {
  const org = await createOrg();
  const mk = async (name: string, email: string, role: OrgRole = "MEMBER") => {
    const u = await createUser(org.id, name, { email, role, timezone: "Asia/Kolkata" });
    return { userId: u.id, organizationId: org.id, orgRole: role, sessionId: "s", user: { id: u.id, email, displayName: name, timezone: "Asia/Kolkata" } };
  };
  return {
    org,
    aisha: await mk("Aisha Khan", "aisha@acme.test", "OWNER"),
    rahulA: await mk("Rahul Sharma", "rahul.sharma@acme.test"),
    rahulB: await mk("Rahul Sharma", "rahul.s@acme.test"),
    priya: await mk("Priya Patel", "priya@acme.test"),
  };
}

beforeEach(async () => {
  await resetDb();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
});
afterAll(() => {
  setLlmProviderForTests(null);
  setCallingProviderForTests("LIVEKIT", null);
});

describe("tool schemas", () => {
  it("exposes valid JSON-schema object parameters for every tool", () => {
    for (const t of toolSpecs()) {
      expect(t.function.parameters.type).toBe("object");
      expect(t.function.parameters).not.toHaveProperty("$schema");
    }
  });
});

describe("participant invitation workflow", () => {
  it("refuses to act on one of several same-name people until the user chooses", async () => {
    const { aisha, rahulA } = await setup();
    const meeting = await createInstantMeeting(aisha, { title: "Standup" });

    // A badly-behaved model searches, then just picks the first Rahul anyway.
    const { events, conversationId } = await run(aisha, "Add Rahul to this call", [
      () => ({ toolCalls: [call("search_users", { query: "Rahul Sharma" })] }),
      (m) => {
        const r = lastTool(m);
        expect(r.data.status).toBe("ambiguous");
        return { toolCalls: [call("invite_participants", { meeting: "current", user_ids: [r.data.candidates[0].id] })] };
      },
      (m) => {
        const r = lastTool(m);
        expect(r.ok).toBe(false);
        expect(r.error.message).toMatch(/Ask the user to choose/);
        return { content: "There are two Rahul Sharmas — which one?" };
      },
    ], { meetingRef: meeting.joinCode });
    expect(events.some((e) => e.type === "tool_end" && e.name === "search_users" && e.candidates?.length === 2)).toBe(true);
    expect(await db.meetingParticipant.count({ where: { meetingId: meeting.id } })).toBe(1); // only the host

    // The user picks by email → the invite is proposed with the exact person, and waits for confirmation.
    const picked = await run(aisha, "I mean Rahul Sharma (rahul.sharma@acme.test)", [
      () => ({ toolCalls: [call("invite_participants", { meeting: "current", user_ids: [rahulA.userId] })] }),
    ], { conversationId });
    const conf = picked.events.find((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>;
    expect(conf.summary).toMatch(/Rahul Sharma \(rahul\.sharma@acme\.test\)/);
    expect(await db.meetingParticipant.findFirst({ where: { meetingId: meeting.id, userId: rahulA.userId } })).toBeNull();
    await decideAction(aisha, conf.actionId, "confirm");
    expect(await db.meetingParticipant.findFirst({ where: { meetingId: meeting.id, userId: rahulA.userId } })).toBeTruthy();
    const log = await db.agentActionLog.findFirstOrThrow({ where: { id: conf.actionId } });
    expect(log).toMatchObject({ userId: aisha.userId, status: "SUCCEEDED" });
  });

  it("never sends invitations to email addresses the user didn't provide", async () => {
    const { org, aisha } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { allowExternalInvites: true } });
    const meeting = await createInstantMeeting(aisha, {});
    await run(aisha, "Invite Mark from the vendor", [
      () => ({ toolCalls: [call("invite_by_email", { meeting: meeting.joinCode, email: "mark@vendor.com" })] }),
      (m) => {
        expect(lastTool(m).error.message).toMatch(/not provided by the user/);
        return { content: "What is Mark's email address?" };
      },
    ]);
    expect(await db.meetingInvitation.count({ where: { inviteeEmail: "mark@vendor.com" } })).toBe(0);
  });
});

describe("sensitive actions need confirmation", () => {
  async function scheduled(ctx: Ctx, others: string[] = []) {
    const start = new Date(Date.now() + 2 * 86400_000);
    return (await scheduleMeeting(ctx, { title: "Project review", startTime: start.toISOString(), endTime: new Date(start.getTime() + 1800_000).toISOString(), participantIds: others })).meeting;
  }

  it("cancel waits for the requesting user's confirmation; it runs exactly once", async () => {
    const { aisha, priya } = await setup();
    const m = await scheduled(aisha, [priya.userId]);
    const { events } = await run(aisha, "Cancel the project review", [
      () => ({ toolCalls: [call("cancel_meeting", { meeting: m.joinCode })] }),
    ]);
    const conf = events.find((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>;
    expect(conf.summary).toMatch(/Cancel “Project review”.*notify 1 person/);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("SCHEDULED");

    await expect(decideAction(priya, conf.actionId, "confirm")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const res = await decideAction(aisha, conf.actionId, "confirm");
    expect(res).toMatchObject({ ok: true });
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("CANCELED");
    await expect(decideAction(aisha, conf.actionId, "confirm")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejecting or letting it expire changes nothing", async () => {
    const { aisha } = await setup();
    const m = await scheduled(aisha);
    const one = await run(aisha, "Cancel it", [() => ({ toolCalls: [call("cancel_meeting", { meeting: m.joinCode })] })]);
    const a1 = (one.events.find((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>).actionId;
    await decideAction(aisha, a1, "reject");
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("SCHEDULED");

    const two = await run(aisha, "Cancel it", [() => ({ toolCalls: [call("cancel_meeting", { meeting: m.joinCode })] })]);
    const a2 = (two.events.find((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>).actionId;
    await db.agentActionLog.update({ where: { id: a2 }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    await expect(decideAction(aisha, a2, "confirm")).rejects.toThrow(/expired/);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("SCHEDULED");
  });

  it("permission is checked before asking: an attendee can't even get a confirmation prompt", async () => {
    const { aisha, priya } = await setup();
    const m = await scheduled(aisha, [priya.userId]);
    const { events } = await run(priya, "Cancel the project review", [
      () => ({ toolCalls: [call("cancel_meeting", { meeting: m.joinCode })] }),
      (msgs) => {
        expect(lastTool(msgs).error.code).toBe("FORBIDDEN");
        return { content: "Only the host can cancel that meeting." };
      },
    ]);
    expect(events.some((e) => e.type === "confirmation")).toBe(false);
    expect(await db.agentActionLog.count({ where: { status: "PENDING_CONFIRMATION" } })).toBe(0);
  });

  it("workspaces can opt in to auto-execution", async () => {
    const { org, aisha } = await setup();
    await db.organization.update({ where: { id: org.id }, data: { agentAutoExecute: true } });
    const m = await scheduled(aisha);
    await run(aisha, "Cancel it", [
      () => ({ toolCalls: [call("cancel_meeting", { meeting: m.joinCode })] }),
      () => ({ content: "Cancelled." }),
    ]);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("CANCELED");
  });
});

describe("safety & robustness", () => {
  it("corrects a reply that claims an action no tool performed", async () => {
    const { aisha } = await setup();
    const { events, conversationId } = await run(aisha, "Invite Priya", [() => ({ content: "I've invited Priya to the meeting." })]);
    expect(events.some((e) => e.type === "guard")).toBe(true);
    const msgs = await db.agentMessage.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    expect(msgs.at(-1)!.content).toMatch(/no invitation was actually performed/);
  });

  it("can't reach meetings in another workspace", async () => {
    const { aisha } = await setup();
    const other = await createOrg("Other");
    const outsider = await createUser(other.id, "Olly");
    const foreign = await createInstantMeeting({ userId: outsider.id, organizationId: other.id }, { title: "Secret" });
    await run(aisha, "Who is in that meeting?", [
      () => ({ toolCalls: [call("get_meeting_participants", { meeting: foreign.joinCode })] }),
      (m) => {
        expect(lastTool(m).error.code).toBe("NOT_FOUND");
        return { content: "I can't find that meeting." };
      },
    ]);
  });

  it("reports bad tool calls back to the model instead of crashing", async () => {
    const { aisha } = await setup();
    await run(aisha, "Do something", [
      () => ({ toolCalls: [call("delete_everything", {}), { id: "x", type: "function", function: { name: "create_meeting", arguments: "{not json" } }] }),
      (m) => {
        const results = m.filter((x) => x.role === "tool").map((x) => JSON.parse(x.content as string));
        expect(results.map((r) => r.error.code)).toEqual(["UNKNOWN_TOOL", "INVALID_ARGUMENTS"]);
        return { content: "Sorry, I couldn't do that." };
      },
    ]);
  });

  it("surfaces model outages as an error without inventing a reply", async () => {
    const { aisha } = await setup();
    setLlmProviderForTests({ model: "down", complete: async () => { throw Object.assign(new (await import("@/server/errors")).AppError("PROVIDER_UNAVAILABLE", "The AI assistant is unavailable right now.")); } });
    await expect(runAgentTurn(aisha, { message: "hi" }, () => {})).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(await db.agentMessage.count({ where: { role: "ASSISTANT" } })).toBe(0);
  });

  it("only the owner can read or continue a conversation", async () => {
    const { aisha, priya } = await setup();
    const { conversationId } = await run(aisha, "hello", [() => ({ content: "Hi!" })]);
    await expect(run(priya, "continue", [() => ({ content: "x" })], { conversationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives the model the user's local time and zone", async () => {
    const { aisha } = await setup();
    const { llm } = await run(aisha, "what's the time?", [() => ({ content: "It's afternoon." })]);
    expect(llm.requests[0][0].content).toMatch(/Asia\/Kolkata/);
  });
});
