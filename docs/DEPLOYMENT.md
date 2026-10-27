# Deployment

## Option A: single host with Docker Compose (recommended start)

What you need:
- A Linux VM with Docker.
- A DNS name pointing at it, e.g. `meet.example.com`.
- Optionally, `turn.example.com` for TURN.
- Reachable OpenAI-compatible endpoints for the LLM, embeddings and speech-to-text. The Qwen, nemotron-embed and Granite servers used in development all work.

**Firewall:**

| Port | Purpose |
|---|---|
| 80, 443 (TCP) | HTTPS through Caddy, with automatic Let's Encrypt |
| 7881 (TCP), 50000–60000 (UDP) | LiveKit media |
| 3478 (UDP), 5349 (TCP) | TURN, for users behind strict firewalls |

**Steps:**

```bash
git clone <repo> meetmind && cd meetmind
cp deploy/.env.production.example deploy/.env.production      # fill in every value
cp deploy/livekit.prod.example.yaml deploy/livekit.prod.yaml  # API key/secret (match .env), TURN domain + cert
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
```

**What runs:**

| Service | Notes |
|---|---|
| `postgres` | PostgreSQL 16 with pgvector. Persistent volume, not published |
| `migrate` | Runs `prisma migrate deploy` once, then exits. The app waits for it to succeed |
| `app` | Next.js standalone server, non-root, 282 MB image. Includes the transcription and search-indexing worker. Published on `127.0.0.1:3100` only |
| `interpreter` | The AI interpreter process. It joins live calls where interpretation is on, needs LiveKit, Riva realtime, the LLM and TTS, and shares the uploads volume (cached voice). Run locally with `npm run interpreter` |
| `livekit` | SFU on the host network |
| `caddy` | TLS termination; routes `/rtc*` to LiveKit and everything else to the app. Replaces `X-Forwarded-For` with the real peer IP |

**First run.** Open `https://meet.example.com/signup` and create the first workspace; you become its owner. Then:
1. Go to **Workspace settings → Integrations & services** to check that every dependency is green.
2. Click **Test login** for SMTP.

Don't run the seed script in production; it refuses to anyway.

**Upgrades:**

```bash
git pull && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
```

The migrate service applies new migrations before the new app starts.

**Backups:**
- **Database:** `docker compose ... exec postgres pg_dump -U meetmind meetmind > backup.sql`.
- **Uploads volume:** holds only audio waiting to be transcribed; it's deleted after processing.

## Keeping the host processes running (POC host)
On the POC host, Postgres, LiveKit and Caddy are Docker containers with restart policies. Processes run directly on the host: the app (`npm start`), the AI interpreter (`npm run interpreter`) and, only while `INDIC_*` URLs are set in `.env`, the Indic SSH tunnel (`scripts/indic-tunnel.sh`). Since 2026-10-24 calls use Parakeet and Magpie, so the tunnel isn't started. `status` also checks Magpie (`MAGPIE_TTS_URL`). `scripts/meetmind-services.sh` supervises them:

```bash
scripts/meetmind-services.sh start
```

```bash
scripts/meetmind-services.sh status
```

```bash
scripts/meetmind-services.sh stop
```

- Each process is restarted 5 s after it exits, and only one supervisor runs at a time.
- After boot it waits for Postgres before starting the app.
- It always uses the newest nvm-installed Node, because the system Node (18) is too old for Next.js.
- Logs are in `~/.local/state/meetmind/`.
- A user crontab entry starts it at boot. It needs no root and changes no system settings:
  `@reboot /tmp/claude-1000/-home-ubuntu-MonAi/917aec73-7aa7-468e-a21e-92a875e64929/scratchpad/sb2/scripts/meetmind-services.sh start`
- To deploy a change: `npm run build`, then `stop` and `start`. `stop` waits until the old supervisor has exited (up to 15 s), so `start` can run straight after it.
- If a stylesheet change doesn't show up after a build, touch the file (`touch src/app/globals.css`) and build again. Turbopack's build cache can keep an older version of a file that was restored with `git stash pop`.

## Option B: managed services

- **App image:** `docker build -t meetmind .` produces the runner. Run the migrate target (`docker build --target migrate`) as a pre-deploy job.
- **Postgres:** use any Postgres 16+ with `CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;` (pgvector 0.8 or later, for iterative HNSW scans).
- **LiveKit Cloud:** set `LIVEKIT_URL=https://<project>.livekit.cloud`, `LIVEKIT_PUBLIC_URL=wss://<project>.livekit.cloud` and your project keys. Configure the webhook in the LiveKit Cloud console to point at `https://<domain>/api/livekit/webhook`.
- **Scaling to several replicas:**
  1. Set `DISABLE_WORKERS=true` on all but one, or keep the worker on every replica; job claiming uses `FOR UPDATE SKIP LOCKED`, so it's safe either way.
  2. Move rate limits to a shared store; see SECURITY.md.
  3. Put `UPLOAD_DIR` on shared storage, or swap `src/server/storage.ts` for S3.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | |
| `APP_URL` | yes | Public base URL, used in email links |
| `ENCRYPTION_KEY` | yes | `openssl rand -base64 32`. Encrypts stored integration credentials |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | yes | `LIVEKIT_PUBLIC_URL` is only needed for LiveKit Cloud |
| `TRUST_PROXY` | behind a proxy | `true` only if every request comes through your proxy |
| `COOKIE_SECURE` | | Cookies are Secure automatically on HTTPS requests |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | for the assistant, summaries and Q&A | Any OpenAI-compatible endpoint with tool calling and `json_schema` output |
| `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | for search and Q&A | Must be **2048** dimensions to match the schema, or change the column and migrate |
| `STT_BASE_URL`, `STT_MODEL` | for transcription | OpenAI-compatible `/audio/transcriptions` |
| `RIVA_REALTIME_URL`, `RIVA_ASR_MODEL` | optional, preferred for speech | NVIDIA Riva realtime WebSocket (`ws://host:9000/v1/realtime?intent=transcription`). Adds Hindi and Spanish, punctuation and word timings |
| `TTS_BASE_URL`, `TTS_MODEL`, `TTS_VOICE_DESCRIPTION` | optional | Qwen3-TTS `/audio/speech` for the voice assistant's replies. Without it the browser's voice is used |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | optional | Real SMS for reminders and phone verification. Without them, SMS is off and reminders stay in-app |
| `EMAIL_DEV_OUTBOX` | **development only** | `true` records emails (e.g. call summaries) in Settings → Messages instead of sending them |
| `SMS_VERIFY_STARTS_PER_10MIN` | optional | Verification codes per user per 10 minutes (default 3) |
| `INTERPRETER_PAUSE_MS` | optional | AI interpreter: the pause that ends a sentence (default 800 ms; lower is faster but may split sentences) |
| `SMS_ALLOWED_PREFIXES`, `SMS_DAILY_LIMIT_PER_USER`, `SMS_DAILY_LIMIT` | optional | Countries that can be texted (default `+91`) and daily caps (defaults 20 per user, 2000 total) |
| `SMS_DEV_OUTBOX` | **development only** | `true` records texts, including verification codes, in the app instead of sending them. Never set it in production |
| `RIVA_API_KEY`, `TTS_API_KEY` | optional | Bearer tokens for the Riva and TTS endpoints, if they need one |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | optional | Without them, invitations are delivered in-app only |
| `TRANSCRIPTION_DAILY_MINUTES_PER_ORG` | optional | Default 1440 |
| `UPLOAD_DIR`, `DISABLE_WORKERS` | optional | |
| `UBER_CLIENT_ID`, `UBER_CLIENT_SECRET` | optional | Uber Riders API app from developer.uber.com, with scopes `ride_request.estimate` and `ride_request.ride_booking`. Each user connects their own Uber account in Settings → Profile. Without them, cabs use the sandbox |
| `UBER_ENV` | optional | `sandbox` (default: Uber's test servers, no real car, nothing charged; fares are real) or `production` (real rides, charged; needs Uber's approval of the app) |
| `UBER_REDIRECT_URI` | optional | Default `${APP_URL}/api/integrations/uber/callback`. Must be listed exactly in the Uber app's redirect URIs |
| `GEOCODER_URL`, `GEOCODER_CONTACT`, `GEOCODER_COUNTRIES` | needed for Uber | Nominatim-compatible geocoder (place name → coordinates) for Uber bookings and the "Open in Uber" link. The public server allows 1 request a second |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | future | See TEAMS_CONNECTOR.md |

Features whose variables are missing are reported as "not configured" in the Integrations panel and disabled in the UI. They never pretend to work.

## Local development

See the README: `docker compose up -d`, `npm run dev`, and HTTPS at `https://<ip>:3443` via `scripts/dev-cert.sh`.
