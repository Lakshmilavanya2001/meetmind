#!/bin/bash
# Keep MeetMind's host processes running: the app server, the Indic SSH tunnel and the AI interpreter.
# Each one is restarted 5 s after it exits. Only one supervisor runs at a time (lock file).
#
#   scripts/meetmind-services.sh start    start in the background (also what the @reboot cron entry runs)
#   scripts/meetmind-services.sh stop     stop the supervisor and all three processes
#   scripts/meetmind-services.sh status   what is running, and the last log lines
#
# Logs: ~/.local/state/meetmind/{app,tunnel,interpreter,supervisor}.log
# Postgres, LiveKit and Caddy are Docker containers with restart policies; Docker brings them back itself.
# The app serves the last production build (`npm run build`); rebuild before `stop`/`start` to deploy changes.

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/meetmind"
LOCK="$STATE/supervisor.lock"
PIDFILE="$STATE/supervisor.pid"
mkdir -p "$STATE"

# cron starts with a bare PATH, where only the system Node (too old for Next.js) may exist:
# always put the newest nvm-installed Node first.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

keep_running() { # name, command…
  local name="$1"; shift
  while true; do
    echo "[$(date -Is)] starting $name" >> "$STATE/supervisor.log"
    (cd "$DIR" && exec "$@") >> "$STATE/$name.log" 2>&1
    echo "[$(date -Is)] $name exited ($?); restarting in 5 s" >> "$STATE/supervisor.log"
    sleep 5
  done
}

supervise() {
  exec 9>"$LOCK"
  flock -n 9 || { echo "already running"; exit 0; }
  echo $$ > "$PIDFILE"
  trap 'pkill -P $$; for p in $(jobs -p); do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done; exit 0' TERM INT
  # Wait (up to 2 min after boot) for Docker's Postgres, so the app doesn't start against a missing database.
  for _ in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/5433) 2>/dev/null && break; sleep 2; done
  keep_running tunnel scripts/indic-tunnel.sh &
  keep_running app npm start &
  sleep 5
  keep_running interpreter npm run interpreter &
  wait
}

case "${1:-}" in
  start)
    nohup setsid "$0" run >/dev/null 2>&1 &
    sleep 1; "$0" status ;;
  run) supervise ;;
  stop)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      # The supervisor runs in its own session: stop the whole group (loops and their processes).
      kill -TERM -- "-$(cat "$PIDFILE")" 2>/dev/null
      # Wait until the old supervisor has released its lock, so an immediate `start` isn't refused as
      # "already running" (and then left with nothing running once the old one exits).
      for _ in $(seq 1 30); do flock -n "$LOCK" true && break; sleep 0.5; done
      echo "stopped"
    else
      echo "not running"
    fi
    rm -f "$PIDFILE" ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "supervisor: running (pid $(cat "$PIDFILE"))"; else echo "supervisor: not running"; fi
    echo "app: $(curl -s -o /dev/null -m 3 -w '%{http_code}' http://localhost:3100/login)"
    echo "indic tunnel: $(curl -s -m 3 http://127.0.0.1:18001/health || echo unreachable)"
    tail -n 3 "$STATE/supervisor.log" 2>/dev/null ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
