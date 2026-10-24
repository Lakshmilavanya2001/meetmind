# syntax=docker/dockerfile:1.7
# MeetMind production image.
#   docker build -t meetmind .                    → app (Next.js standalone server + transcription worker)
#   docker build -t meetmind-migrate --target migrate .   → one-shot "prisma migrate deploy"
#   docker build -t meetmind-interpreter --target interpreter .   → AI interpreter (joins calls via LiveKit)

FROM node:24-bookworm-slim AS deps
# Prisma's CLI/engines need OpenSSL to detect the platform.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Lifecycle scripts are not needed (no native builds); the Prisma client is generated explicitly below.
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# prisma.config.ts requires DATABASE_URL to be set, but generation never connects; a placeholder suffices.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate && npx next build

# ── Database migrations (has the Prisma CLI; not shipped in the app image) ──
FROM deps AS migrate
COPY prisma ./prisma
COPY prisma.config.ts ./
# Fetch the schema engine at build time so the container needs no network access at runtime.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma --version
CMD ["npx", "prisma", "migrate", "deploy"]

# ── AI interpreter: a separate process that joins calls as a participant (native WebRTC SDK) ──
FROM build AS interpreter
ENV NODE_ENV=production UPLOAD_DIR=/data/uploads
RUN groupadd --gid 1001 app && useradd --uid 1001 --gid app --no-create-home app \
 && mkdir -p /data/uploads && chown -R app:app /data
USER app
# "react-server" makes the app's server-only guard a no-op outside Next.js.
CMD ["npx", "tsx", "--conditions=react-server", "scripts/interpreter-agent.ts"]

# ── App runtime: only the traced standalone output, non-root ──
FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    UPLOAD_DIR=/data/uploads
RUN groupadd --gid 1001 app && useradd --uid 1001 --gid app --no-create-home app \
 && mkdir -p /data/uploads && chown -R app:app /data
WORKDIR /app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3100
VOLUME ["/data/uploads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
