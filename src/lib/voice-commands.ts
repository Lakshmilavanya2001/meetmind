/**
 * Spoken commands in any language the call supports: "Hey Mind …" and yes/no answers.
 *
 * Indian-language speech recognition writes everything in the speaker's own script, including the
 * English words "Hey Mind", "yes" and "okay" (e.g. Telugu "హే మైండ్", Malayalam "ഹേ മൈൻഡ്").
 * Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada and Malayalam are encoded in Unicode
 * with the same layout as Devanagari, so we map them letter-for-letter to Devanagari and match one
 * set of patterns. The mapping keeps string length, so the command is cut from the original text.
 * Pure functions: used by the voice API and by the interpreter (which must not translate commands).
 */

// Malayalam chillu letters (consonants without a vowel) sit outside the shared layout.
const CHILLU: Record<number, number> = { 0x0d7a: 0x0923, 0x0d7b: 0x0928, 0x0d7c: 0x0930, 0x0d7d: 0x0932, 0x0d7e: 0x0933, 0x0d7f: 0x0915 };

/** Map the Brahmic scripts that share Devanagari's layout onto Devanagari, one code unit each. */
export function toDevanagari(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (CHILLU[c]) out += String.fromCodePoint(CHILLU[c]);
    else if (c >= 0x0980 && c <= 0x0d7f) out += String.fromCodePoint(c - (c & 0xff80) + 0x0900);
    else out += ch;
  }
  return out;
}

// Latin: "Hey Mind". Recognisers also write "hey mine", "hey meet mind", "hi mind", "okay mind".
const WAKE_LATIN = /^\s*(?:hey|hi|hay|okay|ok|hello)[\s,!.]*(?:meet\s*mind|mind|mine|mined|minds)\b[\s,!.:?-]*/i;
// Devanagari (and every script mapped onto it): हे/हाय/ओके + (मीट) + माइंड/मैंड/मैण्ट/मैनड/माइन्ड…
// Parakeet often hears Hindi "हे" before "माइंड" as "पे", "पाइ" or "फे" ("पेमाइंड", "पाइमाइंड"); none is a word.
// Those forms need the full "माइंड" sound, so "पेमेंट" (payment) doesn't count.
const WAKE_INDIC_PAY = /^\s*(?:पे|पै|पाइ|पाई|पह|पहे|फे|फै|फाइ|फह|प|फ)्?[\s,।!.]*मा(?:इ|ई)ं?न?्?ड्?(?=$|[\s,।!.?:-])[\s,।!.?:-]*/;
// Recognisers sometimes clip the first syllable ("హే" → "య్", "టే", "्"), so a short fragment made only
// of the sounds in "hey" is accepted in its place. Real words before "mind" ("నా మైండ్…", my mind) aren't.
const WAKE_INDIC = /^\s*(?:(?:हे|है|हाय|हेय|हॆ|हॆय|हाइ|हाई|हि|ओके|ओकॆ|हलो|हेलो)्?|[हयटेैाइि्]{1,3})[\s,।!.]*(?:मीट\s*)?म(?:ा|ै|ाइ|ाई|ॆ|े)?(?:ं|ँ|न्?|ण्?)(?:ड|ट|द)्?(?=$|[\s,।!.?:-])[\s,।!.?:-]*/;

// Parakeet can drop "Hey" altogether and write just "Mind", punctuated, at the very start ("माइंड! …",
// or stuttered "माइ। माइंड! …"). Accepted only with the punctuation, so "माइंड इस…" or "मेरा माइंड" isn't.
const WAKE_INDIC_BARE = /^\s*(?:मा(?:इ|ई)[\s,।!.]+)?मा(?:इ|ई)ं?(?:न्)?ड्?[,।!.]+\s*/;

export function stripWakePhrase(text: string): { woke: boolean; command: string } {
  const dev = toDevanagari(text);
  const m = WAKE_LATIN.exec(text) ?? WAKE_INDIC.exec(dev) ?? WAKE_INDIC_PAY.exec(dev) ?? WAKE_INDIC_BARE.exec(dev);
  return m ? { woke: true, command: text.slice(m[0].length).trim() } : { woke: false, command: text.trim() };
}

// Words end at whitespace/punctuation/end (`\b` only understands ASCII). An optional virama covers
// endings like Telugu "యెస్" (yes) → "यॆस्".
const END = String.raw`्?(?=$|[\s,.!?।])`;
// English, Hindi, and the native words in other languages, all as Devanagari after mapping:
// Telugu అవును/సరే, Malayalam അതെ/ശരി, Tamil ஆம்/ஆமா/சரி, Kannada ಹೌದು/ಸರಿ, Bengali হ্যাঁ, Marathi हो, Gujarati/Punjabi હા/ਹਾਂ,
// and English "yes"/"okay" written in those scripts (येस/यॆस/ओके).
const YES = new RegExp(
  String.raw`^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|go ahead|do it|please do|correct|right|haan|han|ha|ji haan|ji|theek hai|हाँ|हां|हा|जी हाँ|जी|ठीक है|कर दो|हो|येस|यॆस|यस|ओके|ओकॆ|अवुनु|सरे|सरि|शरि|अतॆ|अते|आम|आमा|चरि|हौदु|ह्याँ|ह्यां|ठिक आछे)` + END,
  "i",
);
// Telugu వద్దు/కాదు, Malayalam വേണ്ട/ഇല്ല, Tamil வேண்டாம்/இல்லை, Kannada ಬೇಡ/ಇಲ್ಲ, Bengali/Gujarati না/ના, Marathi नको/नाही, English "no" (नो).
const NO = new RegExp(
  String.raw`^(?:no|nope|nah|cancel|stop|don't|do not|never mind|wait|nahin|nahi|mat karo|नहीं|नही|नहि|मत|रुको|नो|वद्दु|कादु|वेण्ट|वेण्टा|वेण्टाम|इल्ल|इल्लै|इल्ला|बेड|बेडा|ना|नको|नाही)` + END,
  "i",
);

/** Spoken confirmation: "yes" / "no" in English or any supported Indian language. Anything else is not an answer. */
export function classifyYesNo(text: string): "yes" | "no" | null {
  const t = toDevanagari(stripWakePhrase(text).command).toLowerCase().replace(/^[\s,.!]+/, "");
  if (NO.test(t)) return "no";
  if (YES.test(t)) return "yes";
  return null;
}
