# Security

This document has four parts: the controls MeetMind implements, the Phase 7 review (my own pass plus an independent review), what was fixed, and the risks that remain.

## Controls

| Area | Control | Where |
|---|---|---|
| Authentication | bcrypt (cost 12). Login takes the same time whether or not the email exists. Opaque 256-bit session tokens, stored only as SHA-256. `HttpOnly`, `SameSite=Lax` cookies, `Secure` on HTTPS. Sessions slide over 7 days. Password change revokes other sessions | `src/server/auth/*` |
| Authorisation | Every API handler is wrapped in `authed()` unless it's on an explicit public allowlist, and a test enforces this (`tests/unit/security.test.ts`). Workspace roles OWNER > ADMIN > MEMBER > GUEST, plus meeting roles HOST > COHOST > ATTENDEE, are checked in the services, not the UI. Membership is re-read on every request | `src/server/http.ts`, `src/server/services/*` |
| Tenant isolation | All queries are scoped by the session's `organizationId`. Other workspaces' meetings return `NOT_FOUND`, so their existence isn't revealed. Transcript retrieval filters by workspace and participation inside SQL | `meetings.ts`, `rag.ts` |
| Transcripts | Visible only to the host and invited or joined participants, not to everyone with the link. Each participant consents for their own audio, which the server enforces. Audio is deleted after transcription. Retention purge runs automatically. The host can delete | `transcripts.ts` |
| AI agent | Tools call the same permission-checked services. Scheduling, inviting, rescheduling, cancelling, removing and ending require user confirmation, and confirmations are single-use, owner-only and expire after 15 minutes. Deterministic guards block acting on ambiguous people, using emails the user didn't type, or claiming unperformed actions. Auto-execution, which is opt-in, is refused once other people's text is in the conversation | `src/server/ai/*` |
| Grounded answers | Citation quotes are verified against transcript text, and unsupported sentences are removed | `rag.ts` |
| Calls | LiveKit tokens are scoped to one room, last 10 minutes and grant no `roomAdmin`. Moderation goes through the API. The webhook verifies LiveKit's signature and kicks removed users or joins to rooms of meetings that aren't live | `providers/calling/livekit.ts`, `meetings.ts` |
| CSRF | `SameSite=Lax`, plus an `Origin` check on all non-GET requests. No GET request changes state | `http.ts` |
| Headers | CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), HSTS, `X-Frame-Options: DENY`, `nosniff`, COOP, restricted `Permissions-Policy` | `next.config.ts` |
| Input | zod validation on every input. Request bodies are read as streams with byte caps. Uploads are size- and type-checked. Transcript import uses linear-time parsing | `http.ts`, `multipart.ts` |
| Abuse limits | Per-user and per-IP rate limits on auth, search, the assistant, summaries and uploads. Failed logins are counted per email and IP, plus a global ceiling. A daily per-workspace transcription quota (`TRANSCRIPTION_DAILY_MINUTES_PER_ORG`). Client IP comes from `X-Forwarded-For` only behind a trusted proxy (`TRUST_PROXY`) | `rate-limit.ts`, `auth.ts` |
| Secrets | Read from env only. `.env*` and generated configs are gitignored. Integration credentials are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`). Errors never leak internals | `crypto.ts` |
| Email | Delivery status is reported honestly. SMTP pauses after an authentication failure, so a mailbox isn't locked out. User text in HTML emails is escaped | `providers/email.ts` |
| Audit | Logins, role changes, meeting lifecycle, invitations, transcription consent and export, every assistant action, and guard trips are recorded in `AuditLog` / `AgentActionLog` | `audit.ts` |
| Supply chain | `npm audit --omit=dev` reports **0 vulnerabilities** (Phase 12 upgraded Prisma to 7.10.1, removing advisories in the Prisma CLI's `deepmerge-ts` and `mysql2`). Vendored RNNoise assets are pinned and re-copied on every build, with third-party notices | `Dockerfile`, `public/noise/` |
| Voice assistant | Wake listening is opt-in, announced again whenever it's restored, uses only your own microphone (only while unmuted) and pauses while the assistant speaks. Utterances without the wake phrase are discarded unstored. Only meeting participants can send utterances (rate-limited, 700 KB cap). Voice commands never auto-execute; spoken confirmations use the same single-use, owner-only actions as typed ones. Echo cancellation always stays on | `services/voice.ts`, `noise-control.tsx` |
| Captions | Only meeting participants can read captions (same rule as transcripts). Translation prompts treat speech as data; implausible model output is dropped, not shown. Rate-limited per user | `services/translation.ts` |
| SMS | Texts go only to the user's own number, verified with a 6-digit code (hashed, 10-minute expiry, atomically counted attempts, per-user and per-number send limits). Codes are never stored or shown, except in the explicitly enabled development outbox. Numbers verified through the outbox never receive real SMS. Destination country allowlist (`SMS_ALLOWED_PREFIXES`), plus per-user and global daily caps. Every message is logged | `services/sms.ts` |
| Bookings | Every order, cab, reservation and cancellation needs user confirmation naming the price and details. Sandbox provider: no payment details are collected or stored. Owner-only listing and cancellation. The "Open in Uber" link only opens Uber with the route filled in; nothing is booked or paid from MeetMind. To build it, cab place names (not user identities) are sent to the geocoder set in `GEOCODER_URL` (off when empty). The chat renders only in-app links and `https://m.uber.com` links, so a tool result can't show any other address | `services/bookings.ts`, `ai/tools.ts`, `lib/uber-link.ts`, `providers/geocode.ts` |
| Uber connection | Each user connects only their own Uber account. OAuth state is a one-time random value in an httpOnly, SameSite=Lax cookie bound to the user id and checked in constant time, so another site can't attach its account to a user. Tokens are encrypted at rest (AES-256-GCM), never sent to the browser or the model, and revoked on disconnect. Every Uber booking needs confirmation showing route and fare, and is re-priced at booking time (refused if more than 10% above the agreed fare). Test mode (`UBER_ENV=sandbox`) is the default; real rides need an explicit setting and Uber's approval. Rides are owner-only for status, test-stage changes and cancelling | `services/uber.ts`, `providers/uber.ts`, `api/integrations/uber/*` |
| Planner | Plans are researched with read-only tools only. Every step is checked by the same preflight as a single confirmation and shown as an exact description. One approval covers exactly the listed steps: owner-only, single-use, 15-minute expiry. Changes after a failure need a new approval. Addresses and pickup points must come from the user or a tool | `ai/plans.ts`, `ai/agent.ts` |
| Summary delivery | Summaries go only to the call's participants. Email content is HTML-escaped. SMS strips links, emails and phone numbers from AI text, adds only the app's own link, and goes only to verified numbers. Resending is host/co-host only and rate-limited. Recorded text is cleaned of control characters before storage | `services/summary-delivery.ts`, `jobs/transcription-worker.ts` |
| AI interpreter | Joins only live calls where a host switched on interpretation or transcription (with transcription only it transcribes and sends text, no voice). It listens only to people who gave transcription consent, and withdrawing consent stops it at once. Its identity can't be obtained by users, and the webhook removes it when both are off. Clients accept interpreter messages only from that identity, and LiveKit sets identities server-side. Translation prompts treat speech as data. A speaker's voice choice only changes how their own speech sounds, is checked against the voice server's list (ids are also pattern-checked before reaching Magpie), and previews are rate limited (20 a minute) | `interpreter/`, `services/interpretation.ts` |
| Post-call automation | Summaries go only to the meeting's participants. Action-item reminders go only to participants named as owners (never guessed between same-name people) | `services/post-call.ts` |

## Phase 7 review: findings and fixes

There were two passes: my own review, then an independent read-only review of the whole codebase. Each confirmed finding was fixed and has a regression test in `tests/integration/security-fixes.test.ts` or `tests/unit/security.test.ts`.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | A removed guest could re-enter by reusing their accepted emailed invitation link | Links are single-use. A link can never clear a host's removal. Removing someone revokes their invitations |
| 2 | High | Any workspace member with an old link could "join" an ended meeting, become a participant, and read its transcript | Only existing participants can reopen an ended meeting |
| 3 | High | Quadratic regexes in transcript import (ReDoS). A 2 MB file could block the server for minutes | Linear-time patterns, a line-length cap, and a 1 MB limit. Adversarial 1 MB inputs parse in under 20 ms |
| 4 | Medium | A removed participant could rejoin the call with their still-valid 10-minute token, and a stale token could reopen an ended meeting | The webhook kicks anyone not entitled to be in a live meeting. Room creation no longer changes meeting status |
| 5 | Medium | Text in transcripts, titles or names could steer the AI into inviting people without the user noticing (prompt injection) | Invites and scheduling now need confirmation that names the exact people. Auto-execution is disabled once untrusted text is in context |
| 6 | Medium | Upload size was checked after buffering, and there were no quotas on transcription or summary cost | Streamed byte caps, a daily per-workspace transcription quota, and per-user summary limits |
| 7 | Low | Co-hosts could wipe the transcript via import-replace, and could mute the host | Both are now host-only |
| 8 | Low | Open redirect after login via `/\evil.com` | Strict same-origin check |
| 9 | Low | Others could lock an account with failed logins. Busy times leaked across workspaces. `.ics` CR injection | Per-IP lockout with a global ceiling, a workspace filter, and CR stripping |
| — | Medium (own review) | Spoofable `X-Forwarded-For` let clients dodge IP rate limits, and an "unknown IP" shared bucket let one abuser block every login or signup | Only the proxy-appended hop is used, with `TRUST_PROXY` only. No shared per-IP bucket |

## Phase 12 review: findings and fixes

Two independent read-only reviews covered the Phase 8–11 code: one server-side, one for the browser and deployment. Each confirmed finding was fixed. Server-side fixes have regression tests in `tests/integration/tasks.test.ts`, `calls.test.ts` and `captions.test.ts`.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | The text-message log stored and showed verification codes. Anyone could "verify" someone else's number, then text them reminder messages | Codes are stored masked. The code-showing outbox runs only with an explicit `SMS_DEV_OUTBOX=true`; without Twilio, SMS is off. Outbox-verified numbers never get real SMS |
| 2 | Medium | Parallel requests could try far more than 5 codes | Each attempt is claimed atomically before comparing, plus a per-user rate limit on verification |
| 3 | Medium | Unbounded SMS cost from reminders | Per-user and global daily caps in `sendSms`. Over the cap, the reminder still arrives in-app |
| 4 | Medium | Codes could be texted to any number worldwide (SMS pumping, harassment) | Country allowlist (default `+91`), and at most 5 codes per number per day across all accounts |
| 5 | Medium | Text others said in a call could make the assistant set an SMS reminder or cancel reminders without confirmation | Reminder creation and cancellation are now confirmed actions |
| 6 | Medium | With speakers, another participant's voice could command the assistant; with auto-execute on, voice commands skipped confirmation | Voice never auto-executes. Echo cancellation can no longer be switched off |
| 7 | Medium | The noise control dropped the chosen microphone, never applied "Off", and could get stuck on "applying…" | Keeps the device ID, applies changes one at a time in order, and shows only what was really applied |
| 8 | Medium | The production env template lacked every new variable | Added Riva, TTS, Twilio, SMS limits and API keys |
| 9 | Medium | Restored "Hey Mind" listening was silent | A notice each time it's restored in a call |
| 10 | Low | Action-item SMS carried meeting text | SMS uses a fixed notice; the details stay in the app |
| 11 | Low | Workspace members outside a direct call could ring its participants and read ring states | Only the host and current participants |
| 12 | Low | Accepting a ring didn't re-check the call | Accept requires a live call, a non-removed participant and workspace membership |
| 13 | Low | Two simultaneous reservations could overbook a table slot | Advisory lock per restaurant and slot, with capacity re-checked inside it |
| 14 | Low | A failed translation was retried on every caption poll | Paused for 30 s per line and language |
| 15 | Low | Audio and requests could continue after leaving a call. Polling ran in hidden tabs. The incoming-call dialog had no focus trap or Escape | Cleanup on leave, visibility-aware and adaptive polling, and a Radix alert dialog (Escape declines) |
| 16 | Low | A nested `deploy/.env.production` could enter the Docker build context. The vendored RNNoise assets could drift, and its notice was incomplete | `**/.env*` in `.dockerignore`, the package pinned and copied on every build, third-party notices added |

## Residual risks and recommendations

- **Rate limits are in memory.** They're per instance. With more than one app replica, move them to Redis or Postgres.
- **CSP allows `'unsafe-inline'` scripts.** Next.js needs it without per-request nonces. Moving to nonce-based CSP via `proxy.ts` is a hardening option.
- **Display names are self-chosen.** Transcript speaker labels come from them. Attribution is tied to the account (`speakerUserId`), but two people can choose similar names. The UI shows emails wherever people are picked.
- **No password reset or email verification yet.** Both need working SMTP. Admins can remove accounts, and users can change their password while signed in.
- **Citation checks prove a quote exists, not that it's on-topic.** See `ARCHITECTURE.md`, Phase 6 limitations.
- **The development certificate is self-signed.** Production uses Let's Encrypt via Caddy (`deploy/`).
- **Wake-phrase detection happens on the server.** With "Hey Mind" on, each utterance from your unmuted microphone is sent to speech recognition, then discarded unless it starts with the wake phrase. Push-to-talk avoids this.
- **Voice confirmation trusts the local microphone.** Echo cancellation is always on, but someone physically next to the user can still say "yes". The on-screen Yes/No buttons are always available.
- **Sandbox bookings.** No payment data is handled. Real providers will need payment-provider integration and their own review.
- **Workspace join codes grant membership.** Admins should regenerate a code if it leaks. External people should be invited as guests, with external invitations enabled per workspace.
