/**
 * Live check of the Uber travel flow against the real LLM, with a fake Uber (auth, Riders API sandbox) and geocoder.
 * Opt-in: LLM_LIVE=1 npx vitest run tests/live/uber-eval.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { setLlmProviderForTests } from "@/server/ai/llm";
import { decideAction, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { resetGeocodeCache } from "@/server/providers/geocode";
import { finishUberConnect, resetUberQuotes } from "@/server/services/uber";
import { createOrg, createUser, resetDb } from "../helpers";
import { uber, useFakeUber } from "../fake-uber";

const LIVE = process.env.LLM_LIVE === "1";
const TZ = "Asia/Kolkata";
type Ctx = { userId: string; organizationId: string; orgRole: "MEMBER"; sessionId: string; user: { id: string; email: string; displayName: string; timezone: string } };
let aisha: Ctx;

async function turn(message: string, conversationId?: string) {
  const events: AgentEvent[] = [];
  let text = "";
  const r = await runAgentTurn(aisha, { message, conversationId }, (e) => {
    events.push(e);
    if (e.type === "delta") text += e.text;
  });
  const tools = events.filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end");
  const conf = events.find((e): e is Extract<AgentEvent, { type: "confirmation" }> => e.type === "confirmation");
  console.log(`\n▶ ${message}\n  tools: ${tools.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join(", ") || "(none)"}\n  reply: ${text.replace(/\s+/g, " ").slice(0, 300)}${conf ? `\n  confirm: ${conf.summary}` : ""}`);
  return { conversationId: r.conversationId, tools, conf, text };
}

describe.skipIf(!LIVE)("live: Uber rides through the travel agent", () => {
  beforeAll(async () => {
    setLlmProviderForTests(null);
    useFakeUber({ passThrough: true }); // the real LLM is reached through the real fetch
    resetGeocodeCache();
    resetUberQuotes();
    await resetDb();
    const org = await createOrg("Acme");
    const u = await createUser(org.id, "Aisha Khan", { email: "aisha@acme.test", timezone: TZ });
    aisha = { userId: u.id, organizationId: org.id, orgRole: "MEMBER", sessionId: "s", user: { id: u.id, email: u.email, displayName: "Aisha Khan", timezone: TZ } };
    await finishUberConnect(aisha, "good-code");
  }, 60_000);
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("connected user: real Uber fares, then a confirmed booking in test mode, then status and cancel", async () => {
    const a = await turn("What are the Uber fares from Indiranagar, Bengaluru to Kempegowda Airport?");
    expect(a.tools.map((t) => t.name)).toContain("get_uber_options");
    expect(a.text).toMatch(/UberGo/);

    const b = await turn("Book the UberGo", a.conversationId);
    expect(b.conf?.toolName).toBe("book_uber");
    expect(b.conf?.summary).toMatch(/UberGo[^]*Indiranagar[^]*Kempegowda Airport[^]*₹250[^]*test mode/);
    await decideAction(aisha, b.conf!.actionId, "confirm");
    const ride = await db.booking.findFirstOrThrow({ where: { userId: aisha.userId, provider: "uber-sandbox" } });
    expect(uber.rides.get(ride.reference)?.status).toBe("processing");

    const c = await turn("Move my test ride along, then tell me where the driver is", a.conversationId);
    expect(c.tools.map((t) => t.name)).toContain("advance_test_ride");
    expect(c.text).toMatch(/Ravi|on the way|accepted/i);

    const d = await turn("Cancel my Uber", a.conversationId);
    expect(d.conf?.toolName).toBe("cancel_booking");
    await decideAction(aisha, d.conf!.actionId, "confirm");
    expect(uber.rides.get(ride.reference)?.status).toBe("rider_canceled");
  }, 240_000);
});
