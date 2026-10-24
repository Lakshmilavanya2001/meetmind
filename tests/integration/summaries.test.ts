import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { setLlmProviderForTests, type LlmProvider } from "@/server/ai/llm";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createInstantMeeting } from "@/server/services/meetings";
import { inviteUsers } from "@/server/services/invitations";
import { importTranscript } from "@/server/services/transcripts";
import { getLatestSummary, summarizeMeeting } from "@/server/services/summaries";
import { createFakeCallingProvider } from "../fake-calling";
import { createOrg, createUser, resetDb } from "../helpers";

const respond = (obj: unknown): LlmProvider => ({ model: "fake", complete: async () => ({ content: typeof obj === "string" ? obj : JSON.stringify(obj), toolCalls: [], finishReason: "stop" }) });

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
  const mk = async (name: string) => {
    const u = await createUser(org.id, name);
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, user: { displayName: name, timezone: "UTC", email: u.email } };
  };
  const host = await mk("Hana Host");
  const priya = await mk("Priya Patel");
  const r1 = await mk("Rahul Sharma");
  const r2 = await mk("Rahul Sharma");
  const meeting = await createInstantMeeting(host, { title: "Review" });
  await inviteUsers(host, meeting.joinCode, [priya.userId, r1.userId, r2.userId]);
  await db.meeting.update({ where: { id: meeting.id }, data: { startedAt: new Date("2026-10-05T10:00:00Z") } }); // a Monday
  await importTranscript(host, meeting.joinCode, {
    content: "[00:10] Hana Host: we will launch on the 15th\n[00:20] Priya Patel: maybe use postgres\n[00:30] Hana Host: priya please review the schema by friday\n[00:40] Rahul Sharma: who owns the docs",
  });
  return { host, priya, meeting };
}

describe("meeting summaries", () => {
  it("stores grounded decisions/action items with timestamps; drops uncited items", async () => {
    const { host, priya, meeting } = await setup();
    setLlmProviderForTests(respond({
      summary: ["Launch timing and schema review were discussed."],
      decisions: [{ text: "Launch on the 15th", segments: [1] }, { text: "Use Postgres", segments: [] }, { text: "Hallucinated", segments: [99] }],
      action_items: [
        { task: "Review the schema", owner: "Priya", due: "Friday", segments: [3] },
        { task: "Write docs", owner: "Rahul", due: null, segments: [4] },
      ],
      open_issues: [{ text: "Docs ownership unclear", segments: [4] }],
    }));
    const s = await summarizeMeeting(host, meeting.joinCode);
    expect(s.decisions).toEqual([{ text: "Launch on the 15th", evidence: [expect.objectContaining({ segment: 1, startMs: 10000, speaker: "Hana Host" })] }]);
    expect(s.droppedUncitedItems).toBe(2);
    const review = s.actionItems.find((a) => a.description === "Review the schema")!;
    expect(review).toMatchObject({ owner: "Priya Patel", ownerIsUser: true, sourceStartMs: 30000 });
    expect(review.dueDate?.toISOString()).toBe("2026-10-09T17:00:00.000Z"); // the Friday after the meeting
    // "Rahul" could be either Rahul Sharma: not assigned to a user account.
    expect(s.actionItems.find((a) => a.description === "Write docs")).toMatchObject({ owner: "Rahul", ownerIsUser: false });
    expect(s.openIssues).toHaveLength(1);
    expect(await getLatestSummary(priya, meeting.joinCode)).toMatchObject({ id: s.id, stale: false });
  });

  it("fails clearly on unreadable model output or a missing transcript", async () => {
    const { host, meeting } = await setup();
    setLlmProviderForTests(respond("not json"));
    await expect(summarizeMeeting(host, meeting.joinCode)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const empty = await createInstantMeeting(host, { title: "Empty" });
    await expect(summarizeMeeting(host, empty.joinCode)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
