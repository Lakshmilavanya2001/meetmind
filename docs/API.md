# REST API

All endpoints return JSON. Errors use the shape `{ "error": { "code", "message", "fields?" } }`. The codes are:

| Code | HTTP status |
|---|---|
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `VALIDATION` | 400 |
| `CONFLICT` | 409 |
| `RATE_LIMITED` | 429 |
| `INTERNAL` | 500 |

Authenticated endpoints need the `mm_session` cookie.

## Auth
| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/api/auth/signup` | `displayName, email, password, timezone, workspaceMode: "create"\|"join", workspaceName?, joinCode?` | Sets session cookie |
| POST | `/api/auth/login` | `email, password` | Sets session cookie; rate-limited |
| POST | `/api/auth/logout` | – | Deletes the session |
| GET | `/api/auth/me` | – | `{ user, organizationId, orgRole }` |

## Directory & profile
| Method | Path | Notes |
|---|---|---|
| GET | `/api/users?q=&limit=` | Search your workspace (name tokens or email) |
| GET | `/api/users/resolve?name=` | `{status:"resolved",user}` \| `{status:"ambiguous",candidates}` \| `{status:"not_found",suggestions}` |
| GET / PATCH | `/api/profile` | `displayName, title, department, timezone` |
| POST | `/api/profile/password` | `currentPassword, newPassword`; signs out other sessions |

## Workspace (admin actions need ADMIN or OWNER)
| Method | Path | Notes |
|---|---|---|
| GET / PATCH | `/api/workspace` | Settings. The join code is visible to admins only. |
| POST | `/api/workspace/join-code` | Regenerate the join code |
| GET | `/api/workspace/members` | List members |
| PATCH | `/api/workspace/members/:userId` | `{ role }`. Only owners can grant or remove the owner role, and the last owner is protected. |
| DELETE | `/api/workspace/members/:userId` | Removes the member and ends their sessions |

## Meetings
`:ref` is a meeting code (`abc-defg-hij`), a meeting id, or a full meeting link.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/meetings?scope=upcoming\|recent&limit=` | any member | Meetings you host or attend |
| POST | `/api/meetings` | any member | `{ title? }`. Starts an instant meeting with you as host and returns `{ meeting: { id, joinCode, title } }`. |
| GET | `/api/meetings/:ref` | workspace members | Meeting details and your role |
| POST | `/api/meetings/:ref/join` | workspace members (not removed) | `{ serverUrl, token, expiresAt, myRole, sessionStartedAt }`. The token is valid for 10 minutes and covers one room. |
| GET | `/api/meetings/:ref/participants` | workspace members | Live participants with mic, camera and screen-share state, plus their roles |
| POST | `/api/meetings/:ref/participants/:userId/mute` | host / co-host | Mutes their microphone |
| PATCH | `/api/meetings/:ref/participants/:userId` | host | `{ role: "COHOST" \| "ATTENDEE" }` |
| DELETE | `/api/meetings/:ref/participants/:userId` | host / co-host | Removes and blocks rejoin. The host can't be removed, and only the host can remove a co-host. |
| POST | `/api/meetings/:ref/end` | host / co-host | Ends the meeting for everyone |

## Scheduling (Phase 3)
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/meetings/schedule` | members | `{ title, description?, startTime, endTime, timezone?, participantIds[], allowConflicts? }`. Times are ISO 8601 with an offset. Returns `201 { meeting, invited[{…, emailStatus}], conflicts }`, or `409 CONFLICT` with `details.conflicts`. |
| POST | `/api/meetings/:ref/reschedule` | host / co-host | `{ startTime, endTime, allowConflicts? }`. Notifies all participants. |
| POST | `/api/meetings/:ref/cancel` | host | Scheduled meetings only. Frees calendars, revokes invitations and notifies everyone. |
| POST | `/api/meetings/:ref/invitations` | host / co-host | Either `{ userIds[] }`, which returns `results[{status: invited\|already_invited\|reinvited, emailStatus}]`, or `{ email }`, which returns `{kind:"member",…}` or `{kind:"external", inviteLink, emailStatus}`. |
| POST | `/api/meetings/:ref/rsvp` | invitee | `{ response: "accept" \| "decline" }` |
| GET | `/api/invitations` | any | Your pending invitations |
| GET | `/api/calendar?start&end` | any | Your own calendar events |
| POST | `/api/calendar/availability` | members | `{ userIds[], start, end }`. Returns busy blocks (other people's titles hidden) and a `note` about data sources. |
| POST | `/api/calendar/free-slots` | members | `{ userIds[], rangeStart, rangeEnd, durationMinutes, limit? }`. Finds common free slots within working hours. |

## Notifications & workspaces
| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications` | `{ items, unread }` |
| POST | `/api/notifications/read` | `{ ids? }`. Omit `ids` to mark all read. Only your own notifications are affected. |
| GET | `/api/auth/workspaces` | Workspaces you belong to, including guest memberships |
| POST | `/api/auth/workspaces/switch` | `{ organizationId }` |

## External invitation links (public)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/invite/:token` | Preview of the invitation: meeting title, host and time |
| POST | `/api/invite/:token/signup` | `{ displayName, password }`. Creates a guest account for the invited email and signs in. |
| POST | `/api/invite/:token/accept` | Signed-in only, and only if your email matches the invite. Grants guest access and switches you to that workspace. |

## Assistant (Phase 4; agent team since Phase 13)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/assistant/chat` | `{ message, conversationId?, meetingRef?, channel?: "text" \| "voice", language? }`. `channel: "voice"` means the question was spoken and the answer will be read aloud, so the assistant answers in one or two short plain sentences. Responds with `text/event-stream` events: `conversation`, `delta`, `tool_start`, `tool_end` (with `candidates` when a name is ambiguous), `confirmation`, `guard`, `error`, `done`. |
| GET | `/api/assistant/conversations?meeting=` | Your conversations |
| GET | `/api/assistant/conversations/:id` | Messages shaped for display. Raw tool payloads stay on the server. |
| DELETE | `/api/assistant/conversations/:id` | |
| POST | `/api/assistant/actions/:id` | `{ decision: "confirm" \| "reject" }`. Only the user who asked can decide. Expires after 15 minutes; executes at most once. |


`POST /api/assistant/plans/:id` with `{ decision: "approve" | "reject" }` decides a plan from the Planner. Only the user who asked can decide; it runs once and expires after 15 minutes. It returns `{ ok, plan, message, revision }`, where `revision` is a new proposed plan for the steps that didn't work, if any.

The chat stream (`POST /api/assistant/chat`, Server-Sent Events) emits `conversation`, `handoff` (`{agent, name, task, index, total, fallback}`: a specialist agent takes over), `plan` (`{plan}`: a plan waiting for approval), `delta`, `tool_start`, `tool_end`, `confirmation`, `guard`, `error` and `done` events.

## Transcription & summaries (Phase 5)
Readable only by the meeting's host and participants. Mutations need the roles shown.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/meetings/:ref/transcription` | participants | `{ enabled, myConsent, canManage, transcriptStatus, sttConfigured }` |
| POST | `/api/meetings/:ref/transcription` | host / co-host | `{ enabled, consentSelf? }`. Pushes the state to every client via room metadata. |
| POST | `/api/meetings/:ref/transcription/consent` | participant | `{ consent }` for your own audio |
| POST | `/api/meetings/:ref/transcription/chunks` | consenting participant | multipart `audio` (WAV, ≤ 2 MB) plus `clientChunkId`, `capturedAt`, `durationMs`. Returns `202` for new chunks and `200` for duplicates. |
| POST | `/api/meetings/:ref/recordings` | host / co-host | `{ fileName, durationMs, consentConfirmed: true }`. Returns `{ recordingId }`. |
| POST | `/api/meetings/:ref/recordings/:id/chunks` | host / co-host | multipart `audio` plus `index`, `startMs`, `durationMs` (idempotent per index) |
| POST | `/api/meetings/:ref/transcript/import` | host / co-host | `{ content, fileName?, replace? }`. Accepts VTT, SRT or "Name: text" lines. |
| GET | `/api/meetings/:ref/transcript?afterMs=` | participants | Status, processing counts and segments |
| GET | `/api/meetings/:ref/transcript/export?format=txt\|vtt\|srt\|json` | participants | Download |
| DELETE | `/api/meetings/:ref/transcript` | host | Deletes the transcript, summaries and action items |
| GET / POST | `/api/meetings/:ref/summary` | participants | GET returns the latest summary. POST generates a new one with cited decisions, action items and open issues. |
| PATCH | `/api/meetings/:ref/action-items/:id` | participants | `{ status: "OPEN" \| "DONE" }` |

## Search & questions (Phase 6)
Only meetings the caller hosted or attended are searched.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/search?q=&from=&to=` | Matching transcript passages: `results[{ meetingTitle, meetingCode, meetingDate, startMs, endMs, text, score }]` |
| POST | `/api/ask` | `{ question, meetings?: string[], from?, to? }`. Returns `{ answer, confidence: "supported" \| "partial" \| "none", sufficientEvidence, citations[{ n, meetingTitle, meetingCode, meetingDate, startMs, speaker, quote }], mode: "full" \| "retrieval", meetingsSearched }`. `[n]` markers in `answer` refer to `citations`. |

## Administration (Phase 7)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/admin/integrations` | workspace admin | Live status of PostgreSQL, LiveKit, LLM, embeddings, STT, SMTP and Teams. No secrets. |
| POST | `/api/admin/integrations/smtp-test` | workspace admin | Logs in to SMTP without sending (3/hour; never automatic) |
| GET | `/api/health` | public | `{ ok, database, email }` for load balancers |

All authenticated endpoints share the same rules: zod validation, the error shape above, rate limits, and audit logging of state changes. A test (`tests/unit/security.test.ts`) fails if a new route isn't wrapped in `authed()` and isn't on the public allowlist.

## Calling (Phase 8)
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/calls` | members | `{ userIds[], type: "VOICE" \| "VIDEO" }`. Starts a call and rings them for 45 s. Returns `201 { meeting, callees }`. |
| GET | `/api/calls/incoming` | any | Calls ringing for you (polled every 3 s by every open page) |
| POST | `/api/calls/rings/:id` | callee only | `{ response: "accept" \| "decline" }`. Accepting returns `{ joinCode }` and switches workspace if needed. |
| GET | `/api/meetings/:ref/rings` | participants | Per-callee ring state: RINGING, ACCEPTED, DECLINED, MISSED or CANCELED |
| POST | `/api/meetings/:ref/rings` | participants (direct calls), host or co-host | `{ userIds[] }`. Rings again, only people already part of the call. |
| POST | `/api/meetings/:ref/rings/cancel` | caller | Stops ringing (sent automatically when the caller hangs up) |

## Voice assistant (Phase 9)
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/voice/utterance` | meeting participants | Multipart: `audio` (16 kHz WAV, max 700 KB), `meetingRef`, `mode` (`wake` \| `ptt` \| `confirm`), optional `conversationId`, `actionId` (confirm mode), `streamSpeech` (`1`: don't synthesise the reply here; the browser streams it from `/api/voice/speak`). Returns `{ heard, triggered, conversationId?, reply?, speech?: { text, language, audioBase64?, mimeType?, stream? }, confirmation?: { actionId, summary }, expectCommand? }`. With `streamSpeech=1` and a language indic-speak covers, `speech` has `stream: true` and no audio. In `wake` mode, speech without "Hey Mind" returns `triggered: false` and nothing is stored. 40 requests per minute per user. |
| POST | `/api/voice/transcribe` | members | Multipart: `audio` (16 kHz mono 16-bit WAV), `language`. Returns `{ text, language }`. Used by the assistant chat's mic. |
| POST | `/api/voice/speak` | members | `{ text (≤ 800 chars), language, stream? }`. With `stream: true`, the 12 Magpie languages come back as raw 16-bit mono PCM (`audio/L16; rate=22050`) while Magpie generates it, so playback starts in about 0.05 s (indic-speak, at `rate=24000`, only if `INDIC_TTS_URL` is set). Otherwise, or if streaming fails before any audio, one WAV. 150 requests per minute per user (replies are spoken a sentence at a time). |
| GET | `/api/voice/announcement` | any | The spoken "this call is now being transcribed" notice in your preferred language, with synthesised audio when TTS is configured |

## Live captions (Phase 10)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/meetings/:ref/captions?lang=` | meeting participants | `lang` is `original` or a language code (`hi`, `es`, …). Returns the last 8 lines from the past 2 minutes: `{ language, translationAvailable, transcriptionEnabled, captions: [{ id, speakerLabel, isMe, text, original, spokenLanguage, translated, ageMs }] }`. Polled every 1.5 s; 120 per minute per user. |

## Reminders, SMS and bookings (Phase 11)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/reminders?include=all` | any | Your upcoming reminders (or all, with history) |
| POST | `/api/reminders` | any | `{ text, dueAt, sms? }`. For yourself only; `sms` needs a verified number. 30 per minute |
| DELETE | `/api/reminders/:id` | owner | Cancels an upcoming reminder |
| POST | `/api/profile/phone/verify/start` | any | Texts a 6-digit code to the number in your profile (3 per 10 minutes). Returns `{ provider: "twilio" \| "outbox" }` |
| POST | `/api/profile/phone/verify` | any | `{ code }`. 5 wrong attempts invalidate the code |
| PUT | `/api/profile/sms-reminders` | any | `{ enabled }`. Text reminders by default (needs a verified number) |
| GET | `/api/profile/sms` | any | Text messages sent to you; in development, the outbox |
| GET | `/api/bookings` | members | Your food orders, cabs and table reservations |
| POST | `/api/bookings/:id/cancel` | owner | Food within 5 minutes of ordering; cabs and tables before their time; Uber rides before the trip starts (cancelled with Uber first) |
| GET | `/api/bookings/:id/ride` | owner | Uber ride status refreshed from Uber: `{ status, label, driver, vehicle, etaMin, final }` |
| POST | `/api/bookings/:id/ride/advance` | owner | Uber **test mode** only: move the ride to its next stage (processing → accepted → arriving → in_progress → completed) |
| GET | `/api/integrations/uber` | any | `{ configured, env, connected, needsReconnect, connectedAt }` for your own Uber connection |
| GET | `/api/integrations/uber/connect` | any | Redirects to Uber's sign-in, setting a one-time state cookie (10 minutes) |
| GET | `/api/integrations/uber/callback` | session + state | Uber returns here. The state must match the cookie for the same signed-in user. Redirects to `/settings/profile?uber=connected\|denied\|expired\|error` |
| POST | `/api/integrations/uber/disconnect` | any | Revokes the Uber token and deletes the connection |

Orders and bookings are created only through the assistant (tools `order_food`, `book_cab`, `book_uber`, `reserve_table`), always after confirmation.

`PATCH /api/profile` also accepts `preferredLanguage` (a language code) and `phoneNumber` (E.164; changing it clears verification).

## Call summaries and delivery (Phase 16)
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/sample-call` | members | Creates an ended sample call; returns `{ joinCode }` |
| POST | `/api/meetings/:ref/recordings` | host, co-host | Now also `{ chunks, language }`. With Riva available, the whole call is transcribed with speakers once all `chunks` pieces arrive (`speakers: true` in the response) |
| POST | `/api/meetings/:ref/transcript/speakers` | host, co-host | `{ from: "Speaker 1", to: "Priya Patel", userId? }` |
| GET | `/api/meetings/:ref/summary/deliveries` | participants | `{ summaryId, canSend, channels: { email, sms }, people: [{ name, email, channels: { IN_APP, EMAIL, SMS: { status, detail, at } } }] }` |
| POST | `/api/meetings/:ref/summary/deliver` | host, co-host | Sends the latest summary to everyone again (5 per hour) |
| PUT | `/api/profile/summary-delivery` | any | `{ email, sms }`: how you receive call summaries (SMS needs a verified number) |

## AI interpreter (Phase 15)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/meetings/:ref/interpretation` | participants | `{ enabled, canManage, available, myLanguage, languages }` |
| POST | `/api/meetings/:ref/interpretation` | host, co-host | `{ enabled }` (mainly to turn it off for everyone). Live calls only. Turning it on also turns transcription on (each person's consent still applies); turning transcription off turns it off |
| PUT | `/api/meetings/:ref/interpretation/me` | participants | `{ language }`: the language you speak and want to hear. In a live call this opts your own voice in and switches the interpreter on for the call; no host step |
| DELETE | `/api/meetings/:ref/interpretation/me` | participants | Stop sending your voice to the interpreter; you still hear others in your language |
| GET | `/api/meetings/:ref/interpretation/latency` | participants | `{ overall: { count, avgMs, p50Ms, p95Ms, maxMs, avgAsrMs, avgMtMs, avgTtsMs, avgQueueMs }, byPair, recent }` |

In the call, the interpreter publishes one audio track per language (`interpreter-<lang>`) and data messages on topic `interpreter`: `roster`, `line` (`id`, `speakerId`, `speaker`, `language`, `text`, `startMs`), `translation` and `latency`. The agent is in the call whenever transcription or interpretation is on; with transcription only it sends `line` messages and no voice.

## Webhooks
| Method | Path | Notes |
|---|---|---|
| POST | `/api/livekit/webhook` | Called by LiveKit. Requests are authenticated by a signed JWT with a body hash; no cookie is used. |

## Health
`GET /api/health` returns `{ ok, database }`.
