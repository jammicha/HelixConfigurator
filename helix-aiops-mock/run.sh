#!/usr/bin/env bash
# One-shot runner for helix-aiops-mock — no git clone needed.
#   curl -fsSL https://raw.githubusercontent.com/jammicha/helix-aiops-mock/main/run.sh | bash
# Downloads the project, installs deps, and starts it on http://localhost:9000.
set -euo pipefail

REPO="jammicha/helix-aiops-mock"
DIR="${HELIX_MOCK_DIR:-${TMPDIR:-/tmp}/helix-aiops-mock}"

command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required (https://nodejs.org)."; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "npm is required (ships with Node.js)."; exit 1; }

echo "→ Fetching helix-aiops-mock…"
rm -rf "$DIR" && mkdir -p "$DIR"
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" \
  | tar -xz --strip-components=1 -C "$DIR"

cd "$DIR"
echo "→ Installing dependencies…"
npm install --silent --no-audit --no-fund

echo "→ Starting on http://localhost:9000 (Ctrl-C to stop)…"
exec npm start
