/**
 * Live RAG evaluation with the real embedding model + LLM. Opt-in: LLM_LIVE=1 npx vitest run tests/live
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setLlmProviderForTests } from "@/server/ai/llm";
import { setEmbeddingProviderForTests } from "@/server/providers/embeddings";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { createInstantMeeting } from "@/server/services/meetings";
import { inviteUsers } from "@/server/services/invitations";
import { importTranscript } from "@/server/services/transcripts";
import { indexMeetingTranscript } from "@/server/services/transcript-index";
import { answerQuestion, type Answer } from "@/server/services/rag";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

const LIVE = process.env.LLM_LIVE === "1";
type Ctx = { userId: string; organizationId: string; orgRole: "OWNER"; sessionId: string; user: { id: string; email: string; displayName: string; timezone: string } };
let aisha: Ctx;

const MEETINGS: [string, string, string][] = [
  ["Project kickoff", "2026-09-14", `[00:15] Aisha Khan: welcome everyone lets plan the payments api project
[00:40] Rahul Sharma: i think the first api integration can be done by october thirty first
[01:10] Priya Patel: the budget for this phase is forty thousand dollars
[01:30] Amit Kumar: should we use postgres or mongodb for the database
[01:50] Aisha Khan: lets decide the database next time`],
  ["Project review", "2026-09-28", `[00:10] Aisha Khan: status update on the api integration please
[00:30] Rahul Sharma: we hit problems with the vendor sandbox so october thirty first is not realistic
[00:55] Aisha Khan: then we agree the new deadline is november fifteenth
[01:05] Rahul Sharma: agreed november fifteenth works for me
[01:20] Amit Kumar: i will complete the api integration tests by november tenth
[01:40] Priya Patel: maybe we could increase the budget to fifty thousand
[02:00] Aisha Khan: we decided to use postgres for the database architecture`],
  ["Weekly sync", "2026-10-05", `[00:10] Aisha Khan: any changes to the timeline
[00:25] Rahul Sharma: the november fifteenth deadline still holds
[00:45] Priya Patel: we still have not resolved who owns the security review
[01:00] Amit Kumar: also the budget increase has not been approved yet`],
];

async function ask(question: string, meetings?: string[]) {
  const a = await answerQuestion(aisha, { question, meetings });
  console.log(`\n▶ ${question}\n  ${a.sufficientEvidence ? "✓" : "∅"} ${a.answer.replace(/\s+/g, " ").slice(0, 400)}\n  sources: ${a.citations.map((c) => `[${c.n}] ${c.meetingTitle}@${Math.round(c.startMs / 1000)}s “${c.quote.slice(0, 50)}”`).join(" | ")}`);
  return a;
}
const cites = (a: Answer, title: string) => a.citations.some((c) => c.meetingTitle === title);

describe.skipIf(!LIVE)("live RAG evaluation", () => {
  beforeAll(async () => {
    setLlmProviderForTests(null);
    setEmbeddingProviderForTests(null);
    setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
    await resetDb();
    const org = await createOrg("Acme");
    const mk = async (name: string, email: string) => (await createUser(org.id, name, { email, role: "OWNER", timezone: "Asia/Kolkata" }));
    const a = await mk("Aisha Khan", "aisha@acme.test");
    aisha = { userId: a.id, organizationId: org.id, orgRole: "OWNER", sessionId: "s", user: { id: a.id, email: a.email, displayName: "Aisha Khan", timezone: "Asia/Kolkata" } };
    const others = [await mk("Rahul Sharma", "rahul@acme.test"), await mk("Priya Patel", "priya@acme.test"), await mk("Amit Kumar", "amit@acme.test")];
    for (const [title, day, text] of MEETINGS) {
      const m = await createInstantMeeting(aisha, { title });
      await inviteUsers(aisha, m.joinCode, others.map((o) => o.id));
      await db.meeting.update({ where: { id: m.id }, data: { startedAt: new Date(`${day}T10:00:00Z`), endedAt: new Date(`${day}T11:00:00Z`), status: "ENDED" } });
      await importTranscript(aisha, m.joinCode, { content: text });
      await indexMeetingTranscript(m.id);
    }
  }, 120_000);
  afterAll(() => setCallingProviderForTests("LIVEKIT", null));

  it("What deadline did we agree on for the API integration?", async () => {
    const a = await ask("What deadline did we agree on for the API integration?");
    expect(a.sufficientEvidence).toBe(true);
    expect(a.answer).toMatch(/november (15|fifteenth)/i);
    expect(cites(a, "Project review")).toBe(true);
  });

  it("What budget was discussed?", async () => {
    const a = await ask("What budget was discussed?");
    expect(a.sufficientEvidence).toBe(true);
    expect(a.answer).toMatch(/forty|40/i);
    expect(a.answer).toMatch(/fifty|50/i);
  });

  it("Who agreed to complete the API integration tests?", async () => {
    const a = await ask("Who agreed to complete the API integration tests?");
    expect(a.answer).toMatch(/amit/i);
    expect(a.citations.some((c) => c.speaker === "Amit Kumar")).toBe(true);
  });

  it("What did we decide about the database architecture?", async () => {
    const a = await ask("What did we decide about the database architecture?");
    expect(a.answer).toMatch(/postgres/i);
    expect(cites(a, "Project review")).toBe(true);
  });

  it("What were the unresolved issues?", async () => {
    const a = await ask("What were the unresolved issues in the last meeting?");
    expect(a.answer).toMatch(/security review/i);
  });

  it("What changed in our project deadlines over the last three meetings?", async () => {
    const codes = (await db.meeting.findMany({ orderBy: { startedAt: "asc" }, select: { joinCode: true } })).map((m) => m.joinCode);
    const a = await ask("What changed in our project deadlines over the last three meetings?", codes);
    expect(a.mode).toBe("full");
    expect(a.answer).toMatch(/october (31|thirty)/i);
    expect(a.answer).toMatch(/november (15|fifteenth)/i);
    expect(new Set(a.citations.map((c) => c.meetingTitle)).size).toBeGreaterThanOrEqual(2);
  });

  it("What did Rahul say about the project deadline?", async () => {
    const a = await ask("What did Rahul say about the project deadline?");
    expect(a.sufficientEvidence).toBe(true);
    expect(a.citations.every((c) => c.speaker === null || c.speaker === "Rahul Sharma" || c.speaker === "Aisha Khan")).toBe(true);
  });

  it("No evidence → says so instead of guessing", async () => {
    const a = await ask("What is the CEO's favourite colour?");
    expect(a.sufficientEvidence).toBe(false);
    expect(a.citations).toHaveLength(0);
  });

  it("Through the assistant: database decision with sources", async () => {
    const events: AgentEvent[] = [];
    let text = "";
    await runAgentTurn(aisha, { message: "What did we decide about the database architecture?" }, (e) => {
      events.push(e);
      if (e.type === "delta") text += e.text;
    });
    const tool = events.find((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end" && e.name === "answer_meeting_question");
    console.log(`\n▶ (assistant) database decision\n  reply: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    expect(tool?.citations?.length).toBeGreaterThan(0);
    expect(text).toMatch(/postgres/i);
    expect(events.some((e) => e.type === "guard")).toBe(false);
  });
});
