import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/server/db";
import { setLlmProviderForTests, type ChatMessage, type CompletionResult } from "@/server/ai/llm";
import { decideAction, runAgentTurn, type AgentEvent } from "@/server/ai/agent";
import { findUnbackedClaims } from "@/server/ai/guards";
import { setCallingProviderForTests } from "@/server/providers/calling";
import { createTwilioProvider, outboxProvider, setSmsProviderForTests, type SmsProvider } from "@/server/providers/sms";
import { confirmPhoneVerification, setSmsReminders, startPhoneVerification } from "@/server/services/sms";
import { cancelReminder, createReminder, sendDueReminders } from "@/server/services/reminders";
import { bookCab, cabOptions, cancelBooking, findTableSlots, orderFood, quoteFoodOrder, reserveTable } from "@/server/services/bookings";
import { updateProfile } from "@/server/services/profile";
import { createInstantMeeting, endMeeting, joinMeeting } from "@/server/services/meetings";
import { runPostCallSummaries } from "@/server/services/post-call";
import { resetRateLimits } from "@/server/rate-limit";
import { createFakeCallingProvider } from "../fake-calling";
import { routeReply } from "../fake-llm";
import { createOrg, createUser, resetDb } from "../helpers";

let n = 0;
const call = (name: string, args: object) => ({ id: `t${++n}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const script = (steps: ((m: ChatMessage[]) => Partial<CompletionResult>)[]) =>
  setLlmProviderForTests({ model: "s", complete: async (req) => { const routed = routeReply(req); if (routed) return routed; const r = { content: "", toolCalls: [], finishReason: "stop", ...steps.shift()!(req.messages) }; if (r.content) req.onDelta?.(r.content); return r; } });
const lastTool = (m: ChatMessage[]) => JSON.parse([...m].reverse().find((x) => x.role === "tool")!.content as string);

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  setCallingProviderForTests("LIVEKIT", createFakeCallingProvider());
  setSmsProviderForTests(outboxProvider);
  setLlmProviderForTests(null);
});
afterAll(() => {
  setCallingProviderForTests("LIVEKIT", null);
  setSmsProviderForTests(null);
  setLlmProviderForTests(null);
});

async function setup() {
  const org = await createOrg();
  const mk = async (name: string, tz = "Asia/Kolkata") => {
    const u = await createUser(org.id, name, { timezone: tz });
    return { userId: u.id, organizationId: org.id, orgRole: "MEMBER" as const, sessionId: "s", user: { id: u.id, email: u.email, displayName: name, timezone: tz } };
  };
  return { org, aisha: await mk("Aisha Khan"), priya: await mk("Priya Patel") };
}
type Ctx = Awaited<ReturnType<typeof setup>>["aisha"];
async function verifiedPhone(ctx: Ctx, phone = "+919812345678") {
  await updateProfile(ctx, { displayName: ctx.user.displayName, timezone: ctx.user.timezone, phoneNumber: phone });
  await startPhoneVerification(ctx);
  const code = /\b(\d{6})\b/.exec((await db.smsMessage.findFirstOrThrow({ where: { userId: ctx.userId, purpose: "verification" }, orderBy: { createdAt: "desc" } })).body)![1];
  await confirmPhoneVerification(ctx, { code });
}

describe("phone verification and SMS", () => {
  it("texts a code (hash stored, not the code); wrong codes are limited; the right code verifies", async () => {
    const { aisha } = await setup();
    await expect(startPhoneVerification(aisha)).rejects.toThrow(/Add your mobile number/);
    await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", phoneNumber: "+91 98123 45678" });
    expect(await startPhoneVerification(aisha)).toMatchObject({ provider: "outbox" });
    const sms = await db.smsMessage.findFirstOrThrow({ where: { userId: aisha.userId } });
    expect(sms).toMatchObject({ to: "+919812345678", status: "OUTBOX", purpose: "verification" });
    const code = /(\d{6})/.exec(sms.body)![1];
    const v = await db.phoneVerification.findUniqueOrThrow({ where: { userId: aisha.userId } });
    expect(v.codeHash).not.toContain(code);

    const wrong = code === "000000" ? "111111" : "000000";
    await expect(confirmPhoneVerification(aisha, { code: wrong })).rejects.toThrow(/isn't right/);
    await confirmPhoneVerification(aisha, { code });
    expect((await db.user.findUniqueOrThrow({ where: { id: aisha.userId } })).phoneVerifiedAt).not.toBeNull();
  });

  it("five wrong codes lock the code; changing the number un-verifies it and turns SMS reminders off", async () => {
    const { aisha } = await setup();
    await verifiedPhone(aisha);
    await setSmsReminders(aisha, { enabled: true });
    await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", phoneNumber: "+919800000000" });
    const u = await db.user.findUniqueOrThrow({ where: { id: aisha.userId } });
    expect(u).toMatchObject({ phoneVerifiedAt: null, smsReminders: false });
    await expect(setSmsReminders(aisha, { enabled: true })).rejects.toThrow(/Verify your mobile number/);

    await startPhoneVerification(aisha);
    for (let i = 0; i < 5; i++) await expect(confirmPhoneVerification(aisha, { code: "999999" })).rejects.toThrow();
    await expect(confirmPhoneVerification(aisha, { code: "999999" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("Twilio provider posts the message with basic auth", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ sid: "SM123" }), { status: 201 });
    }) as unknown as typeof fetch;
    const p = createTwilioProvider({ accountSid: "AC1", authToken: "tok", from: "+15550001111" }, fake);
    expect(await p.send("+919812345678", "hi")).toEqual({ status: "SENT", providerId: "SM123" });
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    expect(String(seen[0].init.body)).toBe("To=%2B919812345678&Body=hi&From=%2B15550001111");
  });
});

describe("reminders", () => {
  it("validates; delivers once in-app and by SMS to the verified number", async () => {
    const { aisha, priya } = await setup();
    await expect(createReminder(aisha, { text: "x", dueAt: new Date(Date.now() - 3600_000) })).rejects.toThrow(/already passed/);
    await expect(createReminder(aisha, { text: "x", dueAt: new Date(Date.now() + 60_000), sms: true })).rejects.toThrow(/verified mobile/);
    await verifiedPhone(aisha);
    const r = await createReminder(aisha, { text: "Call the bank", dueAt: new Date(Date.now() + 60_000), sms: true });
    await expect(cancelReminder(priya, r.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await sendDueReminders(new Date(Date.now() + 61_000))).toBe(1);
    expect(await sendDueReminders(new Date(Date.now() + 120_000))).toBe(0);
    expect(await db.reminder.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "SENT", smsStatus: "outbox" });
    expect(await db.notification.findFirst({ where: { userId: aisha.userId, type: "reminder" } })).toMatchObject({ body: "Call the bank" });
    expect(await db.smsMessage.findFirst({ where: { userId: aisha.userId, purpose: "reminder" } })).toMatchObject({ to: "+919812345678", body: "MeetMind reminder: Call the bank" });
  });

  it("an SMS failure is recorded but the in-app reminder still arrives", async () => {
    const { aisha } = await setup();
    await verifiedPhone(aisha);
    await db.user.update({ where: { id: aisha.userId }, data: { phoneVerifiedVia: "twilio" } });
    setSmsProviderForTests({ name: "twilio", send: async () => { throw new Error("Twilio 400 (21211): invalid To"); } });
    const r = await createReminder(aisha, { text: "Standup", dueAt: new Date(Date.now() + 1000), sms: true });
    await sendDueReminders(new Date(Date.now() + 5000));
    const row = await db.reminder.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("SENT");
    expect(row.smsStatus).toMatch(/^failed: Twilio 400/);
    expect(await db.notification.count({ where: { userId: aisha.userId, type: "reminder" } })).toBe(1);
  });
});

describe("sandbox bookings", () => {
  it("food: deterministic quote, ordered, cancellable within 5 minutes by the owner only", async () => {
    const { aisha, priya } = await setup();
    const order = { restaurantId: "r-spice-route", items: [{ itemId: "m-paneer-tikka", quantity: 2 }, { itemId: "m-garlic-naan", quantity: 1 }], address: "4th floor, Acme office, Indiranagar" };
    const { quote } = await quoteFoodOrder(aisha, order);
    expect(quote).toMatchObject({ subtotalPaise: 62000, taxesPaise: 3100, deliveryFeePaise: 4000, totalPaise: 69100 });
    await expect(quoteFoodOrder(aisha, { ...order, restaurantId: "r-coastal-curry" })).rejects.toThrow(/doesn't deliver/);
    await expect(quoteFoodOrder(aisha, { ...order, items: [{ itemId: "m-caviar", quantity: 1 }] })).rejects.toThrow(/isn't on/);

    const r = await orderFood(aisha, order);
    expect(r.booking).toMatchObject({ kind: "FOOD", total: "₹691", sandbox: true, status: "CONFIRMED" });
    await expect(cancelBooking(priya, r.booking.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.booking.update({ where: { id: r.booking.id }, data: { createdAt: new Date(Date.now() - 6 * 60_000) } });
    await expect(cancelBooking(aisha, r.booking.id)).rejects.toThrow(/within 5 minutes/);
  });

  it("cabs: fares are the same both ways; bad routes and past times are rejected", async () => {
    const { aisha } = await setup();
    const there = await cabOptions(aisha, "Indiranagar Metro", "Kempegowda Airport");
    const back = await cabOptions(aisha, "kempegowda airport", "Indiranagar metro");
    expect(there.map((o) => o.farePaise)).toEqual(back.map((o) => o.farePaise));
    expect(there.map((o) => o.type)).toEqual(["AUTO", "MINI", "SEDAN", "SUV"]);
    await expect(cabOptions(aisha, "Home base", "home  base")).rejects.toThrow(/same place/);
    await expect(bookCab(aisha, { pickup: "Indiranagar", drop: "MG Road", type: "MINI", pickupAt: new Date(Date.now() - 3600_000) })).rejects.toThrow(/already passed/);
    const b = await bookCab(aisha, { pickup: "Indiranagar", drop: "MG Road", type: "MINI" });
    expect(b.booking.kind).toBe("CAB");
    expect(b.driver).toMatch(/sandbox driver/);
  });

  it("tables: slots fill up; a full slot can't be reserved", async () => {
    const { aisha, priya } = await setup();
    const date = formatInTimeZone(new Date(Date.now() + 2 * 86400_000), "Asia/Kolkata", "yyyy-MM-dd");
    await expect(findTableSlots(aisha, "r-biryani-house", date, 2)).rejects.toThrow(/delivery-only/);
    const slots = await findTableSlots(aisha, "r-green-bowl", date, 2); // capacity 3 per slot
    const free = slots.find((s) => s.available)!;
    for (let i = 0; i < 3; i++) await reserveTable(i % 2 ? priya : aisha, { restaurantId: "r-green-bowl", start: free.start, partySize: 2 });
    const after = await findTableSlots(aisha, "r-green-bowl", date, 2);
    expect(after.find((s) => s.start === free.start)!.available).toBe(false);
    await expect(reserveTable(aisha, { restaurantId: "r-green-bowl", start: free.start, partySize: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("assistant: tasks, bookings and the meeting just agreed on", () => {
  it("order_food waits for confirmation showing items, total and the sandbox note", async () => {
    const { aisha } = await setup();
    const events: AgentEvent[] = [];
    script([
      () => ({ toolCalls: [call("order_food", { restaurant_id: "r-dosa-corner", items: [{ item_id: "m-masala-dosa", quantity: 2 }], delivery_address: "Acme office, Koramangala" })] }),
      () => ({ content: "Waiting for your confirmation." }),
    ]);
    await runAgentTurn(aisha, { message: "Order two masala dosas to the office in Koramangala" }, (e) => events.push(e));
    const conf = events.find((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>;
    expect(conf.summary).toMatch(/2× Masala Dosa \(₹240\).*total ₹277.*Sandbox — no real order/);
    expect(await db.booking.count()).toBe(0);
    script([() => ({ content: "Ordered (sandbox)." })]);
    await decideAction(aisha, conf.actionId, "confirm");
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ kind: "FOOD", totalPaise: 27700, userId: aisha.userId });
  });

  it("claims of ordering or booking without the tool are caught", () => {
    expect(findUnbackedClaims("I've ordered your biryani.", [])).toContain("food order");
    expect(findUnbackedClaims("Your cab has been booked.", [])).toContain("creation or booking");
    expect(findUnbackedClaims("I've ordered your biryani.", ["order_food"])).toEqual([]);
    expect(findUnbackedClaims("I have set a reminder for 5 PM.", [])).toContain("reminder");
  });

  it("“set up the meeting we just agreed on” reads only the recent lines of the call", async () => {
    const { aisha, priya } = await setup();
    const m = await createInstantMeeting(aisha, { title: "Planning" });
    await joinMeeting(aisha, m.joinCode, { publicUrl: "wss://x" });
    await joinMeeting(priya, m.joinCode, { publicUrl: "wss://x" });
    const t = await db.meetingTranscript.create({ data: { meetingId: m.id, status: "PROCESSING" } });
    const seg = (text: string, ageMin: number, startMs: number) =>
      db.transcriptSegment.create({ data: { transcriptId: t.id, meetingId: m.id, speakerUserId: priya.userId, speakerLabel: "Priya Patel", startMs, endMs: startMs + 2000, text, source: "LIVE_CAPTURE", createdAt: new Date(Date.now() - ageMin * 60_000) } });
    await seg("Old topic from earlier.", 30, 1000);
    await seg("Let's do the design review on Friday at 3 pm with Aisha.", 1, 900_000);
    script([
      () => ({ toolCalls: [call("get_recent_conversation", { minutes: 10 })] }),
      (msgs) => {
        const r = lastTool(msgs);
        expect(r.data.lines).toEqual(["[00:15:00] Priya Patel: Let's do the design review on Friday at 3 pm with Aisha."]);
        return { content: "You agreed on a design review on Friday at 3 PM." };
      },
    ]);
    await runAgentTurn(aisha, { message: "Set up the meeting we just agreed on", meetingRef: m.joinCode }, () => {});

    const outsider = await createUser(aisha.organizationId, "Olga Outside");
    const octx = { ...aisha, userId: outsider.id, user: { ...aisha.user, id: outsider.id } };
    script([() => ({ toolCalls: [call("get_recent_conversation", { meeting: m.joinCode })] }), (msgs) => ({ content: JSON.stringify(lastTool(msgs)) })]);
    const ev: AgentEvent[] = [];
    await runAgentTurn(octx, { message: "what was just said in that call?" }, (e) => ev.push(e));
    expect(JSON.stringify(ev)).toMatch(/Only people who were part of this meeting/);
  });

  it("create_reminder from the assistant is confirmed first (its text may come from others), and is for the user only", async () => {
    const { aisha } = await setup();
    const at = new Date(Date.now() + 3600_000).toISOString();
    const events: AgentEvent[] = [];
    script([() => ({ toolCalls: [call("create_reminder", { text: "Send the deck", remind_at: at })] }), () => ({ content: "Waiting for confirmation." })]);
    await runAgentTurn(aisha, { message: "Remind me in an hour to send the deck" }, (e) => events.push(e));
    const conf = events.find((e) => e.type === "confirmation") as Extract<AgentEvent, { type: "confirmation" }>;
    expect(conf.summary).toMatch(/^Remind you on .*: “Send the deck”$/);
    expect(await db.reminder.count()).toBe(0);
    script([() => ({ content: "Done." })]);
    await decideAction(aisha, conf.actionId, "confirm");
    expect(await db.reminder.findFirstOrThrow()).toMatchObject({ userId: aisha.userId, text: "Send the deck", source: "assistant", sms: false });
  });
});

describe("post-call: automatic summary and action-item reminders", () => {
  it("summarises once, notifies participants, and reminds the owner on the due date", async () => {
    const { aisha, priya } = await setup();
    await verifiedPhone(priya);
    await setSmsReminders(priya, { enabled: true });
    const m = await createInstantMeeting(aisha, { title: "Launch sync" });
    await joinMeeting(aisha, m.joinCode, { publicUrl: "wss://x" });
    await joinMeeting(priya, m.joinCode, { publicUrl: "wss://x" });
    const t = await db.meetingTranscript.create({ data: { meetingId: m.id, status: "PROCESSING" } });
    await db.transcriptSegment.create({ data: { transcriptId: t.id, meetingId: m.id, speakerUserId: priya.userId, speakerLabel: "Priya Patel", startMs: 1000, endMs: 4000, text: "I will send the launch checklist by next Friday.", source: "LIVE_CAPTURE" } });
    await endMeeting(aisha, m.joinCode);
    await db.meetingTranscript.update({ where: { id: t.id }, data: { status: "COMPLETED" } });

    let llmCalls = 0;
    setLlmProviderForTests({
      model: "s",
      complete: async () => {
        llmCalls++;
        return { content: JSON.stringify({ summary: ["Launch checklist discussed"], decisions: [], action_items: [{ task: "Send the launch checklist", owner: "Priya", due: "next Friday", segments: [1] }], open_issues: [] }), toolCalls: [], finishReason: "stop" };
      },
    });
    expect(await runPostCallSummaries()).toBe(1);
    expect(await runPostCallSummaries()).toBe(0);
    expect(llmCalls).toBe(1);

    const notes = await db.notification.findMany({ where: { type: { in: ["summary.ready", "action_items.assigned"] } } });
    expect(notes.filter((x) => x.type === "summary.ready").map((x) => x.userId).sort()).toEqual([aisha.userId, priya.userId].sort());
    expect(notes.find((x) => x.type === "action_items.assigned")).toMatchObject({ userId: priya.userId });
    const rem = await db.reminder.findFirstOrThrow();
    expect(rem).toMatchObject({ userId: priya.userId, source: "action_item", sms: true });
    expect(rem.text).toMatch(/^Due today: Send the launch checklist \(from “Launch sync”\)/);
    expect(formatInTimeZone(rem.dueAt, "Asia/Kolkata", "EEEE HH:mm")).toBe("Friday 09:00");
    // The SMS carries a fixed notice, not words from the meeting.
    await db.reminder.update({ where: { id: rem.id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await sendDueReminders();
    expect((await db.smsMessage.findFirstOrThrow({ where: { userId: priya.userId, purpose: "reminder" } })).body).toBe("MeetMind: you have an action item due today. Open MeetMind → Tasks for details.");
  });

  it("does nothing while the meeting is live or the transcript isn't final", async () => {
    const { aisha } = await setup();
    const m = await createInstantMeeting(aisha, { title: "Live one" });
    const t = await db.meetingTranscript.create({ data: { meetingId: m.id, status: "PROCESSING" } });
    await db.transcriptSegment.create({ data: { transcriptId: t.id, meetingId: m.id, speakerLabel: "A", startMs: 0, endMs: 1, text: "hi", source: "LIVE_CAPTURE" } });
    setLlmProviderForTests({ model: "s", complete: async () => { throw new Error("should not be called"); } });
    expect(await runPostCallSummaries()).toBe(0);
  });
});

describe("Phase 12 hardening", () => {
  const twilioLike = (sent: { to: string; body: string }[] = []): SmsProvider => ({ name: "twilio", send: async (to, body) => { sent.push({ to, body }); return { status: "SENT", providerId: "SM1" }; } });

  it("with real SMS, the stored and listed copy of a verification code is masked", async () => {
    const { aisha } = await setup();
    const sent: { to: string; body: string }[] = [];
    setSmsProviderForTests(twilioLike(sent));
    await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", phoneNumber: "+919812345678" });
    await startPhoneVerification(aisha);
    expect(sent[0].body).toMatch(/code is \d{6}\./);
    const row = await db.smsMessage.findFirstOrThrow({ where: { userId: aisha.userId } });
    expect(row.body).toBe("Your MeetMind verification code is ••••••. It expires in 10 minutes.");
  });

  it("without an SMS provider, verification and SMS reminders are refused", async () => {
    const { aisha } = await setup();
    setSmsProviderForTests(null);
    const prev = process.env.SMS_DEV_OUTBOX;
    delete process.env.SMS_DEV_OUTBOX;
    try {
      await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", phoneNumber: "+919812345678" });
      await expect(startPhoneVerification(aisha)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      await expect(createReminder(aisha, { text: "x", dueAt: new Date(Date.now() + 60_000), sms: true })).rejects.toThrow(/aren't set up/);
    } finally {
      if (prev !== undefined) process.env.SMS_DEV_OUTBOX = prev;
    }
  });

  it("only allowed countries can be texted; a number gets at most 5 codes a day across accounts", async () => {
    const { aisha, priya } = await setup();
    await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", phoneNumber: "+14155550100" });
    await expect(startPhoneVerification(aisha)).rejects.toThrow(/country/);
    for (const who of [aisha, priya]) await updateProfile(who, { displayName: who.user.displayName, timezone: "Asia/Kolkata", phoneNumber: "+919811111111" });
    for (let i = 0; i < 5; i++) {
      resetRateLimits();
      await startPhoneVerification(i % 2 ? priya : aisha);
    }
    resetRateLimits();
    await expect(startPhoneVerification(priya)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("parallel wrong guesses can't exceed 5 attempts", async () => {
    const { aisha } = await setup();
    await updateProfile(aisha, { displayName: "Aisha Khan", timezone: "Asia/Kolkata", phoneNumber: "+919812345678" });
    await startPhoneVerification(aisha);
    const code = /(\d{6})/.exec((await db.smsMessage.findFirstOrThrow()).body)![1];
    const wrong = Array.from({ length: 9 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"));
    const results = await Promise.allSettled(wrong.map((c) => confirmPhoneVerification(aisha, { code: c })));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect((await db.phoneVerification.findUniqueOrThrow({ where: { userId: aisha.userId } })).attempts).toBe(5);
    await expect(confirmPhoneVerification(aisha, { code })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("caps SMS per user per day; the reminder still arrives in-app", async () => {
    const { aisha } = await setup();
    await verifiedPhone(aisha);
    process.env.SMS_DAILY_LIMIT_PER_USER = "2"; // the verification code counts as one
    try {
      for (let i = 0; i < 2; i++) await createReminder(aisha, { text: `r${i}`, dueAt: new Date(Date.now() + 1000), sms: true });
      await sendDueReminders(new Date(Date.now() + 5000));
      const rows = await db.reminder.findMany({ orderBy: { text: "asc" } });
      expect(rows.map((r) => r.smsStatus)).toEqual(["outbox", "failed: Daily text-message limit reached for this account."]);
      expect(await db.notification.count({ where: { type: "reminder" } })).toBe(2);
    } finally {
      delete process.env.SMS_DAILY_LIMIT_PER_USER;
    }
  });

  it("a number verified through the dev outbox never receives real SMS", async () => {
    const { aisha } = await setup();
    await verifiedPhone(aisha); // via outbox
    const sent: { to: string; body: string }[] = [];
    setSmsProviderForTests(twilioLike(sent));
    await db.reminder.create({ data: { organizationId: aisha.organizationId, userId: aisha.userId, text: "x", dueAt: new Date(), sms: true } });
    await sendDueReminders(new Date(Date.now() + 1000));
    expect(sent).toHaveLength(0);
    expect((await db.reminder.findFirstOrThrow()).smsStatus).toMatch(/^skipped/);
  });

  it("two people can't both take the last table at the same time", async () => {
    const { aisha, priya } = await setup();
    const date = formatInTimeZone(new Date(Date.now() + 3 * 86400_000), "Asia/Kolkata", "yyyy-MM-dd");
    const free = (await findTableSlots(aisha, "r-green-bowl", date, 2)).find((s) => s.available)!;
    for (let i = 0; i < 2; i++) await reserveTable(aisha, { restaurantId: "r-green-bowl", start: free.start, partySize: 2 }); // capacity 3
    const res = await Promise.allSettled([aisha, priya, aisha, priya].map((c) => reserveTable(c, { restaurantId: "r-green-bowl", start: free.start, partySize: 2 })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.booking.count({ where: { kind: "TABLE", status: "CONFIRMED" } })).toBe(3);
  });

  it("voice commands never auto-execute, even when the workspace allows auto-execution", async () => {
    const { aisha } = await setup();
    await db.organization.update({ where: { id: aisha.organizationId }, data: { agentAutoExecute: true } });
    const events: AgentEvent[] = [];
    script([
      () => ({ toolCalls: [call("order_food", { restaurant_id: "r-dosa-corner", items: [{ item_id: "m-masala-dosa", quantity: 1 }], delivery_address: "Acme office, Koramangala" })] }),
      () => ({ content: "Say yes to confirm." }),
    ]);
    await runAgentTurn(aisha, { message: "order a masala dosa to the office in Koramangala", channel: "voice" }, (e) => events.push(e));
    expect(events.some((e) => e.type === "confirmation")).toBe(true);
    expect(await db.booking.count()).toBe(0);
  });
});
