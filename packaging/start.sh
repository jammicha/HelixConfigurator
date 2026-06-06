#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Starting Helix OTel Configurator..."
./node backend/index.js &
SERVER_PID=$!
deadline=$(( $(date +%s) + 30 ))
URL="http://localhost:${PORT:-8765}"
while [ $(date +%s) -lt $deadline ]; do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    if [ "$(uname)" = "Darwin" ]; then open "$URL?view=onboarding"
    elif [ -n "$DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then (xdg-open "$URL?view=onboarding" >/dev/null 2>&1 &)
    fi
    break
  fi
  sleep 1
done
echo "Configurator UI: $URL"
wait $SERVER_PID
