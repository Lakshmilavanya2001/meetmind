import { describe, expect, it } from "vitest";
import { classifyYesNo, stripWakePhrase } from "@/server/services/voice";
import { toSpeech } from "@/server/providers/tts";

describe("wake phrase", () => {
  it("recognises 'Hey Mind' and common misrecognitions, and returns the command", () => {
    expect(stripWakePhrase("Hey Mind, add Rahul to this call.")).toEqual({ woke: true, command: "add Rahul to this call." });
    expect(stripWakePhrase("hey mine who is in this meeting")).toMatchObject({ woke: true, command: "who is in this meeting" });
    // Parakeet's Hindi output joins the words, as "हेमाइंड" or "हिमाइंड" ("hi mind").
    expect(stripWakePhrase("हेमाइंड इस कॉल में कौन कौन है?")).toEqual({ woke: true, command: "इस कॉल में कौन कौन है?" });
    expect(stripWakePhrase("हिमाइंड इस कॉल में कौन कौन है?")).toEqual({ woke: true, command: "इस कॉल में कौन कौन है?" });
    expect(stripWakePhrase("हिमालय की यात्रा अगले महीने है")).toMatchObject({ woke: false }); // "Himalaya" isn't the wake phrase
    // "Hey" dropped by the recogniser: a punctuated "Mind" at the start still counts; without punctuation it doesn't.
    expect(stripWakePhrase("माइ। माइंड! इस कॉल में कौन कौन है?")).toEqual({ woke: true, command: "इस कॉल में कौन कौन है?" });
    expect(stripWakePhrase("माइंड, मीटिंग कब है?")).toEqual({ woke: true, command: "मीटिंग कब है?" });
    expect(stripWakePhrase("माइंड इस बात का ध्यान रखना")).toMatchObject({ woke: false });
    expect(stripWakePhrase("मेरा माइंड बदल गया।")).toMatchObject({ woke: false });
    // Parakeet's usual mishearings of "हे" before "माइंड".
    for (const t of ["पेमाइंड इस कॉल में कौन कौन है?", "पाइमाइंड इस कॉल में कौन कौन है?", "फेमाइंड इस कॉल में कौन कौन है?", "पे माइंड, इस कॉल में कौन कौन है?", "पमाइंड इस कॉल में कौन कौन है?"])
      expect(stripWakePhrase(t), t).toEqual({ woke: true, command: "इस कॉल में कौन कौन है?" });
    expect(stripWakePhrase("पेमेंट हो गया है।")).toMatchObject({ woke: false }); // "payment" isn't it
    expect(stripWakePhrase("परमानेंट समाधान चाहिए।")).toMatchObject({ woke: false }); // nor "permanent"
    expect(stripWakePhrase("Okay meet mind schedule a call")).toMatchObject({ woke: true, command: "schedule a call" });
    expect(stripWakePhrase("हे माइंड, राहुल को जोड़ो")).toMatchObject({ woke: true, command: "राहुल को जोड़ो" });
    expect(stripWakePhrase("Hey Mind")).toEqual({ woke: true, command: "" });
  });
  it("ignores ordinary conversation", () => {
    expect(stripWakePhrase("I don't mind if we move it to Friday").woke).toBe(false);
    expect(stripWakePhrase("hey everyone, mind the gap").woke).toBe(false);
  });
});

describe("spoken yes / no", () => {
  it("understands English and Hindi answers", () => {
    for (const y of ["yes", "Yes please", "yeah go ahead", "confirm", "haan", "हाँ", "ठीक है", "Hey Mind, yes"]) expect(classifyYesNo(y), y).toBe("yes");
    for (const n of ["no", "No, cancel that", "stop", "nahin", "नहीं", "wait"]) expect(classifyYesNo(n), n).toBe("no");
  });
  it("doesn't treat other speech as an answer", () => {
    for (const x of ["maybe", "what time is it", "Rahul is late", "I said something else"]) expect(classifyYesNo(x), x).toBeNull();
  });
});

describe("speech text", () => {
  it("drops markdown, links, emails and citation markers", () => {
    expect(toSpeech("Invite **Rahul Sharma** (rahul.sharma@acme.test) to [Standup](/m/abc) [1].\n\n- done")).toBe("Invite Rahul Sharma to Standup. done");
  });
});

describe("commands in every Indian script", () => {
  it("hears “Hey Mind” as speech recognition writes it in each script, and keeps the command in that script", () => {
    expect(stripWakePhrase("హే మైండ్, ఎయిర్‌పోర్ట్‌కి క్యాబ్ బుక్ చేయి")).toEqual({ woke: true, command: "ఎయిర్‌పోర్ట్‌కి క్యాబ్ బుక్ చేయి" }); // Telugu
    expect(stripWakePhrase("ഹേ മൈൻഡ്, ഒരു ക്യാബ് ബുക്ക് ചെയ്യൂ")).toMatchObject({ woke: true, command: "ഒരു ക്യാബ് ബുക്ക് ചെയ്യൂ" }); // Malayalam
    expect(stripWakePhrase("ஹே மைண்ட் ஒரு கேப் புக் பண்ணு")).toMatchObject({ woke: true }); // Tamil
    expect(stripWakePhrase("ಹೇ ಮೈಂಡ್ ಕ್ಯಾಬ್")).toMatchObject({ woke: true }); // Kannada
    expect(stripWakePhrase("হে মাইন্ড একটা ক্যাব")).toMatchObject({ woke: true }); // Bengali
    expect(stripWakePhrase("హాయ్ మైండ్ కాల్ ట్రాన్స్‌క్రైబ్ చేయి")).toMatchObject({ woke: true });
  });
  it("doesn't wake on ordinary speech", () => {
    for (const t of ["మైండ్ చేయకు", "హే అందరూ", "ഹലോ എല്ലാവരും"]) expect(stripWakePhrase(t).woke, t).toBe(false);
  });
  it("understands yes and no in each language, including English words written in the local script", () => {
    for (const y of ["అవును", "సరే", "యెస్", "ఓకే", "അതെ", "ശരി", "ஆமா", "சரி", "ಹೌದು", "হ্যাঁ", "ਹਾਂ"]) expect(classifyYesNo(y), y).toBe("yes");
    for (const n of ["వద్దు", "కాదు", "నో", "വേണ്ട", "ഇല്ല", "வேண்டாம்", "இல்லை", "ಬೇಡ", "ಇಲ್ಲ", "না", "ਨਹੀਂ"]) expect(classifyYesNo(n), n).toBe("no");
    expect(classifyYesNo("హలో")).toBeNull();
  });
});
