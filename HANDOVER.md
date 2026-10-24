# MeetMind: handover for a new chat

Written 2026-10-23. Everything needed to continue this project in a new Claude Code chat.
It contains **no passwords, keys or tokens**; those live only in the gitignored `.env` files.

---

## 0. How to start the new chat

1. Open a new Claude Code session **in `/home/ubuntu/demo`** (not `/home/ubuntu/MonAi`).
2. Paste this as the first message:

> I'm continuing the MeetMind project (the VIL Voice AI POC) in /home/ubuntu/demo. Read HANDOVER.md in the project root first; it has the full history, decisions, rules and open items. Follow the rules in section 5. Then check the services with `scripts/meetmind-services.sh status` and tell me the state before doing anything else.

The raw transcripts of the earlier chats are on this machine in `~/.claude/projects/-home-ubuntu-MonAi/` (`.jsonl` files). The biggest are `cfbcb750-…` (Phases 15–17), `fc0cb77c-…`, `0525514d-…`, `4ee17171-…` and `5352877a-…` (2026-10-23). They are long; this document summarises them.

---

## 1. What the project is

**MeetMind** is an AI calling and meeting assistant (Next.js), being shaped into the **VIL Voice AI POC**. The user's own words: "people talking in a phone and our agent will be in a call". It is app-to-app calling with an AI agent in the call.

The four POC demos are all built and working:

| Demo | What it shows | Where in the app |
|---|---|---|
| 1. Call transcription and summary | Whole call transcribed with speakers told apart; AI summary; delivered in-app, by email and SMS | Meetings → **Try a sample call** |
| 2. Real-time voice translation | AI interpreter joins the call; each person hears everyone in the language they picked (24 languages); conference calls; latency measured | Interpreter button in any call |
| 3. Noise cancellation | RNNoise, GTCRN and Speex compared before/after, by ear, spectrogram and numbers | **Demos → Noise cancellation** |
| 4. Ordering and booking agent | Agent asks for missing details, confirms, then submits to a mock partner website (pizza, movie tickets) | Assistant + **Demos** → partner portals |

There is also a voice assistant **inside calls** ("Hey Mind …" or push-to-talk) that does everything the assistant can, in the caller's own language (section 4, item 6).

---

## 2. Conversation history (what was asked, what was done)

Earlier chats (summarised in older transcripts):
- **Phases 1–7:** project structure, database, auth, dashboard, user directory; LiveKit meetings; scheduling, invitations, calendar, notifications; AI assistant with tools and confirmations; consent-based transcription and grounded summaries; grounded Q&A over transcripts; security hardening, production deployment, docs, CI, Teams connector guide.
- **Phases 8–14:** voice/video calling with ringing and noise cancellation; in-call voice assistant ("Hey Mind"); live translated captions; reminders, SMS, sandbox bookings (food, cab, table); security review (16 findings fixed); the agent team (coordinator + specialists); the Planner agent.
- **VIL POC brief:** the user pasted four demos (transcription + summary, real-time EN↔HI translation with latency, noise cancellation before/after, agentic booking agent).
  - The user chose app-to-app calls.
  - The user said **"I'll tell you when to create the ppt"**. Do not make the PPT until asked.
- **Indic stack:** the user provided their self-hosted models (ASR :8001, translate :8002, TTS :8003 on 10.79.252.124) and added a restricted SSH key line on that VM.
- **Phase 15:** AI interpreter in the call.
- **Phase 16:** call transcription with speakers, automatic summary, delivery.
- **Phase 17:** noise demo, ordering/booking agent, partner portals, Demos hub, Next.js security upgrade.

This chat (2026-10-22/23), in order:
1. **Phase 17 finished:**
   - tests: movies, partner portals, booking e2e;
   - docs and commit;
   - Next.js 16.4.2 for a critical advisory.
2. **"Generate a high-level architecture diagram":** a web page at https://claude.ai/artifact/ETPo9pxNMpEjdMNyPBZccd (private until shared) and `docs/architecture.png`.
3. **"Give me all the models used, with purpose":** see section 3.
4. **"Another person signed up but I can't connect":**
   - Cause: every sign-up had created its own workspace, and the app had also stopped.
   - With approval, a **Telecom** workspace was created: lavanya@crimsoncloud.in Owner; ribin@crimsoncloud.in and ribin@frontier.in Admins.
   - Old workspaces were kept.
5. **"Is indic-speak only for translation?"** No, it's text-to-speech. indic-translate translates.
6. **"Can I have multiple people in one call?"** Yes (up to 100). The interpreter works in conference calls.
7. **"Translation not happening (Telugu ↔ Malayalam)":** the host had never turned the interpreter on.
   - First, a hint was added.
   - Then, at the user's request, **picking a language now turns the interpreter on**, with no host step.
8. **"Where do I mute the other person's original voice?"** The setting is in the interpreter menu. It now defaults to **Muted** (hear only the translation), remembered per device.
9. **"Generate the session memory file":** `memory.md`. This HANDOVER.md supersedes it.
10. **"Architecture diagram with latest models and agentic flow":** three figures (components and models, agent flow, interpreter pipeline) on the same web page, plus PNGs in `docs/`.
11. **"Which models are actually used?"** and **"Why Riva when we have IndicConformer?"**
    - IndicConformer has no English (tested: it rejects `en`, and English sent as Hindi comes back garbled).
    - It also can't tell speakers apart and adds no punctuation.
    - So Riva handles English/Spanish and speaker labels.
12. **"In-call agent must do everything by voice while translating":**
    - "Hey Mind" and yes/no now work in every Indian script.
    - The assistant listens and answers in the language picked for the call.
    - Commands are never translated to other callers.
    - New voice tool: start/stop transcription.
    - Fixed the agent counting the interpreter as a person.
13. **"Tell me about RNNoise":** explained (section 3).
14. **"Which agent framework?"** It was custom TypeScript. **"Can we use LangGraph?"** Yes. **"go"**: it's done (section 4, item 7).
15. **The machine rebooted** (11:58, 2026-10-23).
    - Docker containers came back; the app, tunnel and interpreter were restarted by hand.
    - Later, a supervisor with auto-start at boot was added (commit ff822ed).
    - It was partly undone by a rewind; **"Keep the auto-start"** restored it.
16. `/home/ubuntu/MonAi` (a separate, unrelated project and the old session folder) **disappeared**, cause unknown. It was recreated **empty** (with a note file) only so the session could continue. The original MonAi project is not in it.

---

## 3. Stack, machines and models

- **App:** Next.js 16.4.2 (typed routes), React, Prisma 7, PostgreSQL 16 + pgvector + pg_trgm, LiveKit (WebRTC), Caddy.
- **Agent orchestration:** **LangGraph.js** (`@langchain/langgraph` 1.4.21, `@langchain/core` 1.2.17, pinned) with our own OpenAI-compatible client to Qwen.
- **URL:** `https://10.79.254.169:3443` (Caddy) → app on `:3100`. LiveKit signalling goes through Caddy; media goes direct over UDP.
- **Docker containers** (restart by themselves): `meetmind-proxy` (Caddy), `meetmind-livekit`, `meetmind-postgres` (port 5433).
- **Unrelated things on the same machine, don't touch:** `monai-frontend`, `monai-backend` containers and a Next.js v15 server.
- **Host processes, supervised:** `scripts/meetmind-services.sh` runs and restarts (5 s after exit) the app (`npm start`), the Indic SSH tunnel (`scripts/indic-tunnel.sh`) and the interpreter (`npm run interpreter`).
  - A user crontab `@reboot` line starts it at boot.
  - Logs are in `~/.local/state/meetmind/`.
  - Commands: `scripts/meetmind-services.sh status|start|stop`.
  - **Deploy a change:** `npm run build`, then `stop` and `start`.

**Models actually in use**

| Model | Where | Purpose |
|---|---|---|
| Qwen 27B (`qwen3.8-27b`) | GPU host 1 :8000 | Coordinator + 8 specialists, tools, summaries, grounded answers, caption translation, en↔es interpreter translation and fallback |
| NVIDIA Llama Nemotron Embed 1B v2 | GPU host 1 :8001 | Vectors for meaning-based search over transcripts |
| NVIDIA Riva Parakeet streaming + Sortformer | GPU host 1 :9000 | Live English/Spanish speech-to-text, speaker labels on recordings (en/hi/es only), English voice commands |
| AI4Bharat IndicConformer 600M | GPU host 2 :8001 (tunnel 18001) | Speech-to-text for 22 Indian languages (no English), live and voice input |
| Bodhan AI indic-translate (Gemma-4-E4B) | GPU host 2 :8002 (tunnel 18002) | Translation between Indian languages and English, any direction |
| Bodhan AI indic-speak (Llama-3.2-3B + Vocos) | GPU host 2 :8003 (tunnel 18003) | Streamed speech in Indian languages + English (the interpreter's voice, spoken replies) |
| RNNoise | Browser (wasm) | Default noise removal on the mic in calls |
| GTCRN | Browser (wasm) | Stronger neural noise removal (best in the demo) |

Standby only:
- **IBM Granite Speech 4.1 2B** (:8094): if Riva fails on an upload.
- **Qwen3-TTS 1.7B** (:8092): Spanish speech, or if indic-speak fails. It also made the sample-call voices.
- **Speex**: classic non-AI baseline in the noise demo.

**Measured:**
- Interpreter latency, from pause to translated voice: Tamil→Hindi 1.2 s, Hindi→English 1.6 s, English→Hindi 2.1 s.
- Telugu↔Malayalam text translation alone: under 0.2 s.
- Noise, office sample: GTCRN +9.6 dB SI-SDR / 23.6 dB less background; RNNoise +7.4 / 22.7; Speex +1.5 / 3.1.

**Outside services:** email goes to a development outbox (`EMAIL_DEV_OUTBOX=true`), and so does SMS (no Twilio). All bookings are sandboxes.

**License:** the Indic Open Model License requires the credit "Built with indic-translate and indic-speak from Bodhan AI / AI4Bharat". The app shows it.

---

## 4. Key behaviour and where it lives

1. **Agent team:** coordinator → 8 specialists (Meetings & calls, Meeting knowledge, Food & dining, Travel, Movies, Reminders, Planner, General), 43 tools.
   - Sensitive actions show a confirmation card and run only on Confirm or a spoken yes.
   - Confirmations work once and expire after 15 min.
   - Guards refuse invented people, places and claims.
   - Files: `src/server/ai/`.
2. **Workspaces:** people can only see and call others in the same workspace. New people must choose **Join workspace** at sign-up with Telecom's join code (Settings → Workspace).
3. **Interpreter** (`src/server/interpreter/`, `scripts/interpreter-agent.ts`):
   - Each person picks "I speak and want to hear" in the interpreter menu. That opts their own voice in and switches the interpreter on.
   - Others' original voices are muted by default (listener setting).
   - Indian languages use IndicConformer → indic-translate → indic-speak; English/Spanish use Riva and Qwen.
4. **Captions, transcription, summaries:** transcription needs each person's own consent. Summaries are delivered in-app, by email and by SMS.
5. **Booking demos:** Slice Republic pizzeria and the sandbox cinema; partner portals at `/partners/food`, `/partners/cinema`.
6. **Voice assistant in calls** (`src/components/meeting/voice-assistant.tsx`, `src/server/services/voice.ts`, `src/lib/voice-commands.ts`):
   - "Hey Mind" and yes/no are recognised in every Indian script (mapped to Devanagari), including a clipped "Hey".
   - It listens and answers in the language picked for the call.
   - The browser tells the interpreter (data topic `assistant-state`) when Hey Mind listening is on, and the verdict for each utterance as soon as it's recognised (the endpoint streams it).
   - The interpreter holds a listener's sentences for up to 3 s until that verdict, so commands are never translated to others.
7. **LangGraph** (`src/server/ai/agent-graph.ts`, shared steps in `agent-core.ts`, switch in `agent.ts`):
   - Turn graph: receive → coordinator → handoff → specialist → (handoff | finish).
   - Specialist graph: model ⇄ tools → (end | round_limit).
   - Confirmations and plan approvals are deliberately **outside** the graph.
   - `AGENT_ENGINE=classic` switches back to the original loop.
   - LangSmith is off.

---

## 5. Rules to keep following

- **Commit identity:** `git -c user.name="hakofficial" -c user.email="hakofficial2023@gmail.com" commit …`. Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Never commit:** `.env`, `infra/livekit.yaml`, `infra/certs`, `deploy/.env.production`, `deploy/livekit.prod.yaml`, or `~/.ssh/meetmind_indic`.
- **Never repeat passwords or keys** in chat, docs or commits.
- The SSH key may only forward ports 8001–8003. The Indic services have no authentication and must stay private.
- **No PPT until the user asks.**
- The user works in steps and says "go" / "continue". Ask before anything destructive or that changes other people's data or access.
- Update the docs (README, docs/ARCHITECTURE, API, TESTING, SECURITY, DEPLOYMENT) with each change.
- Pin new npm packages to exact versions at least two weeks old.
- Shell gotcha: `pkill -f "<pattern>"` / `pgrep -f` can match the shell running the command and kill it. Use the supervisor script, or PIDs.

---

## 6. Testing

- **Unit/integration:** `npm test`. Last run: **285 passed** (33 skipped) on both agent engines. The tests blank the Indic URLs, so only en/hi/es exist in tests.
- **Live evals against Qwen:** `LLM_LIVE=1 npx vitest run tests/live`. 22 passed on LangGraph.
- **Browser tests** (Docker, against the production build via `https://localhost:3443`):
  `docker run --rm --network host --ipc=host -u $(id -u):$(id -g) -e HOME=/tmp -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test`
  - Last full run: **21/21 passed** on LangGraph.
  - That run used the *committed* `e2e/call.spec.ts`; the working copy belongs to the unfinished redesign (section 7).
- Seeded test accounts are in `prisma/seed.ts` (Acme, Globex). Don't change them. The default password is in `SEED_PASSWORD` / `e2e/helpers.ts`.
- Leftover test meetings can cause calendar clashes in `assistant.spec.ts`. Cancel the meeting **and** its `CalendarEvent` rows.
- **Prisma migrations:**
  1. `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
  2. Remove the `TranscriptChunk_embedding_hnsw_idx` lines.
  3. `migrate deploy` on the dev DB **and** the test DB.
  4. `prisma generate`.
- After adding pages: `npx next typegen`.

---

## 7. Open items

- **The unfinished call-screen redesign is uncommitted** and isn't from these chats. It touches `src/app/globals.css`, `src/components/meeting/{lobby,room-view,captions}.tsx` and `e2e/call.spec.ts`, plus screenshots in `e2e-shots/`.
  - `room-view.tsx` imports `./phone-key`, `./phone-stage` and `CameraKey`/`MicKey`/`ShareKey`, which don't exist, so **the app can't be built while it's in the tree**.
  - Workaround used for every build:
    1. back up those 5 files and their checksums;
    2. `git stash push -- <those 5 files>`;
    3. `npm run build`;
    4. `git stash pop`;
    5. verify the checksums.
  - Ask the user who owns it before committing or discarding it.
- No automated tests yet for `/api/voice/transcribe` and `/api/voice/speak`.
- Speaker labels on recordings work only for en/hi/es (Riva). Telugu/Malayalam recordings would need a separate speaker-separation model.
- The interpreter currently requires Riva to be configured even for all-Indic calls (offered to change; not done).
- Telugu↔Malayalam live speech hasn't been tried by real users since the latest fixes.
- The PPT is pending until asked.
- `/home/ubuntu/MonAi` is an empty, recreated folder. The user may want to restore their original MonAi project there or delete the folder.
- `memory.md` (untracked) is the older version of this file; HANDOVER.md supersedes it.

---

## 8. Restore after the deletion (2026-10-24)

At 09:51 on 2026-10-24, part of `/home/ubuntu/demo` was deleted from a terminal: `.git`, `scripts/`, `docs/`, `prisma/`, `tests/`, `e2e/`, `uploads/`, `package-lock.json` and part of `node_modules`. `src/`, `.env` and the configs survived. It was rebuilt the same day:

- **From the Docker image `meetmind-interpreter:test`** (built 2026-10-22 15:25): `prisma/migrations`, `docs/`, `scripts/`, `package-lock.json`, `.gitignore`, `.dockerignore`, `eslint.config.mjs`, `prisma.config.ts`, missing `node_modules` (then `npm install` for LangGraph).
- **`prisma/schema.prisma`**: the exact text embedded in the generated client (`src/generated/prisma`), which matches the live database.
- **Two migrations** (`20261023180000_summary_delivery`, `20261023210000_movie_bookings`): regenerated with `prisma migrate diff`. Same changes, already applied, but the files' checksums differ from the database's, so `prisma migrate dev`/`status` may warn that they were "modified after being applied". `migrate deploy` (the project's normal path) is unaffected.
- **Later edits, `tests/` and `e2e/`**: replayed from the chat transcripts on top of the image (scripts in the session scratchpad). The replay reproduced 303 of 323 `src/` files exactly, which is the confidence level for the rebuilt tests and docs. A few individual test cases (about 3) and a few doc lines could not be replayed.
- **Audio test fixtures** (`e2e/fixtures/*.wav`, `tests/fixtures/*.wav`): regenerated with the same text and voices.
- **Scripts rescued from memory**: `meetmind-services.sh` and `indic-tunnel.sh` were copied from the running processes.
- **Lost for good:** the git history (never pushed), `memory.md`, `e2e-shots/`, the 2026-10-23 architecture PNGs in `docs/`, and `uploads/` contents.
- **Tests after the restore:** `npm test` 288 passed, 33 skipped (48 files, including the new `tests/unit/speech-player.test.ts`); browser tests 21/21. Seven rebuilt browser tests were behind the app and were updated (locators for renamed dialogs and duplicate texts, an Indian test phone number for the SMS allow-list, and no "Turn on for everyone" step now that picking a language turns the interpreter on).
- **Known, not from the restore:** the noise demo page logs `AudioWorkletNode is not defined` while rendering on the server (it already did before; the page works in the browser), and SMTP authentication fails, so email waits in the outbox.
- **Git**: there is no repository now. A new one needs `git init` and a first commit of the restored tree (not done; ask the user).
