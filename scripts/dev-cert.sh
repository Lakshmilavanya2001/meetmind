#!/usr/bin/env bash
# Generates a self-signed TLS certificate for local HTTPS (camera/mic need a secure context).
# Usage: scripts/dev-cert.sh <server-ip-or-hostname> [more names...]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p infra/certs
SAN="DNS:localhost,IP:127.0.0.1"
for name in "$@"; do
  if [[ $name =~ ^[0-9.]+$ ]]; then SAN="$SAN,IP:$name"; else SAN="$SAN,DNS:$name"; fi
done
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout infra/certs/dev.key -out infra/certs/dev.crt \
  -subj "/CN=MeetMind local dev" -addext "subjectAltName=$SAN" 2>/dev/null
chmod 644 infra/certs/dev.crt infra/certs/dev.key
echo "Wrote infra/certs/dev.crt for: $SAN"
