import { describe, expect, it } from "vitest";
import { emailProvidedByUser, findUnbackedClaims, findUnconfirmedPeople, placeIsGrounded, type HistoryEntry } from "@/server/ai/guards";

const rahulA = { id: "u_a", displayName: "Rahul Sharma", email: "rahul.sharma@acme.test", title: "Backend Engineer", department: "Platform" };
const rahulB = { id: "u_b", displayName: "Rahul Sharma", email: "rahul.s@acme.test", title: "Product Designer", department: "Design" };
const ambiguous: HistoryEntry = { role: "TOOL", toolName: "search_users", resolution: { status: "ambiguous", candidates: [rahulA, rahulB] } };

describe("ambiguous people guard", () => {
  it("blocks acting on a candidate the user hasn't chosen", () => {
    const h: HistoryEntry[] = [{ role: "USER", content: "add Rahul" }, ambiguous];
    expect(findUnconfirmedPeople(h, ["u_a"])).toHaveLength(1);
  });

  it("allows the candidate the user picked by email — only that one", () => {
    const h: HistoryEntry[] = [{ role: "USER", content: "add Rahul" }, ambiguous, { role: "USER", content: "I mean Rahul Sharma (RAHUL.SHARMA@acme.test)" }];
    expect(findUnconfirmedPeople(h, ["u_a"])).toHaveLength(0);
    expect(findUnconfirmedPeople(h, ["u_b"])).toHaveLength(1);
  });

  it("allows a person later resolved uniquely by search, and unrelated people", () => {
    const h: HistoryEntry[] = [ambiguous, { role: "TOOL", toolName: "search_users", resolution: { status: "resolved", candidates: [rahulB] } }];
    expect(findUnconfirmedPeople(h, ["u_b", "u_other"])).toHaveLength(0);
  });

  it("accepts a spoken choice by a distinctive title or department word", () => {
    const h = (said: string): HistoryEntry[] => [ambiguous, { role: "USER", content: said }];
    expect(findUnconfirmedPeople(h("the backend engineer"), ["u_a"])).toHaveLength(0);
    expect(findUnconfirmedPeople(h("Rahul from design please"), ["u_b"])).toHaveLength(0);
    expect(findUnconfirmedPeople(h("the backend engineer"), ["u_b"])).toHaveLength(1);
    // Mentioning words from both candidates is not a choice.
    expect(findUnconfirmedPeople(h("backend or design, not sure"), ["u_a"])).toHaveLength(1);
  });

  it("a title word shared by several candidates doesn't pick anyone", () => {
    const g: HistoryEntry = { role: "TOOL", toolName: "search_users", resolution: { status: "ambiguous", candidates: [
      { id: "x1", displayName: "Rahul", email: "r1@t", title: "Backend Engineer" },
      { id: "x2", displayName: "Rahul", email: "r2@t", title: "Frontend Engineer" },
    ] } };
    expect(findUnconfirmedPeople([g, { role: "USER", content: "the engineer" }], ["x1"])).toHaveLength(1);
    expect(findUnconfirmedPeople([g, { role: "USER", content: "the frontend one" }], ["x2"])).toHaveLength(0);
  });

  it("the assistant naming a candidate does not count as the user choosing", () => {
    const h: HistoryEntry[] = [ambiguous, { role: "ASSISTANT", content: "I'll go with rahul.sharma@acme.test" }];
    expect(findUnconfirmedPeople(h, ["u_a"])).toHaveLength(1);
  });
});

describe("email guard", () => {
  it("only accepts addresses the user typed", () => {
    const h: HistoryEntry[] = [{ role: "USER", content: "invite vendor@outside.dev please" }];
    expect(emailProvidedByUser(h, "Vendor@Outside.dev")).toBe(true);
    expect(emailProvidedByUser(h, "rahul@outside.dev")).toBe(false);
  });
});

describe("unbacked claim guard", () => {
  it("flags completion claims without a successful tool", () => {
    expect(findUnbackedClaims("I've invited Rahul to the call.", [])).toEqual(["invitation"]);
    expect(findUnbackedClaims("The meeting has been cancelled.", ["list_meetings"])).toEqual(["cancellation"]);
    expect(findUnbackedClaims("Done, scheduled for 3 PM.", [])).toContain("creation or booking");
  });

  it("accepts claims backed by tools, questions, and negations", () => {
    expect(findUnbackedClaims("I've invited Rahul.", ["invite_participants"])).toEqual([]);
    expect(findUnbackedClaims("Should I invite Rahul Sharma or Rahul Verma?", [])).toEqual([]);
    expect(findUnbackedClaims("I haven't cancelled anything yet.", [])).toEqual([]);
    expect(findUnbackedClaims("Please confirm and I will cancel it.", [])).toEqual([]);
  });
});

describe("place grounding", () => {
  const said = "User: get me a cab from the Acme office in Indiranagar to Kempegowda airport. Tool: {\"restaurant\":\"The Green Bowl\",\"area\":\"Whitefield\"}";
  it("accepts places from the user or from tool results", () => {
    expect(placeIsGrounded("Acme office, Indiranagar", said)).toBe(true);
    expect(placeIsGrounded("Kempegowda Airport", said)).toBe(true);
    expect(placeIsGrounded("The Green Bowl, Whitefield", said)).toBe(true);
    expect(placeIsGrounded("Acme office", said)).toBe(true);
  });
  it("rejects invented places", () => {
    expect(placeIsGrounded("Aisha's home", said)).toBe(false);
    expect(placeIsGrounded("12 MG Road", said)).toBe(false);
    expect(placeIsGrounded("—", said)).toBe(false);
  });
});
