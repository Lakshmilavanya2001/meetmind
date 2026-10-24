// Deterministic safety checks that do not depend on the model behaving well.

export type HistoryEntry =
  | { role: "USER"; content: string }
  | { role: "ASSISTANT"; content: string }
  | { role: "TOOL"; toolName: string; resolution?: SearchResolution | null };

export type Candidate = { id: string; displayName: string; email: string; title?: string | null; department?: string | null };
export type SearchResolution = { status: "resolved" | "ambiguous" | "not_found"; candidates: Candidate[] };

/**
 * People the model may not act on yet: they were returned as one of several matches for a name,
 * and the user has not since identified them (by email, or via a search that resolved uniquely).
 */
export function findUnconfirmedPeople(history: HistoryEntry[], userIds: string[]) {
  const state = new Map<string, { ok: boolean; group: Candidate[] }>();
  for (const h of history) {
    if (h.role === "TOOL" && h.toolName === "search_users" && h.resolution) {
      const { status, candidates } = h.resolution;
      if (status === "resolved") for (const c of candidates) state.set(c.id, { ok: true, group: candidates });
      if (status === "ambiguous") for (const c of candidates) if (!state.get(c.id)?.ok) state.set(c.id, { ok: false, group: candidates });
    } else if (h.role === "USER") {
      const text = h.content.toLowerCase();
      for (const [id, s] of state) {
        const c = s.group.find((g) => g.id === id);
        if (!s.ok && c && (text.includes(c.email.toLowerCase()) || text.includes(id.toLowerCase()) || pickedByDistinctiveWord(text, c, s.group))) s.ok = true;
      }
    }
  }
  return userIds.filter((id) => state.get(id)?.ok === false).map((id) => ({ id, candidates: state.get(id)!.group }));
}

const STOP = new Set(["the", "and", "for", "lead", "head", "team", "senior", "junior", "one", "who"]);
const words = (s?: string | null) => (s ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * Spoken disambiguation ("the backend engineer", "Rahul from design"): the user names a word from the
 * candidate's title or department that no other candidate in the same ambiguous group has.
 */
function pickedByDistinctiveWord(text: string, c: Candidate, group: Candidate[]) {
  const said = new Set(words(text));
  const own = new Set([...words(c.title), ...words(c.department)]);
  const others = new Set(group.filter((g) => g.id !== c.id).flatMap((g) => [...words(g.title), ...words(g.department)]));
  const distinctive = [...own].filter((w) => !others.has(w) && said.has(w));
  if (distinctive.length === 0) return false;
  // And no *other* candidate is distinctively named in the same message.
  return !group.some((g) => g.id !== c.id && [...words(g.title), ...words(g.department)].some((w) => said.has(w) && !own.has(w)));
}

/** Email addresses may only come from the user — never invented or guessed by the model. */
export function emailProvidedByUser(history: HistoryEntry[], email: string) {
  const e = email.trim().toLowerCase();
  return history.some((h) => h.role === "USER" && h.content.toLowerCase().includes(e));
}

// Action verbs → tools that must have succeeded this turn for the claim to be true.
const CLAIMS: { re: RegExp; tools: string[]; label: string }[] = [
  { re: /(invited|added|sent (?:the |an? )?(?:invit|link))/, tools: ["invite_participants", "invite_by_email", "create_meeting"], label: "invitation" },
  { re: /(scheduled|booked|set up|created)/, tools: ["create_meeting", "start_instant_meeting", "book_cab", "reserve_table", "order_food", "create_reminder"], label: "creation or booking" },
  { re: /(rescheduled|moved)/, tools: ["reschedule_meeting"], label: "rescheduling" },
  { re: /(cancell?ed)/, tools: ["cancel_meeting", "cancel_booking", "cancel_reminder"], label: "cancellation" },
  { re: /(ordered|placed (?:the |an |your )?order)/, tools: ["order_food"], label: "food order" },
  { re: /(reserved)/, tools: ["reserve_table"], label: "table reservation" },
  { re: /(set (?:a |the |your )?reminder|added (?:a |the )?reminder)/, tools: ["create_reminder"], label: "reminder" },
  { re: /(removed|kicked)/, tools: ["remove_participant"], label: "removal" },
  { re: /(ended)/, tools: ["end_meeting"], label: "ending the meeting" },
];

// First-person / passive completion phrasing, e.g. "I've invited", "has been cancelled", "successfully scheduled".
const COMPLETION = /\b(?:i(?:'ve| have)?|we(?:'ve| have)?|has been|have been|was|were|is now|are now|successfully|done[,:]?|all set[,:]?)\s+(?:[a-z]+\s+){0,3}?/;

/** Find completion claims in the assistant's text that no successful tool call backs up. */
export function findUnbackedClaims(text: string, succeededTools: string[]) {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const c of CLAIMS) {
    const re = new RegExp(COMPLETION.source + c.re.source + "\\b", "i");
    if (re.test(lower) && !c.tools.some((t) => succeededTools.includes(t))) out.push(c.label);
  }
  return out;
}

// ─── Places ──────────────────────────────────────────────────────────────

const PLACE_STOP = new Set(["the", "and", "near", "for", "from", "with", "at", "to", "in", "of", "my", "our", "your"]);
const placeTokens = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/'s\b/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !PLACE_STOP.has(w));

/**
 * Addresses and pickup points may only come from the conversation (what the user said, or a place
 * a tool returned such as a restaurant), never be invented by the model. At least two thirds of the
 * place's significant words must appear in that text.
 */
export function placeIsGrounded(place: string, conversationText: string) {
  const words = placeTokens(place);
  if (words.length === 0) return false;
  const known = new Set(placeTokens(conversationText));
  const found = words.filter((w) => known.has(w)).length;
  return found >= Math.ceil((words.length * 2) / 3);
}
