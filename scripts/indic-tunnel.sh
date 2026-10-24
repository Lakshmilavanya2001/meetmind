#!/usr/bin/env bash
# Keeps an SSH tunnel to the Indic speech services (ASR 8001, translate 8002, TTS 8003), which listen
# only on 127.0.0.1 of the GPU host. The key is restricted on that host to forwarding these 3 ports.
#   INDIC_HOST=ubuntu@10.79.252.124 INDIC_KEY=~/.ssh/meetmind_indic scripts/indic-tunnel.sh
HOST="${INDIC_HOST:-ubuntu@10.79.252.124}"
KEY="${INDIC_KEY:-$HOME/.ssh/meetmind_indic}"
while true; do
  ssh -i "$KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -N -L 127.0.0.1:18001:localhost:8001 -L 127.0.0.1:18002:localhost:8002 -L 127.0.0.1:18003:localhost:8003 "$HOST"
  echo "[indic-tunnel] disconnected; reconnecting in 2 s" >&2
  sleep 2
done
