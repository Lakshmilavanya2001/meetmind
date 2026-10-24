import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { setEmbeddingProviderForTests } from "@/server/providers/embeddings";
import { setLlmProviderForTests, type LlmProvider } from "@/server/ai/llm";
import { createInstantMeeting } from "@/server/services/meetings";
import { inviteUsers } from "@/server/services/invitations";
import { deleteTranscript, importTranscript } from "@/server/services/transcripts";
import { findTranscriptsNeedingIndex, indexMeetingTranscript } from "@/server/services/transcript-index";
import { answerQuestion, searchTranscripts } from "@/server/services/rag";
import { createFakeCallingProvider } from "../fake-calling";
import { createFakeEmbeddings } from "../fake-embeddings";
import { createOrg, createUser, resetDb } from "../helpers";

const llmReturning = (obj: unknown, seen?: string[]): LlmProvider => ({
  model: "fake",
  complete: async (req) => {
    seen?.push(req.messages.map((m) => m.content).join("\n"));
    return { content: JSON.stringify(obj), toolCalls: [], finishReason: "stop" };
  },
});

beforeEach(async () => {
  await resetDb();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
  setEmbeddingProviderForTests(createFakeEmbeddings());
});
afterAll(() => {
  setCallingProviderForTests("LIVEKIT", null);
  setEmbeddingProviderForTests(null);
  setLlmProviderForTests(null);
});

async function setup() {
  const org = await createOrg();
  const mk = async (name: string) => {
    const u = await createUser(org.id, name);
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, user: { displayName: name, timezone: "UTC", email: u.email } };
  };
  const host = await mk("Hana Host");
  const rahul = await mk("Rahul Sharma");
  const outsider = await mk("Olive Outsider");
  const meet = async (title: string, day: string, lines: string, people = [rahul.userId]) => {
    const m = await createInstantMeeting(host, { title });
    if (people.length) await inviteUsers(host, m.joinCode, people);
    await db.meeting.update({ where: { id: m.id }, data: { startedAt: new Date(`${day}T10:00:00Z`), status: "ENDED" } });
    await importTranscript(host, m.joinCode, { content: lines });
    await indexMeetingTranscript(m.id);
    return m;
  };
  const review = await meet("Project review", "2026-10-01", "[00:10] Rahul Sharma: the api integration deadline is november 15\n[00:30] Hana Host: agreed, november 15 it is\n[01:00] Rahul Sharma: maybe we should use postgres for the database");
  const budget = await meet("Budget sync", "2026-10-05", "[00:05] Hana Host: the marketing budget is fifty thousand dollars\n[00:20] Rahul Sharma: fine with fifty thousand");
  const secret = await meet("HR private", "2026-10-06", "[00:05] Hana Host: salary review budget is ninety thousand", []); // Rahul not invited
  return { host, rahul, outsider, review, budget, secret };
}

describe("indexing", () => {
  it("chunks and embeds transcripts; marks them indexed", async () => {
    const { review } = await setup();
    const chunks = await db.transcriptChunk.findMany({ where: { meeting: { joinCode: review.joinCode } } });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("[00:10] Rahul Sharma: the api integration deadline");
    const [{ has }] = await db.$queryRaw<{ has: boolean }[]>`SELECT "embedding" IS NOT NULL AS has FROM "TranscriptChunk" LIMIT 1`;
    expect(has).toBe(true);
    expect(await findTranscriptsNeedingIndex()).toHaveLength(0);
  });

  it("deleting a transcript removes it from search", async () => {
    const { host, budget } = await setup();
    await deleteTranscript(host, budget.joinCode);
    const hits = await searchTranscripts(host, { query: "marketing budget fifty thousand" });
    expect(hits.some((h) => h.meetingCode === budget.joinCode)).toBe(false);
  });
});

describe("hybrid search respects access", () => {
  it("finds the relevant meeting first", async () => {
    const { host, budget } = await setup();
    const hits = await searchTranscripts(host, { query: "What budget was discussed?" });
    expect(hits[0].meetingCode).toBe(budget.joinCode);
  });

  it("never returns meetings the user wasn't part of — even with matching words", async () => {
    const { rahul, outsider, secret } = await setup();
    const hits = await searchTranscripts(rahul, { query: "salary review budget ninety thousand" });
    expect(hits.some((h) => h.meetingCode === secret.joinCode)).toBe(false);
    expect(await searchTranscripts(outsider, { query: "budget" })).toEqual([]);
    const other = await createOrg("Other");
    const stranger = await createUser(other.id, "S");
    expect(await searchTranscripts({ userId: stranger.id, organizationId: other.id, orgRole: "MEMBER", user: { displayName: "S" } }, { query: "budget" })).toEqual([]);
  });

  it("filters by date and meeting", async () => {
    const { host, review } = await setup();
    const hits = await searchTranscripts(host, { query: "deadline budget", from: new Date("2026-10-04T00:00:00Z") });
    expect(hits.some((h) => h.meetingCode === review.joinCode)).toBe(false);
  });
});

describe("grounded answers", () => {
  it("returns verified citations with meeting and timestamp; drops fabricated quotes", async () => {
    const { host, review } = await setup();
    const seen: string[] = [];
    setLlmProviderForTests(llmReturning({
      answer: "The team agreed on November 15 [E1]. Rahul also said it was approved by the CEO [E9].",
      sufficient_evidence: true,
      citations: [{ excerpt: 1, quote: "agreed, november 15 it is" }, { excerpt: 1, quote: "the CEO approved it" }, { excerpt: 9, quote: "anything" }],
    }, seen));
    const a = await answerQuestion(host, { question: "What deadline did we agree on?", meetings: [review.joinCode] });
    expect(a.mode).toBe("full");
    expect(a.sufficientEvidence).toBe(true);
    expect(a.citations).toEqual([expect.objectContaining({ n: 1, meetingTitle: "Project review", startMs: 30_000, speaker: "Hana Host", quote: "agreed, november 15 it is" })]);
    // The CEO claim cited only unverifiable evidence, so the whole sentence is removed.
    expect(a.answer).toBe("The team agreed on November 15 [1].");
    expect(seen[0]).toContain("[E1] Meeting \"Project review\" (2026-10-01)");
  });

  it("points each sentence at the best-matching quote when one excerpt has several", async () => {
    const { host, review } = await setup();
    setLlmProviderForTests(llmReturning({
      answer: "Rahul set a november 15 deadline [E1]. He suggested postgres for the database [E1].",
      sufficient_evidence: true,
      citations: [{ excerpt: 1, quote: "the api integration deadline is november 15" }, { excerpt: 1, quote: "maybe we should use postgres for the database" }],
    }));
    const a = await answerQuestion(host, { question: "What did Rahul say?", meetings: [review.joinCode] });
    expect(a.answer).toBe("Rahul set a november 15 deadline [1]. He suggested postgres for the database [2].");
  });

  it("says when there isn't enough evidence — and when no citation can be verified", async () => {
    const { host, review } = await setup();
    setLlmProviderForTests(llmReturning({ answer: "Not discussed.", sufficient_evidence: false, citations: [] }));
    const a = await answerQuestion(host, { question: "What is the CEO's favourite colour?", meetings: [review.joinCode] });
    expect(a).toMatchObject({ sufficientEvidence: false, confidence: "none", citations: [] });
    expect(a.answer).toMatch(/don't contain enough information/);

    setLlmProviderForTests(llmReturning({ answer: "It's blue [E1].", sufficient_evidence: true, citations: [{ excerpt: 1, quote: "the favourite colour is blue" }] }));
    const b = await answerQuestion(host, { question: "What is the CEO's favourite colour?", meetings: [review.joinCode] });
    expect(b.sufficientEvidence).toBe(false);
    expect(b.answer).not.toMatch(/blue/);
  });

  it("keeps verified evidence when the model under-reports confidence (marked partial)", async () => {
    const { host, review } = await setup();
    setLlmProviderForTests(llmReturning({ answer: "The deadline appears to be november 15 [E1].", sufficient_evidence: false, citations: [{ excerpt: 1, quote: "november 15 it is" }] }));
    const a = await answerQuestion(host, { question: "What is the deadline?", meetings: [review.joinCode] });
    expect(a).toMatchObject({ confidence: "partial", sufficientEvidence: false, answer: "The deadline appears to be november 15 [1]." });
    expect(a.citations).toHaveLength(1);
  });

  it("cross-meeting questions use retrieval over accessible meetings only", async () => {
    const { rahul } = await setup();
    const seen: string[] = [];
    setLlmProviderForTests(llmReturning({ answer: "x", sufficient_evidence: false, citations: [] }, seen));
    const a = await answerQuestion(rahul, { question: "what budgets were discussed" });
    expect(a.mode).toBe("retrieval");
    expect(seen[0]).toContain("Budget sync");
    expect(seen[0]).not.toContain("ninety thousand");
  });

  it("refuses named meetings the user can't access", async () => {
    const { rahul, secret } = await setup();
    await expect(answerQuestion(rahul, { question: "what was said?", meetings: [secret.joinCode] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
