import { describe, expect, it } from "vitest";
import { speakable, takeSentences } from "@/lib/audio/speech-player";

describe("speakable", () => {
  it("drops markdown, links and code", () => {
    expect(speakable("**Done.** See [the meeting](/m/abc) or `abc-def`.")).toBe("Done. See the meeting or .");
  });
});

describe("takeSentences (speaking a reply while it streams in)", () => {
  it("returns complete sentences and keeps the unfinished tail", () => {
    const r = takeSentences("You have three meetings tomorrow. The first one is at ten", false);
    expect(r.sentences).toEqual(["You have three meetings tomorrow."]);
    expect(r.used).toBe("You have three meetings tomorrow.".length);
  });

  it("waits when the text ends right after a full stop (it may still grow, e.g. 3.5 → 3.50)", () => {
    expect(takeSentences("The total is 3.", false).sentences).toEqual([]);
  });

  it("joins very short sentences to the next one", () => {
    const r = takeSentences("Sure. I booked a table for three at seven thirty. More", false);
    expect(r.sentences).toEqual(["Sure. I booked a table for three at seven thirty."]);
  });

  it("speaks everything that's left when the reply is complete", () => {
    expect(takeSentences("Done", true).sentences).toEqual(["Done"]);
    expect(takeSentences("One more thing. Bye!", true).sentences).toEqual(["One more thing. Bye!"]);
  });

  it("splits on Hindi full stops (।)", () => {
    const r = takeSentences("आपकी मीटिंग कल सुबह दस बजे है। उसके बाद", false);
    expect(r.sentences).toEqual(["आपकी मीटिंग कल सुबह दस बजे है।"]);
  });
});
