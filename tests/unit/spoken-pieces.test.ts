import { describe, expect, it } from "vitest";
import { splitSpokenPieces } from "@/server/services/translation";

describe("splitSpokenPieces (voicing a translation clause by clause while it streams)", () => {
  it("hands on a finished sentence and keeps the unfinished rest", () => {
    expect(splitSpokenPieces("नमस्ते प्रिया। क्या हम लॉन्च", false)).toEqual({ pieces: ["नमस्ते प्रिया।"], rest: " क्या हम लॉन्च" });
  });
  it("waits when a full stop is the very last character (the text may still grow)", () => {
    expect(splitSpokenPieces("The meeting is at 3.", false).pieces).toEqual([]);
  });
  it("splits at a comma only once the clause is long enough to sound natural", () => {
    expect(splitSpokenPieces("Yes, Friday works", false).pieces).toEqual([]);
    expect(splitSpokenPieces("The backend team finished the integration, and the release", false).pieces).toEqual(["The backend team finished the integration,"]);
  });
  it("speaks whatever is left at the end", () => {
    expect(splitSpokenPieces("Yes, Friday works", true)).toEqual({ pieces: ["Yes, Friday works"], rest: "" });
    expect(splitSpokenPieces("¿Quién está aquí? Nadie más", true).pieces).toEqual(["¿Quién está aquí?", "Nadie más"]);
  });
  it("handles Chinese and Japanese full stops", () => {
    expect(splitSpokenPieces("会议是明天上午十点。 请准时", false).pieces).toEqual(["会议是明天上午十点。"]);
  });
});
