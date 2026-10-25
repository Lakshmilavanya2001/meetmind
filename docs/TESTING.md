# Testing

| Layer | Command | What it covers | Latest result |
|---|---|---|---|
| Unit + integration | `npm test` | 31 files. Services against a real Postgres test database (`meetmind_test`), with fake calling, STT, embedding and LLM providers. Includes the security regression tests and the "every route is authenticated" check | **234 passed** |
| Live model evaluation | `LLM_LIVE=1 npx vitest run tests/live` | 33 scenarios (19 from the spec, 2 caption translation, 5 Phase 11 tasks, 3 agent team, 4 Planner) against the real Qwen, embedding and STT services. They assert database outcomes and citations, not wording | **33 / 33 passed** |
| Browser end-to-end | `npx playwright test`, or the Docker command below | 14 flows against the production build, through HTTPS and real LiveKit | **14 / 14 passed** (several consecutive runs) |
| Static | `npm run typecheck`, `npm run lint` | TypeScript strict, ESLint (Next + React compiler rules) | clean |

## What's covered

- **Auth and permissions:** sign-up and login; timing-safe errors; rate limiting, with no shared-bucket denial of service; session expiry and revocation; role rules (owner/admin/member/guest, host/co-host/attendee); tenant isolation; guest restrictions.
- **People:** directory search, ambiguous names (two "Rahul Sharma"s), typo suggestions that are never auto-selected, email resolution.
- **Meetings:** instant and scheduled meetings; join, removal and rejoin rules; webhooks; kicking stale tokens; conflicts (back-to-back is fine); reschedule and cancel; RSVP; free-slot search across time zones; DST-correct time conversion.
- **Invitations:** member, external and guest invitations; single-use links; notifications; email delivery status, with an SMTP circuit breaker.
- **Transcription:** consent enforced on the server; chunk idempotency; worker retries and permanent failures; silence handling; finalisation and retention purge; recording upload; VTT/SRT/text import; exports; access control; ReDoS safety.
- **Summaries:** grounding (uncited items dropped), owner resolution that never guesses between same-name people, due-date parsing.
- **Search and Q&A:** chunking, indexing, hybrid retrieval with access filtering, citation verification, removal of unsupported sentences, partial-confidence handling.
- **Assistant:** tool schemas; ambiguity, email and claim guards; confirmations that are owner-only, single-use and expiring; permission preflight; auto-execution with untrusted content; malformed tool calls; model outages; streaming client parsing.
- **Browser flows:**
  1. Two-user video call with real WebRTC media, host controls, removal and end, plus a layout regression check.
  2. Scheduling with a same-name colleague, RSVP via notification, cancellation.
  3. Assistant: picking a person, a scheduling confirmation, then cancellation with confirmation.
  4. The assistant panel inside a call.
  5. Live transcription with consent using a real speech sample, then real STT, then a real LLM summary.
  6. Cross-meeting question, cited answer, and a jump to the highlighted moment.
  7. Voice call from the directory: ringing, accept, voice layout, noise cancellation, decline.
  8. Voice assistant mid-call: a fake microphone says "Hey Mind, what meetings do I have this week?", real Riva STT, a real agent reply.
  9. Live captions: English speech, real STT and real LLM translation, shown in Hindi (Devanagari), then switched back to "as spoken".
  10. Tasks: verify a phone with the outbox code, receive an SMS reminder, add and cancel a reminder, book a sandbox table through the real assistant, confirm, then cancel it.
  11. Planner: plan a team dinner, get one plan card, approve it, see every step done and the table on the Tasks page.
  12. AI interpreter: two separate browsers with their own fake microphones (English and Hindi speech). The interpreter joins; each caller sees, and is sent audio of, the other's words in their own language; latency is reported in the call and on the meeting page.
  13. Conference: an English speaker with a Hindi and a Spanish listener; each listener gets their own language.
  14. Call summary: Try a sample call. Two speakers are identified, the summary appears automatically, the delivery panel shows in-app and email delivery, Speaker 1 is renamed, and the summary email appears in Messages.
- **Phase 11:** phone verification (hashed codes, attempt limits, re-verification on number change), Twilio request format, reminder delivery exactly once, SMS failure handling, deterministic sandbox prices, cab fares the same both ways, tables filling up, cancellation rules, confirmation for orders, the claim guard for "ordered" and "booked", recent-conversation access, and post-call summaries with reminders at 09:00 on the due day in the owner's time zone. Live Qwen checks: "set up the meeting we just agreed on", reminders, asking for a missing delivery address, cab and table confirmations.
- **Captions (Phase 10):** participant-only access, the 2-minute window, same-language lines skipping the model, one shared model call for simultaneous viewers, caching, fallback to the original on model failure or runaway output, prompt-injection handling, and the live Qwen check (English↔Hindi, names kept, an injected instruction translated rather than obeyed).
- **Interpreter, English recognition:** `tests/unit/riva-stream.test.ts` drives the Riva stream with a fake socket: a noise-only pause that Riva never answers doesn't shift later sentences to older times, an empty result answers its pause, quick back-to-back sentences stay in order, and words are never dropped when no pause is left to match. Three of the four fail on the code before the fix (the back-to-back case already worked).
- **Interpreter latency, round 2:** `tests/unit/spoken-pieces.test.ts` (where a streamed translation is cut into speakable clauses, incl. Hindi, Chinese and Japanese full stops), `tests/unit/time-stretch.test.ts` (catch-up speed shortens audio by the rate, keeps pitch within 3 % and loudness at the joins, and is used only when a sentence waited). The interpreter integration tests run the streamed pipeline with a non-streaming fake model.
- **Interpreter latency (2026-10-25):** `tests/unit/interpreter.test.ts` checks the per-speaker pause (600 ms normally, 800 ms while listening for "Hey Mind") can change during a call; `tests/unit/voice.test.ts` covers Parakeet's mishearings of Hindi "Hey Mind" and that "पेमेंट" isn't one. Latency was measured with a scratch Playwright spec (monologue to a Hindi listener, with and without "Hey Mind"), kept outside the suite. Results in docs/ARCHITECTURE.md, "Interpreter latency work".
- **Interpreted calls (2026-10-25):** `e2e/interpreter-muting.spec.ts` plays an 8-sentence English monologue (`e2e/fixtures/monologue-en.wav`) to a Hindi listener with original voices muted: the listener's page plays only the interpreter's audio (and two streams with "Full volume", as a control), still only the translation after reloading mid-call, and the monologue becomes 7–9 whole lines. `tests/unit/riva-stream.test.ts` drives the Parakeet stream with a fake socket: lines timed from word timestamps (exact to the 100 ms batch), several results for one pause become several lines in order, repeated words are dropped, an unanswered noise pause (and the nudge's padding) doesn't shift later lines, results without word timings fall back to the pause, reopening after a Riva error, the no-answer watchdog, and the keep-alive for idle sessions. The Hindi "Hey Mind" browser test passed 6/6 alone and the full suite 22/22 twice after the split-command fixes.
- **Parakeet + Magpie (2026-10-24):** `tests/unit/magpie.test.ts` checks that every call language has a Magpie voice and a Parakeet locale, the request form (locale, voice, 22050 Hz), the Arabic voice, and that a streamed error fails before any audio so the caller can fall back. `tests/unit/voice.test.ts` covers Parakeet's joined Hindi wake phrase ("हेमाइंड", "हिमाइंड") and that "हिमालय" isn't one. Browser tests: the Tamil → Hindi test became Hindi → French, and the Telugu "Hey Mind" test became Hindi with a Spanish listener (`e2e/fixtures/caller-hi-heymind.wav`, made with Magpie's Hindi voice Aria).
- **Spoken replies:** splitting a reply into sentences while it streams in (`tests/unit/speech-player.test.ts`): unfinished tails wait, very short sentences are joined, Hindi full stops (।) count, everything left is spoken at the end. The streaming endpoint itself was measured by hand (first audio ≈ 0.4 s through Caddy); there is no automated test for `/api/voice/speak` or `/api/voice/transcribe` yet.
- **Voice (Phase 9):** wake-phrase stripping (English and Hindi), yes/no classification including Devanagari, wake-mode discarding, spoken confirmations, the voice prompt, picking a person by title, and the real Riva service on English, Hindi and two-speaker samples.

## Running the browser tests

The tests need Postgres and LiveKit (`docker compose --profile livekit up -d`), a seeded database (`npm run db:seed`), and the app on :3100, preferably `npm run build && npm start`. If the host is missing Chromium's system libraries:

```bash
docker run --rm --network host --ipc=host -u $(id -u):$(id -g) -e HOME=/tmp -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test
```

## Bugs the tests found during development

- **Phase 2:** the login rate limiter counted successful logins. LiveKit control buttons had no accessible names.
- **Phase 3:** LiveKit's CSS let the video grid overflow the window.
- **Phase 5:**
  - The voice-activity detector learned continuous speech as background noise.
  - An effect returning a Promise crashed the call view.
- **Phase 6:**
  - Citation numbering pointed at the wrong quote.
  - The model under-reported confidence, so verified answers were discarded.
  - Search sections had no headings.
- **Phase 7:** the security findings listed in SECURITY.md.
- **Phase 8:** the noise-cancellation label claimed "Enhanced" before the processor was applied.
- **Phase 9:**
  - Riva reset the model when a session update omitted it, and dropped the last sentence without trailing silence.
  - Hindi "हाँ" wasn't recognised as yes, because `\b` only understands ASCII.
- **Phase 16:** recognised text containing a NUL byte made the database reject the whole recording; text is now cleaned first.
- **Phase 15:**
  - Riva returns nothing without a commit, and needs 1 s of trailing silence to finalise.
  - 10 ms audio messages made it about 4× slower than 100 ms batches.
  - A 500 ms pause split sentences at commas.
  - The noise floor couldn't adapt to a fan switching on after silence.
  - The interpreter kept empty rooms alive.
  - Two interpreter processes with one identity knocked each other out.
- **Phase 13–14:**
  - The Planner guessed argument names for actions it can't call; it now gets their exact arguments from the tool schemas.
  - Headcount: "Priya, Amit and me" became a table for 4.
  - A follow-on agent summarised the previous agent's work instead of doing its own task; fixed with an explicit handoff note.
  - The Planner invented a pickup point ("Aisha's home"); now refused by a deterministic check.
  - The speech server began returning results 1.5 s apart, so the last sentences were dropped.
- **Phase 10:** the captions button and the transcription button had near-identical icons; transcription now uses a record icon.
- **Phase 11:**
  - Action-item reminders fired at the wrong hour, because they were computed in the meeting's time zone instead of the owner's.
  - The SMS switch kept a stale on/off state after the number changed.
  - An older assistant test could read a previous "Confirmed and done" card and check too early.
- **Agent team (Phase 13):** every tool has an owner; each specialist is offered only its own tools and can't call another's; two-part handoffs in order, with per-agent audit and a single "please confirm"; waiting steps resumed on the next message; fallback to the General agent. Live: the coordinator routed 8 of 8 request types correctly, and handled "review then a table right after it" and "cab plus reminder" end to end.
- **Call summary (Phase 16):** cutting audio at quiet points, time mapping, speaker labels and turns; the sample call through the real Riva speaker-separation path (consistent speakers, right lines); the fallback when speaker separation fails; renaming speakers; delivery across in-app, email and SMS with preferences, link stripping in SMS, resend permissions, and failed email reported honestly.
- **Interpreter (Phase 15):** sentence detection (pauses, clicks, a fan switching on, long monologues), WAV handling, settings and permissions, webhook rules for the interpreter identity, the pipeline (transcript line, translations, speech, latency record, caption reuse, text-only fallback, prompt-injection handling), and the latency report's access rules.
- **Planner (Phase 14):** a researched plan runs nothing until approved, then executes every step. Invalid steps go back to the Planner. Plans can't contain other actions. Invented pickup points are refused. A step that fails at execution skips its dependants and gets a revised plan. Rejected and expired plans do nothing. Live: goals are routed to the Planner; a team dinner (event + table for 3 + cab) works end to end; adaptation after the table fills up; no invented pickup point.
- **Phase 12:** the 16 review findings in SECURITY.md. The server-side ones each have a regression test (masked codes, no-provider refusal, country and per-number limits, parallel guessing, daily caps, outbox-verified numbers, the table race, voice never auto-executing, ringing limits, translation back-off).
