const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
const crypto = require('crypto');
const Docker = require('dockerode');
const archiver = require('archiver');
const tarStream = require('tar-stream');
const zlib = require('zlib');
const { marked } = require('marked');
const { OtelStore, extractSpans, extractLogRecords } = require('./otelStore');
const {
  demuxLogBuffer,
  makeContainerLogs,
  isValidContainerName,
  computeInstallBaseUrl,
} = require('./util');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const VERSION = require('./package.json').version;

const docker = new Docker(); // uses /var/run/docker.sock by default
const containerLogs = makeContainerLogs(docker);

const { requireAuth, registerAuthRoutes } = require('./auth');

const app = express();
const port = 3001;
// Trust the loopback proxy so X-Forwarded-* headers from a local tunnel
// (cloudflared, ngrok) are honored. computeInstallBaseUrl() uses these to
// discover the tunnel's public hostname and embed it in install commands.
app.set('trust proxy', 'loopback');

const CONFIG_PATH = path.join(__dirname, '../helix-otel-collector.yaml');
const TEMPLATES_DIR = path.join(__dirname, '../templates');

// Track active log streaming subprocesses so we can clean them up on shutdown.
const activeLogProcesses = new Set();

const { validateConfig } = require('./validate');

app.use(cors({ credentials: true }));
// Raw body for OTLP ingest — must come BEFORE express.json() so the stream
// isn't consumed by the JSON parser. Cap at 32MB to absorb large batches.
app.use(['/api/otlp/traces', '/api/otlp/logs'], express.raw({
  type: '*/*',
  limit: '32mb',
}));
app.use(express.json({ limit: '4mb' }));

// Serve static frontend (auth gate is on /api/* only — static assets stay public)
app.use(express.static(path.join(__dirname, '../frontend-dist')));

// SPA fallback for the AIOps mock route — express.static 404s on /aiops since
// no file exists there. Send index.html so the client-side route renders.
app.get(/^\/aiops(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend-dist/index.html'));
});

// SPA fallback for the View OTel Data route.
app.get(/^\/otel-data(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend-dist/index.html'));
});

// Auth endpoints (must register BEFORE the requireAuth middleware so the
// login / logout / status routes themselves are reachable when auth is on).
registerAuthRoutes(app);

// Health endpoint (public — for k8s liveness probes, load balancers, monitoring)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION });
});

// --- AIOps mock endpoint (public) ----------------------------------------
// Simulates the BMC Helix AIOps "Manage Opentelemetry" wizard: takes the
// X-Source name, fabricates an API key that looks like a real Helix one, and
// streams back a zip of everything needed to run the HelixConfigurator sidecar
// on Mac/Linux/Windows. The ingest endpoint is an obvious placeholder so the
// bundle doesn't leak whichever tenant the demo host happens to point at —
// the user fills in their real endpoint at Step 1 of the wizard. (In a real
// AIOps integration, the tenant URL would be known and substituted here.)
const SIMULATED_INGEST_ENDPOINT = 'https://your-tenant.onbmc.com';

const fakeHelixApiKey = () => `FAKE-KEY-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;

const renderCollectorYaml = ({ endpoint, apiKey, xSource }) => `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
    headers:
      X-Api-Key: \${env:HELIX_API_KEY}
      X-Source: \${env:X_SOURCE}
    sending_queue:
      enabled: true
  # Fan-out: traces and logs also flow to the configurator backend so the
  # local "View OTel Data" page can render waterfalls, errors, and DB insight.
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    encoding: json
    compression: none
    tls:
      insecure: true
    sending_queue:
      enabled: false
    retry_on_failure:
      enabled: false
service:
  telemetry:
    metrics:
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: 8888
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer]
`;

const renderEnvFile = ({ endpoint, apiKey, xSource }) => {
  // Defensive: this function MUST only emit values from the AIOps session
  // ctx (xSource from the form, fake apiKey, simulated endpoint). It must
  // never include host-side secrets like UI_AUTH_PASSWORD or a real
  // HELIX_API_KEY pulled from process.env. The body below already follows
  // that rule; the asserts after it catch any future regression at
  // bundle-time so a leaky build can't ship.
  const out = `# Generated by the SIMULATED BMC Helix AIOps "Manage Opentelemetry" page.
# NOTE: HELIX_API_KEY below is a fake, locally-generated key — it will not
# authenticate against a real Helix tenant. Replace it before going to prod.
# Source: ${xSource}
HELIX_ENDPOINT=${endpoint}
HELIX_API_KEY=${apiKey}
X_SOURCE=${xSource}
APP_URL=
BUSINESS_SERVICE_KEY=
`;

  const hostPassword = process.env.UI_AUTH_PASSWORD;
  if (hostPassword && out.includes(hostPassword)) {
    throw new Error('renderEnvFile: refusing to ship — host UI_AUTH_PASSWORD leaked into bundle');
  }
  const hostApiKey = process.env.HELIX_API_KEY;
  if (hostApiKey && !String(apiKey).startsWith('FAKE-KEY-') && out.includes(hostApiKey)) {
    throw new Error('renderEnvFile: refusing to ship — host HELIX_API_KEY leaked into bundle');
  }
  if (/UI_AUTH_PASSWORD/i.test(out)) {
    throw new Error('renderEnvFile: refusing to ship — UI_AUTH_PASSWORD must never appear in the install bundle');
  }
  return out;
};

const renderDockerCompose = () => `services:
  helix-configurator:
    build:
      context: .
      dockerfile: Dockerfile
    image: helix-configurator:local
    # Stable hostname so the gateway can fan trace data out to
    # http://helix-configurator:3001 over the helix-bridge network.
    container_name: helix-configurator
    ports:
      # 8765 chosen over 3000 because it almost never collides with common
      # dev tools (Node, Vite, Django, etc. cluster around 3000/5000/8000).
      - "8765:3001"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./helix-otel-collector.yaml:/app/helix-otel-collector.yaml
      - ./.env:/app/.env
      # Persist the local OTel trace store across container restarts.
      - ./data:/app/data
    env_file:
      - .env
    environment:
      - TARGET_CONTAINER_NAME=helix-gateway
    depends_on:
      - helix-gateway
    networks:
      - helix-bridge

  helix-gateway:
    image: otel/opentelemetry-collector-contrib:latest
    container_name: helix-gateway
    ports:
      - '4317:4317'
      - '4318:4318'
      - '8888:8888'
    env_file:
      - .env
    volumes:
      - ./helix-otel-collector.yaml:/etc/otelcol-contrib/config.yaml
    networks:
      - helix-bridge

networks:
  helix-bridge:
    name: helix-bridge
    driver: bridge
`;

// Shared shell-script body used by both start.sh (Linux/headless) and
// start.command (Mac double-click — Finder runs .command in Terminal).
// `interactive` adds a "press Return to close" pause so a Finder-launched
// Terminal window doesn't vanish on error or success.
const renderShellLauncher = ({ interactive }) => `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "================================================"
echo " Helix OTel Configurator Sidecar"
echo "================================================"
echo ""
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed. Install Docker Desktop and re-run:"
  echo "  https://www.docker.com/products/docker-desktop/"
${interactive ? '  read -p "Press Return to close..." _\n' : ''}  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Open Docker Desktop and try again."
${interactive ? '  read -p "Press Return to close..." _\n' : ''}  exit 1
fi
echo "Starting (first run builds the image — this can take a few minutes)..."
docker compose up -d --build
echo ""
echo "Waiting for the configurator UI to come online..."
deadline=$(( $(date +%s) + 60 ))
while [ $(date +%s) -lt $deadline ]; do
  if curl -fsS http://localhost:8765/api/health >/dev/null 2>&1; then
    echo "Opening README and configurator UI..."
    if [ "$(uname)" = "Darwin" ]; then
      [ -f README.html ] && open README.html || true
      open "http://localhost:8765?view=onboarding" || true
    elif [ -n "$DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then
      [ -f README.html ] && (xdg-open README.html >/dev/null 2>&1 &)
      (xdg-open "http://localhost:8765?view=onboarding" >/dev/null 2>&1 &)
    fi
    break
  fi
  sleep 1
done
echo ""
echo "Sidecar is up."
echo "  Configurator UI:  http://localhost:8765"
echo "  OTLP gRPC:        localhost:4317"
echo "  OTLP HTTP:        localhost:4318"
echo ""
echo "Stop with: docker compose down"
${interactive ? 'echo ""\nread -p "Press Return to close this window..." _\n' : ''}`;

const renderStartBat = () => `@echo off
setlocal
cd /d "%~dp0"
echo ================================================
echo  Helix OTel Configurator Sidecar
echo ================================================
echo.
where docker >nul 2>&1
if errorlevel 1 (
  echo Docker isn't installed. Install Docker Desktop and re-run:
  echo   https://www.docker.com/products/docker-desktop/
  echo.
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo Docker is installed but not running. Open Docker Desktop and try again.
  echo.
  pause
  exit /b 1
)
echo Starting ^(first run builds the image -- this can take a few minutes^)...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Failed to start. See errors above.
  pause
  exit /b 1
)
echo.
echo Waiting for the configurator UI to come online...
set /a "_waited=0"
:waitloop
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8765/api/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo Opening README and configurator UI...
  if exist "%~dp0README.html" start "" "%~dp0README.html"
  start "" "http://localhost:8765?view=onboarding"
  goto :ready
)
set /a "_waited+=1"
if %_waited% geq 60 goto :ready
timeout /t 1 /nobreak >nul
goto :waitloop
:ready
echo.
echo Sidecar is up.
echo   Configurator UI:  http://localhost:8765
echo   OTLP gRPC:        localhost:4317
echo   OTLP HTTP:        localhost:4318
echo.
echo Stop with: docker compose down
echo.
pause
`;

const renderReadme = ({ xSource, endpoint }) => `# Helix OTel Configurator Sidecar

Generated by the **simulated** BMC Helix AIOps page for source **${xSource}**.

> ⚠️ The \`HELIX_API_KEY\` in \`.env\` is a fake key produced by the demo
> backend — it will not authenticate against a real Helix tenant. Replace it
> with a real key from your tenant before sending production telemetry.

This package runs the Helix OTel Configurator alongside an OpenTelemetry
collector that forwards traces/metrics/logs to:

    ${endpoint}

## Prerequisites

- Docker Desktop (Mac / Windows) or Docker Engine + Compose plugin (Linux)
- ~3 GB free disk for the first build (Node base images + dependencies)

## Run

### Mac (one click)
**Double-click \`start.command\`** in Finder. A Terminal window opens, builds
the image on first run, and starts the sidecar.

> First time only: macOS Gatekeeper may warn that the file was downloaded
> from the internet. Right-click \`start.command\` → **Open** → **Open**, and
> macOS will remember the choice for next time.

### Windows (one click)
**Double-click \`start.bat\`** in Explorer. A console window opens, builds
the image on first run, and starts the sidecar.

### Linux (terminal)
\`\`\`bash
chmod +x start.sh
./start.sh
\`\`\`

The first run builds the configurator image locally (no registry pull
required) and may take a few minutes. Subsequent runs reuse the cached image
and start in seconds.

## Update

To pick up new releases of the configurator, **re-run the same install
one-liner** you used originally. The installer detects the existing
\`helix-configurator/\` directory and preserves your user-owned files while
refreshing the source code:

- \`.env\` — your credentials and source name
- \`helix-otel-collector.yaml\` — gateway pipeline config (including any edits
  you made via the dashboard YAML editor)
- \`data/\` — local OTel trace store database

Everything else (\`Dockerfile\`, \`docker-compose.yml\`, \`backend/\`,
\`frontend/\`, \`start.*\`, this README) is replaced with the new bundle
content, and \`docker compose up -d --build\` rebuilds the image with the
updated source.

If extraction fails mid-update, the installer restores the preserved files
into a fresh \`helix-configurator/\` so you're never left without your \`.env\`.

> **Where do I get the install one-liner from again?** Open the simulated
> AIOps page in your tenant, re-enter your source name (\`${xSource}\`), and
> copy the new \`curl ... | sh\` / \`iwr ... | iex\` command. Tokens are
> session-scoped on the demo host; if the host has restarted since your
> first install, you'll need a fresh command.

## What's inside

| File | Purpose |
| --- | --- |
| \`docker-compose.yml\` | Brings up the configurator + OTel collector |
| \`Dockerfile\` | Build instructions for the configurator image |
| \`backend/\`, \`frontend/\`, \`templates/\` | Configurator source (used at build time) |
| \`helix-otel-collector.yaml\` | Collector pipeline config |
| \`.env\` | Your generated credentials and source name (hidden — \`ls -a\` to see) |
| \`start.command\` | Mac double-click launcher |
| \`start.bat\` | Windows double-click launcher |
| \`start.sh\` | Linux / terminal launcher |

> **Where's \`.env\`?** It's a dotfile, so \`ls\` won't show it on macOS / Linux.
> Run \`ls -a\` to confirm it's there. The Finder hides it by default; press
> ⌘⇧. (cmd-shift-period) to reveal hidden files.

## Endpoints

- Configurator UI: http://localhost:8765
- OTLP gRPC ingest: localhost:4317
- OTLP HTTP ingest: localhost:4318
- Collector internal metrics: http://localhost:8888/metrics

Point your instrumented application at \`http://localhost:4317\` (gRPC) or
\`http://localhost:4318\` (HTTP) and the collector will forward to Helix.

## Stop

\`\`\`bash
docker compose down
\`\`\`
`;

// Pick the most likely LAN-reachable IPv4. Skip loopback, docker bridges, VPN
// tunnels, and VM interfaces. Prefer 192.168.x and 10.x ranges (typical
// home/corp LANs) over 172.16-31.x (often docker/VPN). When the AIOps page is
// opened at localhost we substitute this in so the install command pasted on
// another machine on the same LAN actually reaches the backend.
// In-memory session store for the AIOps configure → install → download flow.
// A session pins the apiKey + xSource so the value shown in the UI matches
// what's in the downloaded zip / installed .env. TTL is 1h; cleaned every 10m.
const aiopsSessions = new Map();
const AIOPS_SESSION_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of aiopsSessions.entries()) {
    if (now - s.createdAt > AIOPS_SESSION_TTL_MS) aiopsSessions.delete(tok);
  }
}, 10 * 60 * 1000).unref();

// HTML wrapper for the rendered README — a self-contained file we ship in
// the install bundle so start.{bat,sh,command} can open it in the user's
// default browser without depending on any .md file association.
const renderReadmeHtml = (ctx) => {
  const body = marked.parse(renderReadme(ctx));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helix OTel Configurator — getting started</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 24px 64px;
    color: #1f2330;
    background: #fafbfc;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e8ee; background: #1b1f29; }
    code { background: #2a3140; }
    pre { background: #11151c; }
    a { color: #8ca1f3; }
    table th { background: #2a3140; }
    table td, table th { border-color: #2a3140; }
    blockquote { border-left-color: #4040d9; color: #d5d6dd; }
  }
  h1 { font-size: 1.875rem; margin: 0 0 0.5em; }
  h2 { margin-top: 2em; border-bottom: 1px solid #d5d6dd; padding-bottom: 0.25em; }
  h3 { margin-top: 1.5em; }
  code { font: 0.9em "SF Mono", "Source Code Pro", Menlo, Consolas, monospace; background: #eef0f5; padding: 1px 6px; border-radius: 3px; }
  pre { background: #f1f1f4; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 4px solid #4040d9; margin: 1em 0; padding: 0.25em 1em; color: #555; background: rgba(64,64,217,0.06); }
  table { border-collapse: collapse; width: 100%; }
  table th, table td { border: 1px solid #d5d6dd; padding: 6px 10px; text-align: left; }
  table th { background: #f1f1f4; }
  a { color: #3759d8; }
  .hint { font-size: 0.85em; color: #777; margin-top: 2em; padding-top: 1em; border-top: 1px solid #d5d6dd; }
</style>
</head>
<body>
${body}
<p class="hint">This page was generated by the BMC Helix AIOps install bundle. Configurator UI: <a href="http://localhost:8765">http://localhost:8765</a></p>
</body>
</html>
`;
};

// Slim Dockerfile shipped in the install zip. The repo's main Dockerfile
// has a frontend-build stage that depends on the frontend/ source — but
// inside the running configurator container we only have the *built*
// frontend-dist. So the install bundle uses a single-stage Dockerfile that
// installs backend prod deps and copies the prebuilt frontend straight in.
const renderInstallDockerfile = () => `FROM node:20-slim
WORKDIR /app

# Install backend production dependencies. Pin via package-lock.json.
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# App source. frontend-dist is the already-built Vite bundle.
COPY backend/ ./backend/
COPY templates/ ./templates/
COPY frontend-dist/ ./frontend-dist/

EXPOSE 3001
CMD ["node", "backend/index.js"]
`;

const writePackageToArchive = (archive, ctx) => {
  archive.append(renderDockerCompose(), { name: 'helix-configurator/docker-compose.yml' });
  archive.append(renderCollectorYaml(ctx), { name: 'helix-configurator/helix-otel-collector.yaml' });
  archive.append(renderEnvFile(ctx), { name: 'helix-configurator/.env' });
  archive.append(renderShellLauncher({ interactive: false }), { name: 'helix-configurator/start.sh', mode: 0o755 });
  archive.append(renderShellLauncher({ interactive: true }), { name: 'helix-configurator/start.command', mode: 0o755 });
  archive.append(renderStartBat(), { name: 'helix-configurator/start.bat' });
  archive.append(renderReadme(ctx), { name: 'helix-configurator/README.md' });
  archive.append(renderReadmeHtml(ctx), { name: 'helix-configurator/README.html' });
  archive.append(renderInstallDockerfile(), { name: 'helix-configurator/Dockerfile' });

  // The bundler runs from inside the configurator container where
  // __dirname is /app/backend → projectRoot is /app. /app only contains
  // the runtime artifacts: backend/, templates/, frontend-dist/. There is
  // no Dockerfile or frontend/ source here — the install Dockerfile above
  // is generated inline, and we glob frontend-dist (the built bundle).
  const projectRoot = path.resolve(__dirname, '..');
  const ignore = ['**/node_modules/**', '**/.DS_Store', '**/dist/**', '**/.git/**'];
  archive.glob('backend/**/*', { cwd: projectRoot, ignore, dot: true }, { prefix: 'helix-configurator' });
  archive.glob('frontend-dist/**/*', { cwd: projectRoot, ignore, dot: true }, { prefix: 'helix-configurator' });
  archive.glob('templates/**/*', { cwd: projectRoot, ignore, dot: true }, { prefix: 'helix-configurator' });
};

const renderBashInstaller = ({ token, baseUrl, xSource }) => {
  // Single-quoted bash literals — escape only the values we interpolate.
  const safeName = xSource.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `#!/usr/bin/env bash
set -e
TOKEN='${token}'
BASE_URL='${baseUrl}'
XSOURCE='${safeName}'
# Install into the directory the user ran the install command from. \`pwd\`
# inside a curl|bash pipe reflects the parent shell's cwd, which is what
# users expect (run from ~/projects → install lands in ~/projects/...).
TARGET="$(pwd)/helix-configurator-\${XSOURCE}"

echo "================================================"
echo " Helix OTel Configurator — One-line install"
echo "================================================"
echo ""
echo "Source:  $XSOURCE"
echo "Target:  $TARGET"
echo ""

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed. Install Docker Desktop and re-run:"
  echo "  https://www.docker.com/products/docker-desktop/"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$(uname)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
    echo "Docker is installed but not running. Starting Docker Desktop..."
    open -a Docker
    printf "Waiting for the Docker daemon to become ready (up to 2 minutes)"
    deadline=$(( $(date +%s) + 120 ))
    while [ $(date +%s) -lt $deadline ]; do
      sleep 3
      if docker info >/dev/null 2>&1; then printf " ready\\n"; break; fi
      printf "."
    done
    if ! docker info >/dev/null 2>&1; then
      printf "\\n"
      echo "Docker Desktop didn't finish starting in 2 minutes."
      echo "Wait for the whale icon in the menu bar to settle, then re-run this command."
      exit 1
    fi
  else
    echo "Docker is installed but not running. Start the Docker daemon, then re-run this command."
    exit 1
  fi
fi

mkdir -p "$TARGET"
cd "$TARGET"

# If a prior install exists, back up user-owned files so we can refresh the
# source code without nuking real credentials, edited gateway YAML, or the
# local OTel trace store.
HELIX_BAK=""
if [ -d helix-configurator ]; then
  echo "Existing install detected — preserving .env, helix-otel-collector.yaml, and data/."
  HELIX_BAK=$(mktemp -d "\${TMPDIR:-/tmp}/helix-update.XXXXXX")
  for keep in .env helix-otel-collector.yaml data; do
    if [ -e "helix-configurator/$keep" ]; then
      cp -R "helix-configurator/$keep" "$HELIX_BAK/"
    fi
  done
fi

# Force a clean slate so a partial/stale extract from a prior failed run can't
# leave a corrupt Dockerfile (etc.) that survives unzip -o.
rm -rf helix-configurator
echo "Downloading package..."
curl -fsSL "$BASE_URL/api/_demo/aiops/package/$TOKEN" -o package.zip
echo "Extracting..."
unzip -oq package.zip
rm package.zip
if [ ! -d helix-configurator ]; then
  echo "Error: extraction failed — helix-configurator/ directory missing."
  if [ -n "$HELIX_BAK" ]; then
    echo "Restoring preserved files..."
    mkdir -p helix-configurator
    cp -R "$HELIX_BAK/." helix-configurator/ 2>/dev/null || true
    rm -rf "$HELIX_BAK"
  fi
  exit 1
fi

# Re-overlay user files on top of the fresh extract. The bundle ships
# placeholder versions of .env / helix-otel-collector.yaml; those are useful
# on a first install but would clobber real values on update.
if [ -n "$HELIX_BAK" ]; then
  for keep in .env helix-otel-collector.yaml data; do
    if [ -e "$HELIX_BAK/$keep" ]; then
      rm -rf "helix-configurator/$keep"
      cp -R "$HELIX_BAK/$keep" "helix-configurator/"
    fi
  done
  rm -rf "$HELIX_BAK"
fi
cd helix-configurator
for required in Dockerfile docker-compose.yml .env; do
  if [ ! -f "$required" ]; then
    echo "Error: '$required' is missing after extract. Listing:"
    ls -la
    exit 1
  fi
done
echo "Building image and starting (first run takes a few minutes)..."
docker compose up -d --build
echo ""
echo "Waiting for the configurator UI to come online..."
deadline=$(( $(date +%s) + 60 ))
while [ $(date +%s) -lt $deadline ]; do
  if curl -fsS http://localhost:8765/api/health >/dev/null 2>&1; then
    echo "Opening README and configurator UI..."
    if [ "$(uname)" = "Darwin" ]; then
      [ -f README.html ] && open README.html || true
      open "http://localhost:8765?view=onboarding" || true
    elif [ -n "$DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then
      [ -f README.html ] && (xdg-open README.html >/dev/null 2>&1 &)
      (xdg-open "http://localhost:8765?view=onboarding" >/dev/null 2>&1 &)
    fi
    break
  fi
  sleep 1
done
echo ""
echo "Sidecar is up."
echo "  Configurator UI:  http://localhost:8765"
echo "  OTLP gRPC:        localhost:4317"
echo "  OTLP HTTP:        localhost:4318"
echo ""
echo "Installed to: $TARGET/helix-configurator"
echo "Stop with:    cd $TARGET/helix-configurator && docker compose down"
`;
};

const renderPowerShellInstaller = ({ token, baseUrl, xSource }) => {
  const safeName = xSource.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `$ErrorActionPreference = 'Stop'
$Token = '${token}'
$BaseUrl = '${baseUrl}'
$XSource = '${safeName}'
# Install into the directory PowerShell was run from. \$PWD reflects the
# caller's location even when invoked via 'iwr | iex', so running from
# C:\\Users\\james\\source\\repos drops the install there, not in \$HOME.
$Target = Join-Path $PWD.Path "helix-configurator-$XSource"

# PowerShell treats stderr from native commands as a terminating error when
# $ErrorActionPreference is 'Stop' (PS 7.3+ via $PSNativeCommandUseErrorActionPreference).
# Wrap docker calls so we can check $LASTEXITCODE explicitly without the
# script aborting on stderr that docker / BuildKit emits during normal use.
function Test-DockerRunning {
  $ErrorActionPreference = 'SilentlyContinue'
  docker info 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

Write-Host "================================================"
Write-Host " Helix OTel Configurator -- One-line install"
Write-Host "================================================"
Write-Host ""
Write-Host "Source:  $XSource"
Write-Host "Target:  $Target"
Write-Host ""

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker isn't installed. Install Docker Desktop and re-run:"
  Write-Host "  https://www.docker.com/products/docker-desktop/"
  exit 1
}
if (-not (Test-DockerRunning)) {
  $dockerExe = "$env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe"
  if (-not (Test-Path $dockerExe)) {
    $dockerExe = "$env:LOCALAPPDATA\\Docker\\Docker Desktop.exe"
  }
  if (Test-Path $dockerExe) {
    Write-Host "Docker is installed but not running. Starting Docker Desktop..."
    Start-Process -FilePath $dockerExe
    Write-Host -NoNewline "Waiting for the Docker daemon to become ready (up to 2 minutes)"
    $deadline = (Get-Date).AddMinutes(2)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      if (Test-DockerRunning) { $ready = $true; break }
      Write-Host -NoNewline "."
    }
    if ($ready) {
      Write-Host " ready"
    } else {
      Write-Host ""
      Write-Host "Docker Desktop didn't finish starting in 2 minutes."
      Write-Host "Wait for the whale icon in the system tray to stop animating, then re-run this command."
      exit 1
    }
  } else {
    Write-Host "Docker Desktop binary not found at the default install path. Open Docker Desktop manually, wait for the whale icon to settle, then re-run this command."
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null
Set-Location $Target

# If a prior install exists, back up user-owned files so re-running the
# installer refreshes the source code without nuking real credentials, edited
# gateway YAML, or the local OTel trace store.
$bak = $null
if (Test-Path "helix-configurator") {
  Write-Host "Existing install detected -- preserving .env, helix-otel-collector.yaml, and data/."
  $bak = Join-Path $env:TEMP ("helix-update-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $bak | Out-Null
  foreach ($keep in @('.env', 'helix-otel-collector.yaml', 'data')) {
    $src = Join-Path "helix-configurator" $keep
    if (Test-Path $src) { Copy-Item -Recurse -Force $src $bak }
  }
}

# Force a clean slate so a partial/stale extract can't leave a corrupt file behind.
if (Test-Path "helix-configurator") { Remove-Item -Recurse -Force "helix-configurator" }
Write-Host "Downloading package..."
Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/_demo/aiops/package/$Token" -OutFile "package.zip"
Write-Host "Extracting..."
Expand-Archive -Force -Path "package.zip" -DestinationPath "."
Remove-Item "package.zip"
if (-not (Test-Path "helix-configurator")) {
  Write-Host "Error: extraction failed -- helix-configurator/ directory missing."
  if ($bak) {
    Write-Host "Restoring preserved files..."
    New-Item -ItemType Directory -Force -Path "helix-configurator" | Out-Null
    Get-ChildItem -Force -Path $bak | ForEach-Object {
      Copy-Item -Recurse -Force $_.FullName "helix-configurator"
    }
    Remove-Item -Recurse -Force $bak
  }
  exit 1
}

# Re-overlay user files on top of the fresh extract. The bundle ships
# placeholder versions of .env / helix-otel-collector.yaml; those are useful
# on a first install but would clobber real values on update.
if ($bak) {
  foreach ($keep in @('.env', 'helix-otel-collector.yaml', 'data')) {
    $src = Join-Path $bak $keep
    if (Test-Path $src) {
      $dst = Join-Path "helix-configurator" $keep
      if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
      Copy-Item -Recurse -Force $src "helix-configurator"
    }
  }
  Remove-Item -Recurse -Force $bak
}

Set-Location "helix-configurator"
foreach ($required in @('Dockerfile', 'docker-compose.yml', '.env')) {
  if (-not (Test-Path $required)) {
    Write-Host "Error: '$required' is missing after extract. Listing:"
    Get-ChildItem -Force | Format-Table
    exit 1
  }
}
Write-Host "Building image and starting (first run takes a few minutes)..."
# BuildKit emits build progress to stderr, which would terminate the script
# under $ErrorActionPreference = 'Stop'. Relax it just for the build call so
# the user sees full progress and we can act on the real exit code.
$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
docker compose up -d --build
$buildExit = $LASTEXITCODE
$ErrorActionPreference = $prevPref
if ($buildExit -ne 0) {
  Write-Host ""
  Write-Host "Failed to start the sidecar. See errors above."
  exit 1
}

Write-Host ""
Write-Host "Waiting for the configurator UI to come online..."
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8765/api/health" -TimeoutSec 2 | Out-Null
    Write-Host "Opening http://localhost:8765 ..."
    Start-Process "http://localhost:8765?view=onboarding"
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}

Write-Host ""
Write-Host "Sidecar is up."
Write-Host "  Configurator UI:  http://localhost:8765"
Write-Host "  OTLP gRPC:        localhost:4317"
Write-Host "  OTLP HTTP:        localhost:4318"
Write-Host ""
Write-Host "Installed to: $Target\\helix-configurator"
Write-Host "Stop with:    cd $Target\\helix-configurator; docker compose down"
`;
};

// POST /api/_demo/aiops/configure — create a session, return token + simulated key.
app.post('/api/_demo/aiops/configure', (req, res) => {
  const { xSource } = req.body || {};
  if (typeof xSource !== 'string' || !xSource.trim()) {
    return res.status(400).json({ error: 'xSource is required' });
  }
  const session = {
    xSource: xSource.trim(),
    endpoint: SIMULATED_INGEST_ENDPOINT,
    apiKey: fakeHelixApiKey(),
    createdAt: Date.now(),
  };
  const token = crypto.randomBytes(16).toString('hex');
  aiopsSessions.set(token, session);
  res.json({
    token,
    apiKey: session.apiKey,
    xSource: session.xSource,
    endpoint: session.endpoint,
    // The host portion of installBaseUrl will be the LAN IP when the request
    // came from localhost — so the curl/iwr command shown in the UI works
    // when pasted on a different machine on the same network.
    installBaseUrl: computeInstallBaseUrl(req),
  });
});

// GET /api/_demo/aiops/package/:token — stream the configured zip.
app.get('/api/_demo/aiops/package/:token', (req, res) => {
  const session = aiopsSessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session expired or not found' });
  const safeName = session.xSource.replace(/[^A-Za-z0-9._-]+/g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="helix-configurator-${safeName}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('archive error:', err);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  archive.pipe(res);
  writePackageToArchive(archive, session);
  archive.finalize();
});

// GET /api/_demo/aiops/install/:token.sh — bash one-liner installer.
app.get('/api/_demo/aiops/install/:token.sh', (req, res) => {
  const session = aiopsSessions.get(req.params.token);
  if (!session) {
    return res.status(404).type('text/plain').send('# Session expired or not found\nexit 1\n');
  }
  const baseUrl = computeInstallBaseUrl(req);
  res.type('text/x-shellscript');
  res.send(renderBashInstaller({ token: req.params.token, baseUrl, xSource: session.xSource }));
});

// GET /api/_demo/aiops/install/:token.ps1 — PowerShell one-liner installer.
app.get('/api/_demo/aiops/install/:token.ps1', (req, res) => {
  const session = aiopsSessions.get(req.params.token);
  if (!session) {
    return res.status(404).type('text/plain').send('# Session expired or not found\nexit 1\n');
  }
  const baseUrl = computeInstallBaseUrl(req);
  res.type('text/plain');
  res.send(renderPowerShellInstaller({ token: req.params.token, baseUrl, xSource: session.xSource }));
});
// --------------------------------------------------------------------------

// --- OTel trace store (local fan-out from helix-gateway) -----------------
// SQLite lives in a mounted volume so traces survive container restarts.
// Outside Docker we fall back to backend/data so dev is self-contained.
const OTEL_DB_PATH = process.env.OTEL_DB_PATH ||
  (fs.existsSync('/app') ? '/app/data/otel-store.db' : path.join(__dirname, 'data', 'otel-store.db'));
const otelStore = new OtelStore({ dbPath: OTEL_DB_PATH });
console.log(`OTel trace store: ${OTEL_DB_PATH}`);

// Decode an OTLP/HTTP request body. The gateway is configured for JSON +
// no compression, but we still tolerate gzip in case the user wires their
// own collector at this endpoint.
const decodeOtlpBody = (req) => {
  let buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const enc = (req.headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
  else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('protobuf')) {
    // Protobuf encoding not supported here — the local_store exporter is
    // configured for JSON. Surface a clear error so a misconfig is obvious
    // in the gateway logs.
    throw new Error('OTLP protobuf encoding is not supported by /api/otlp; configure the exporter with encoding: json');
  }
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
};

// POST /api/otlp/traces — public ingest from the gateway fan-out.
// The configurator-side session cookie is irrelevant on this hop, and
// requiring auth would block the gateway. We bind the listener to the
// in-cluster docker network only via the helix-bridge / port-forward setup.
app.post('/api/otlp/traces', (req, res) => {
  try {
    const body = decodeOtlpBody(req);
    const spans = extractSpans(body);
    otelStore.ingestSpans(spans);
    // OTLP/HTTP success response is an empty ExportTraceServiceResponse.
    res.json({});
  } catch (e) {
    console.error('OTLP traces ingest error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// POST /api/otlp/logs — receives OTLP log records from helix-gateway's
// fan-out pipeline. Logs are stored in log_records and surfaced both
// per-trace (in the trace detail drawer) and as a cross-trace feed in the
// Logs & Errors tab.
app.post('/api/otlp/logs', (req, res) => {
  try {
    const body = decodeOtlpBody(req);
    const logs = extractLogRecords(body);
    otelStore.ingestLogs(logs);
    res.json({});
  } catch (e) {
    console.error('OTLP logs ingest error:', e.message);
    res.status(400).json({ error: e.message });
  }
});
// --------------------------------------------------------------------------

// Gate everything else under /api/*
app.use('/api', requireAuth);
// --------------------------------------------------------------------------

// --- OTel trace query endpoints (auth-gated) ------------------------------
app.get('/api/traces', (req, res) => {
  const { service, sinceMs, untilMs, limit, q } = req.query;
  const svc = typeof service === 'string' && service ? service : undefined;
  const since = sinceMs ? Number(sinceMs) : undefined;
  const until = untilMs ? Number(untilMs) : undefined;
  const query = typeof q === 'string' && q ? q : undefined;
  const traces = otelStore.listTraces({
    service: svc,
    sinceMs: since,
    untilMs: until,
    q: query,
    limit: limit ? Number(limit) : 200,
  });
  res.json({ traces });
});

app.get('/api/traces/services', (req, res) => {
  res.json({ services: otelStore.listServices() });
});

app.get('/api/traces/errors', (req, res) => {
  const { limit } = req.query;
  res.json({ errors: otelStore.listErrors({ limit: limit ? Number(limit) : 200 }) });
});

app.get('/api/traces/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');

  const onTrace = (summary) => {
    res.write(`event: trace\ndata: ${JSON.stringify(summary)}\n\n`);
  };
  const onError = (err) => {
    res.write(`event: error_record\ndata: ${JSON.stringify(err)}\n\n`);
  };
  const onLog = (log) => {
    res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
  };
  const onCountsUpdate = (update) => {
    res.write(`event: trace_counts_update\ndata: ${JSON.stringify(update)}\n\n`);
  };
  otelStore.events.on('trace', onTrace);
  otelStore.events.on('span_error', onError);
  otelStore.events.on('log', onLog);
  otelStore.events.on('trace_counts_update', onCountsUpdate);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    otelStore.events.off('trace', onTrace);
    otelStore.events.off('span_error', onError);
    otelStore.events.off('log', onLog);
    otelStore.events.off('trace_counts_update', onCountsUpdate);
  });
});

// Item 8: per-(service, root_operation) aggregates for the new Operations tab.
app.get('/api/operations', (req, res) => {
  const { sinceMs, untilMs, slowThresholdMs } = req.query;
  res.json({
    operations: otelStore.listOperations({
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      untilMs: untilMs ? Number(untilMs) : undefined,
      slowThresholdMs: slowThresholdMs ? Number(slowThresholdMs) : undefined,
    }),
  });
});

// Single-round-trip aggregate powering the Overview tab — four headline
// stats (with sparklines + delta-vs-previous-window), top services, top
// errors. Service filter narrows the trace pool consistently with the rest
// of the Traces API.
app.get('/api/overview', async (req, res) => {
  const { sinceMs, untilMs, service } = req.query;
  const payload = otelStore.overview({
    sinceMs: sinceMs ? Number(sinceMs) : undefined,
    untilMs: untilMs ? Number(untilMs) : undefined,
    service: typeof service === 'string' && service ? service : undefined,
  });
  // Lightweight Grafana-style annotations: surface gateway lifecycle events
  // (last container start) as a vertical event marker on the volume chart.
  // Only emit when within the chart window so off-window restarts don't
  // float at the edges.
  const annotations = [];
  try {
    const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
    const info = await docker.getContainer(targetContainer).inspect();
    const startedAt = info && info.State && info.State.StartedAt ? Date.parse(info.State.StartedAt) : NaN;
    if (Number.isFinite(startedAt) && startedAt >= payload.windowMs.start && startedAt <= payload.windowMs.end) {
      annotations.push({ tsMs: startedAt, label: `${targetContainer} restarted`, tone: 'info' });
    }
  } catch { /* docker inspect non-fatal */ }
  payload.annotations = annotations;
  res.json(payload);
});

// Composite bundle for the Overview tab: returns everything the page needs
// in a single round-trip — overview stats, traces histogram (+ prior window
// for the AppD-style comparison overlay), logs histogram, heatmap, insights,
// and service map. Replaces six separate fetches the frontend was firing in
// lockstep on every refresh tick.
app.get('/api/overview-bundle', async (req, res) => {
  const { sinceMs, untilMs, buckets, service, slowThresholdMs } = req.query;
  const since = sinceMs ? Number(sinceMs) : undefined;
  const until = untilMs ? Number(untilMs) : undefined;
  const svc = typeof service === 'string' && service ? service : undefined;
  const slow = slowThresholdMs ? Number(slowThresholdMs) : undefined;
  const bucketCount = buckets ? Number(buckets) : 60;
  const tracesHist = otelStore.tracesHistogram({ sinceMs: since, untilMs: until, buckets: bucketCount, service: svc, slowThresholdMs: slow });
  // Prior window = same-duration window immediately preceding the requested one.
  let priorTracesHist = null;
  if (since != null && until != null) {
    const span = until - since;
    priorTracesHist = otelStore.tracesHistogram({
      sinceMs: since - span,
      untilMs: until - span,
      buckets: bucketCount,
      service: svc,
      slowThresholdMs: slow,
    });
  }
  const overview = otelStore.overview({ sinceMs: since, untilMs: until, service: svc });
  const logsHist = otelStore.logsHistogram({ sinceMs: since, untilMs: until, buckets: bucketCount });
  const heatmap = otelStore.latencyHeatmap({
    sinceMs: since, untilMs: until,
    timeBuckets: 48, durationBuckets: 12,
    service: svc,
  });
  const insights = otelStore.insights({ sinceMs: since, untilMs: until, service: svc });
  const serviceMap = otelStore.serviceMap({ sinceMs: since, untilMs: until });

  // Annotation: gateway restart (mirrors the standalone /api/overview).
  const annotations = [];
  try {
    const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
    const info = await docker.getContainer(targetContainer).inspect();
    const startedAt = info && info.State && info.State.StartedAt ? Date.parse(info.State.StartedAt) : NaN;
    if (Number.isFinite(startedAt) && startedAt >= overview.windowMs.start && startedAt <= overview.windowMs.end) {
      annotations.push({ tsMs: startedAt, label: `${targetContainer} restarted`, tone: 'info' });
    }
  } catch { /* non-fatal */ }

  res.json({
    overview: { ...overview, annotations },
    tracesHistogram: tracesHist,
    priorTotals: priorTracesHist ? priorTracesHist.buckets.map(b => b.total || 0) : null,
    logsHistogram: logsHist,
    heatmap,
    insights,
    serviceMap,
  });
});

// Datadog-style service map: nodes (services that produced traces) + edges
// (parent→child inter-service calls). Layout computed client-side.
app.get('/api/service-map', (req, res) => {
  const { sinceMs, untilMs } = req.query;
  res.json(otelStore.serviceMap({
    sinceMs: sinceMs ? Number(sinceMs) : undefined,
    untilMs: untilMs ? Number(untilMs) : undefined,
  }));
});

// Davis-style insights: small rule-based anomaly narrator. Returns 0-3
// short plain-English findings comparing current window vs prior. Backend
// is intentionally simple (thresholded comparisons), not LLM-driven.
app.get('/api/insights', (req, res) => {
  const { sinceMs, untilMs, service } = req.query;
  res.json(otelStore.insights({
    sinceMs: sinceMs ? Number(sinceMs) : undefined,
    untilMs: untilMs ? Number(untilMs) : undefined,
    service: typeof service === 'string' && service ? service : undefined,
  }));
});

// 2-D heatmap: traces binned by (time, duration). Duration axis log-scaled
// to keep the slow tail readable next to the fast bulk.
app.get('/api/traces/latency-heatmap', (req, res) => {
  const { sinceMs, untilMs, timeBuckets, durationBuckets, service } = req.query;
  res.json(otelStore.latencyHeatmap({
    sinceMs: sinceMs ? Number(sinceMs) : undefined,
    untilMs: untilMs ? Number(untilMs) : undefined,
    timeBuckets: timeBuckets ? Number(timeBuckets) : undefined,
    durationBuckets: durationBuckets ? Number(durationBuckets) : undefined,
    service: typeof service === 'string' && service ? service : undefined,
  }));
});

// Time-binned aggregates for the timeline chart on the Traces tab. Each bucket
// reports total / ok / slow / error counts plus p50 + p95 duration in ms.
app.get('/api/traces/histogram', (req, res) => {
  const { sinceMs, untilMs, buckets, service, slowThresholdMs } = req.query;
  res.json(otelStore.tracesHistogram({
    sinceMs: sinceMs ? Number(sinceMs) : undefined,
    untilMs: untilMs ? Number(untilMs) : undefined,
    buckets: buckets ? Number(buckets) : undefined,
    service: typeof service === 'string' && service ? service : undefined,
    slowThresholdMs: slowThresholdMs ? Number(slowThresholdMs) : undefined,
  }));
});

app.get('/api/traces/:traceId', (req, res) => {
  const { traceId } = req.params;
  if (!/^[0-9a-fA-F]{1,64}$/.test(traceId)) {
    return res.status(400).json({ error: 'Invalid trace id' });
  }
  const trace = otelStore.getTrace(traceId.toLowerCase());
  if (!trace) return res.status(404).json({ error: 'Not found' });
  res.json(trace);
});

app.get('/api/logs', (req, res) => {
  const { severity, q, sinceMs, limit } = req.query;
  res.json({
    logs: otelStore.listLogs({
      severity,
      q,
      sinceMs: sinceMs ? Number(sinceMs) : undefined,
      limit: limit ? Number(limit) : undefined,
    }),
  });
});

// Severity-stacked log volume buckets for the Logs / Errors timeline.
app.get('/api/logs/histogram', (req, res) => {
  const { sinceMs, untilMs, buckets } = req.query;
  res.json(otelStore.logsHistogram({
    sinceMs: sinceMs ? Number(sinceMs) : undefined,
    untilMs: untilMs ? Number(untilMs) : undefined,
    buckets: buckets ? Number(buckets) : undefined,
  }));
});

app.get('/api/logs/:traceId', (req, res) => {
  const { traceId } = req.params;
  if (!/^[0-9a-fA-F]{1,64}$/.test(traceId)) {
    return res.status(400).json({ error: 'Invalid trace id' });
  }
  res.json({ logs: otelStore.listLogsForTrace(traceId.toLowerCase()) });
});
// --------------------------------------------------------------------------

require('./routes/situations').register(app, { otelStore });


// GET current config
app.get('/api/config', (req, res) => {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    res.json({ yaml: fileContents });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read config file' });
  }
});

// Wait for the gateway to settle into a final state after a restart.
// Returns { running, state, exitCode, recentLogs } once stable, or once timeoutMs elapses.
const waitForGatewaySettle = async (targetContainer, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const inspect = await docker.getContainer(targetContainer).inspect();
      const state = (inspect && inspect.State) || {};
      lastState = state;
      const startedAt = state.StartedAt ? Date.parse(state.StartedAt) : 0;
      const upMs = startedAt ? Date.now() - startedAt : 0;
      // Healthy: running and has been running for >=2s without flipping
      if (state.Status === 'running' && upMs >= 2000) {
        return { running: true, state, exitCode: state.ExitCode };
      }
      // Already failed: exited with non-zero
      if (state.Status === 'exited') {
        const recentLogs = await containerLogs(targetContainer, { tail: 50 }).catch(() => '');
        return { running: false, state, exitCode: state.ExitCode, recentLogs };
      }
    } catch { /* container missing — keep polling */ }
    await new Promise(r => setTimeout(r, 400));
  }
  // Timed out without a definitive answer — best-effort report
  const recentLogs = await containerLogs(targetContainer, { tail: 50 }).catch(() => '');
  return {
    running: lastState && lastState.Status === 'running',
    state: lastState || {},
    exitCode: lastState && lastState.ExitCode,
    recentLogs,
  };
};

// Pull the most actionable error line out of a collector log dump.
const extractCollectorError = (logs) => {
  if (!logs) return '';
  const lines = logs.split('\n').map(l => l.trim()).filter(Boolean);
  // Prefer the last "Error:" line — collector startup writes its fatal error there.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Error:/.test(lines[i])) return lines[i];
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|invalid|cannot|failed/i.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] || '';
};

// POST update config — atomic save+restart with rollback if collector rejects the new YAML.
app.post('/api/config', async (req, res) => {
  const { content } = req.body;
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

  // 1. Syntax check before touching the file.
  try {
    yaml.load(content);
  } catch (e) {
    if (e.mark) {
      return res.status(400).json({
        error: 'Invalid YAML syntax',
        mark: { line: e.mark.line, column: e.mark.column, message: e.reason },
      });
    }
    return res.status(400).json({ error: 'Invalid YAML syntax', details: e.message });
  }

  const warnings = validateConfig(content);

  // 2. Snapshot existing content for rollback, then write the new one.
  let previous = '';
  try { previous = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { /* first save */ }
  try {
    fs.writeFileSync(CONFIG_PATH, content, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write config', details: e.message });
  }

  // 3. Restart the gateway and watch what happens. If the collector rejects the
  // new YAML, restore previous content and bounce the gateway back to a known-good
  // state so the user is never left with a broken pipeline.
  try {
    await docker.getContainer(targetContainer).restart();
  } catch (e) {
    // Restart itself failed — config is on disk but gateway didn't bounce.
    return res.status(500).json({
      error: 'Config saved but gateway restart failed',
      details: e.message,
      warnings,
    });
  }

  const settled = await waitForGatewaySettle(targetContainer);
  if (!settled.running) {
    // Roll back.
    try {
      fs.writeFileSync(CONFIG_PATH, previous, 'utf8');
      await docker.getContainer(targetContainer).restart().catch(() => {});
    } catch { /* best effort */ }
    return res.status(400).json({
      error: 'Config rejected by collector — rolled back',
      details: extractCollectorError(settled.recentLogs) || `Collector exited (code ${settled.exitCode})`,
      rolledBack: true,
      warnings,
    });
  }

  res.json({ message: 'Config updated successfully', warnings, restarted: true });
});

// GET list of available config templates
app.get('/api/templates', (req, res) => {
  try {
    const indexPath = path.join(TEMPLATES_DIR, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    res.json(index);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load templates', details: e.message });
  }
});

// GET single template content with env placeholders substituted
app.get('/api/templates/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9-]+$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid template id' });
  }
  try {
    const yamlPath = path.join(TEMPLATES_DIR, `${id}.yaml`);
    let content = fs.readFileSync(yamlPath, 'utf8');
    content = content
      .replace(/\$\{HELIX_ENDPOINT\}/g, process.env.HELIX_ENDPOINT || '')
      .replace(/\$\{HELIX_API_KEY\}/g, process.env.HELIX_API_KEY || '')
      .replace(/\$\{X_SOURCE\}/g, process.env.X_SOURCE || '');
    res.json({ id, content });
  } catch (e) {
    res.status(404).json({ error: 'Template not found' });
  }
});

let debugTimer = null;

// Function to strip debug logs and restart
const revertDebugMode = async () => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    const configContent = fs.readFileSync(CONFIG_PATH, 'utf8');
    const configObj = yaml.load(configContent);
    if (configObj.service && configObj.service.telemetry) {
      delete configObj.service.telemetry.logs;

      // Force heal metrics format
      configObj.service.telemetry.metrics = {
        readers: [{ pull: { exporter: { prometheus: { host: '0.0.0.0', port: 8888 } } } }]
      };

      const newYaml = yaml.dump(configObj, { lineWidth: -1 });
      fs.writeFileSync(CONFIG_PATH, newYaml, 'utf8');
      await docker.getContainer(targetContainer).restart().catch(() => {});
      console.log('Failsafe: Debug mode reverted and container restarted.');
    }
  } catch (e) {
    console.error('Failsafe revert failed:', e.message);
  }
};

// POST toggle debug logging in YAML and restart
app.post('/api/diagnostics/toggle-debug', async (req, res) => {
  const { enable } = req.body;
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

  if (debugTimer) {
    clearTimeout(debugTimer);
    debugTimer = null;
  }

  try {
    const configContent = fs.readFileSync(CONFIG_PATH, 'utf8');
    const configObj = yaml.load(configContent);

    configObj.service = configObj.service || {};
    configObj.service.telemetry = configObj.service.telemetry || {};

    // Force heal metrics format
    configObj.service.telemetry.metrics = {
      readers: [{ pull: { exporter: { prometheus: { host: '0.0.0.0', port: 8888 } } } }]
    };

    if (enable) {
      configObj.service.telemetry.logs = { level: 'debug' };
      debugTimer = setTimeout(revertDebugMode, 300000); // 5 minutes
    } else {
      delete configObj.service.telemetry.logs;
    }

    const newYaml = yaml.dump(configObj, { lineWidth: -1 });
    fs.writeFileSync(CONFIG_PATH, newYaml, 'utf8');

    try {
      await docker.getContainer(targetContainer).restart();
      res.json({ message: `Debug mode ${enable ? 'enabled' : 'disabled'}` });
    } catch (restartErr) {
      res.status(500).json({ error: 'Failed to restart for debug toggle', details: restartErr.message });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to toggle debug mode', details: e.message });
  }
});

// POST inject a synthetic OTLP trace with retries
app.post('/api/diagnostics/inject-trace', async (req, res) => {
  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'helix-gateway' } }] },
      scopeSpans: [{
        spans: [{
          traceId: '4bfb019245ced524157085c0a2825c71',
          spanId: '00f067aa0ba902b7',
          name: 'diagnostic-synthetic-trace',
          kind: 1,
          startTimeUnixNano: Date.now() * 1000000,
          endTimeUnixNano: (Date.now() + 100) * 1000000,
          status: { code: 1 }
        }]
      }]
    }]
  };

  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  const url = `http://${targetContainer}:4318/v1/traces`;
  
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    try {
      await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 2000
      });
      return res.json({ message: 'Synthetic trace injected successfully' });
    } catch (e) {
      attempts++;
      if (attempts >= maxAttempts) {
        return res.status(500).json({ error: 'Trace injection failed after retries', details: e.message });
      }
      await new Promise(r => setTimeout(r, 1000)); // Wait 1s between attempts
    }
  }
});

// Shared helper: parse the gateway's Prometheus metrics endpoint into { received, sent, failed }.
// Counters are cumulative since collector start; callers that need rates must compute deltas.
const fetchCounters = async (targetContainer) => {
  const url = `http://${targetContainer}:8888/metrics`;
  const response = await axios.get(url, { timeout: 2000 });
  const metrics = response.data;

  const extractSum = (baseName) => {
    const name = baseName + '_total';
    let sum = 0;
    metrics.split('\n').forEach(line => {
      if (line.startsWith(name)) {
        // Prometheus emits float64 — parseFloat so "1.234e+05" doesn't truncate.
        const parts = line.trim().split(/\s+/);
        const val = parseFloat(parts[parts.length - 1]);
        if (!isNaN(val)) {
          if (baseName.includes('exporter')) {
            if (line.includes('exporter="otlphttp/bmchelix"')) sum += val;
          } else {
            sum += val;
          }
        }
      }
    });
    return Math.round(sum);
  };

  return {
    received:
      extractSum('otelcol_receiver_accepted_spans') +
      extractSum('otelcol_receiver_accepted_metric_points') +
      extractSum('otelcol_receiver_accepted_log_records'),
    sent:
      extractSum('otelcol_exporter_sent_spans') +
      extractSum('otelcol_exporter_sent_metric_points') +
      extractSum('otelcol_exporter_sent_log_records'),
    failed:
      extractSum('otelcol_exporter_send_failed_spans') +
      extractSum('otelcol_exporter_send_failed_metric_points') +
      extractSum('otelcol_exporter_send_failed_log_records'),
  };
};

// True when the exporter is producing failures with zero successes — strong signal
// that auth/network is broken rather than intermittent flakiness. Used by the
// apikey check to escalate even when log scraping misses the failure window.
const checkExporterFailing = async (targetContainer) => {
  const c = await fetchCounters(targetContainer);
  return { failing: c.failed > 0 && c.sent === 0, ...c };
};

// POST inject a synthetic trace and verify it actually exported to Helix.
// Used by the wizard's "Verify Telemetry Flow" — proves the gateway→Helix
// path independent of whether the user's app is instrumented yet.
app.post('/api/diagnostics/inject-trace-verify', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  const otlpUrl = `http://${targetContainer}:4318/v1/traces`;
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');

  let baseline;
  try {
    baseline = await fetchCounters(targetContainer);
  } catch (e) {
    return res.status(503).json({
      error: 'Gateway metrics endpoint unreachable',
      details: e.message,
      remediation: 'The gateway is not running or not responding on :8888. Start it from the dashboard.',
    });
  }

  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'helix-configurator-verify' } }] },
      scopeSpans: [{
        spans: [{
          traceId, spanId,
          name: 'configurator-verify-trace',
          kind: 1,
          startTimeUnixNano: Date.now() * 1000000,
          endTimeUnixNano: (Date.now() + 100) * 1000000,
          status: { code: 1 },
        }],
      }],
    }],
  };

  try {
    await axios.post(otlpUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 3000,
    });
  } catch (e) {
    return res.status(502).json({
      error: 'Trace injection failed at gateway receiver',
      details: e.message,
      remediation: 'The gateway accepted no telemetry on :4318. Check that the gateway is running and the OTLP HTTP receiver is enabled.',
    });
  }

  // Poll the sent/failed counters for up to 5s. We're looking for a delta —
  // either the trace exported (sent went up) or it was rejected (failed went up).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const now = await fetchCounters(targetContainer);
      const sentDelta = now.sent - baseline.sent;
      const failedDelta = now.failed - baseline.failed;
      if (sentDelta > 0) {
        return res.json({
          status: 'exported',
          sentDelta, failedDelta,
          message: `Synthetic trace reached Helix (sent +${sentDelta})`,
        });
      }
      if (failedDelta > 0) {
        return res.json({
          status: 'rejected',
          sentDelta, failedDelta,
          message: `Helix rejected the trace (failed +${failedDelta})`,
          remediation: 'The gateway forwarded the trace but Helix rejected it. Verify HELIX_API_KEY and that the tenant is reachable.',
        });
      }
    } catch { /* metrics blip — keep polling */ }
  }

  res.json({
    status: 'pending',
    message: 'Trace accepted by gateway but no exporter delta within 5s — Helix may be slow or the exporter is queued',
    remediation: 'Open Diagnostic Health Check and watch the Sent/Dropped counters for the next minute.',
  });
});

// GET live metrics parsing
app.get('/api/diagnostics/metrics/live', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    const result = await fetchCounters(targetContainer);
    res.json(result);
  } catch (e) {
    console.error(`Failed to fetch metrics:`, e.message);
    res.json({ received: 0, sent: 0, failed: 0, error: e.message });
  }
});

// GET per-signal receiver counters. Used by Step 2's "App → Gateway" verifier
// to show whether the user's app is actually sending data into our gateway,
// broken out by signal type so we can label "spans / metrics / logs".
app.get('/api/diagnostics/receiver-counters', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  const url = `http://${targetContainer}:8888/metrics`;
  try {
    const response = await axios.get(url, { timeout: 2000 });
    const lines = response.data.split('\n');
    const sumOf = (baseName) => {
      const name = baseName + '_total';
      let sum = 0;
      for (const line of lines) {
        if (!line.startsWith(name)) continue;
        const parts = line.trim().split(/\s+/);
        const val = parseFloat(parts[parts.length - 1]);
        if (!isNaN(val)) sum += val;
      }
      return Math.round(sum);
    };
    res.json({
      acceptedSpans: sumOf('otelcol_receiver_accepted_spans'),
      acceptedMetricPoints: sumOf('otelcol_receiver_accepted_metric_points'),
      acceptedLogRecords: sumOf('otelcol_receiver_accepted_log_records'),
      refusedSpans: sumOf('otelcol_receiver_refused_spans'),
      refusedMetricPoints: sumOf('otelcol_receiver_refused_metric_points'),
      refusedLogRecords: sumOf('otelcol_receiver_refused_log_records'),
    });
  } catch (e) {
    res.status(503).json({
      error: 'Gateway metrics endpoint unreachable',
      details: e.message,
    });
  }
});

// GET app-side export-error scan. When the App→Gateway counters stay at zero
// despite the user applying a snippet, the cause is usually on THEIR side: an
// app collector unable to resolve helix-gateway (DNS / not on the bridge),
// using the wrong protocol (gRPC instead of HTTP), or refused by Helix. We
// peek at recent logs of non-helix containers attached to helix-bridge and
// surface any OTel export errors back to the wizard.
app.get('/api/diagnostics/app-export-errors', async (req, res) => {
  // Lines containing any of these substrings — lower-cased match — are the
  // ones we care about. Keep narrow to avoid false positives from app code
  // that just happens to log the word "error".
  const errorSignals = [
    'no children to pick from',
    'connection refused',
    'no such host',
    'context deadline exceeded',
    'permanent error',
    'exporter failed',
    'exporting failed',
    'failed to send',
    'rpc error',
    'tls handshake',
    'unauthorized',
    'invalid api key',
  ];

  try {
    // Find the helix-bridge network and its connected containers.
    const networks = await docker.listNetworks();
    const bridge = networks.find(n => n.Name === 'helix-bridge');
    if (!bridge) {
      return res.json({ candidates: [], errors: [], note: 'helix-bridge network not present yet' });
    }

    const net = await docker.getNetwork(bridge.Id).inspect();
    const candidates = Object.values(net.Containers || {})
      .map((c) => c.Name)
      .filter((name) => name && !name.startsWith('helix-')); // skip our own gateway/configurator

    const errors = [];
    for (const name of candidates) {
      try {
        const container = docker.getContainer(name);
        const buf = await container.logs({
          stdout: true,
          stderr: true,
          follow: false,
          tail: 200,
          timestamps: false,
        });
        const text = demuxLogBuffer(buf);
        const matches = text
          .split('\n')
          .filter(l => {
            const lower = l.toLowerCase();
            return errorSignals.some(sig => lower.includes(sig));
          })
          .slice(-5); // most recent 5 matching lines per container
        if (matches.length) errors.push({ container: name, lines: matches });
      } catch { /* container unreadable, skip */ }
    }

    res.json({ candidates, errors });
  } catch (e) {
    res.status(500).json({ error: 'Failed to scan app logs', details: e.message });
  }
});

// GET stream logs from docker with optional container targeting and prefixing
app.get('/api/diagnostics/logs/stream', async (req, res) => {
  const { container } = req.query;
  if (container && !isValidContainerName(container)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  const targetContainer = container || process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  const prefix = container ? `[${container}] ` : '[gateway] ';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let logStream;
  try {
    const targetCtr = docker.getContainer(targetContainer);
    logStream = await targetCtr.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
    });

    // Wrap so the shutdown handler can kill it like a ChildProcess
    const wrapped = { kill: () => { try { logStream.destroy(); } catch (e) { /* ignore */ } } };
    activeLogProcesses.add(wrapped);

    const sendData = (data) => {
      const lines = data.toString('utf8').split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          let outputLine = line;
          const lowerLine = line.toLowerCase();
          if (
            lowerLine.includes('sending queue is full') ||
            lowerLine.includes('exporting failed') ||
            lowerLine.includes('connection refused') ||
            lowerLine.includes('deadline exceeded')
          ) {
            outputLine = '[CRITICAL OTEL DROP] ' + line;
            res.write(`event: diag-alert\ndata: ${JSON.stringify({ message: 'Telemetry Drop Detected' })}\n\n`);
          }
          res.write(`data: ${prefix}${outputLine}\n\n`);
        }
      });
    };

    // Demultiplex the docker frame format into a single PassThrough stream
    const { PassThrough } = require('stream');
    const merged = new PassThrough();
    targetCtr.modem.demuxStream(logStream, merged, merged);
    merged.on('data', sendData);

    logStream.on('end', () => {
      activeLogProcesses.delete(wrapped);
      res.end();
    });
    logStream.on('error', () => {
      activeLogProcesses.delete(wrapped);
      res.end();
    });

    req.on('close', () => {
      activeLogProcesses.delete(wrapped);
      try { logStream.destroy(); } catch (e) { /* ignore */ }
    });
  } catch (e) {
    res.write(`data: [error] Failed to attach to container ${targetContainer}: ${e.message}\n\n`);
    res.end();
  }
});

// GET raw Prometheus metrics output from the gateway (debug aid)
app.get('/api/diagnostics/metrics/raw', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  const url = `http://${targetContainer}:8888/metrics`;
  try {
    const response = await axios.get(url, { timeout: 2000 });
    res.type('text/plain').send(response.data);
  } catch (e) {
    res.status(500).type('text/plain').send(`Failed to fetch metrics from ${url}: ${e.message}`);
  }
});

// GET non-streaming tail of gateway logs (used by Copy Support Bundle)
app.get('/api/diagnostics/logs/recent', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  const tailRaw = parseInt(req.query.tail, 10);
  const tail = Number.isFinite(tailRaw) && tailRaw > 0 && tailRaw <= 200 ? tailRaw : 5;
  try {
    const logs = await containerLogs(targetContainer, { tail });
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch recent logs', details: e.message });
  }
});

// POST start specific container diagnostics
app.post('/api/diagnostics/start', (req, res) => {
  const { containerName } = req.body;
  console.log(`Diagnostic session requested for: ${containerName}`);
  res.json({ status: 'OK', message: `Diagnostics started for ${containerName}` });
});

// POST restart collector
app.post('/api/lifecycle/restart', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    await docker.getContainer(targetContainer).restart();
    res.json({ message: `Container ${targetContainer} restarted successfully` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to restart container', details: e.message });
  }
});

// POST start collector
app.post('/api/lifecycle/start', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    await docker.getContainer(targetContainer).start();
    res.json({ message: `Container ${targetContainer} started successfully` });
  } catch (e) {
    // Already-running is a 304 from the API — treat as success
    if (e.statusCode === 304) return res.json({ message: `Container ${targetContainer} already running` });
    res.status(500).json({ error: 'Failed to start container', details: e.message });
  }
});

// POST stop collector
app.post('/api/lifecycle/stop', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    await docker.getContainer(targetContainer).stop();
    res.json({ message: `Container ${targetContainer} stopped successfully` });
  } catch (e) {
    if (e.statusCode === 304) return res.json({ message: `Container ${targetContainer} already stopped` });
    res.status(500).json({ error: 'Failed to stop container', details: e.message });
  }
});

// GET environment variables
app.get('/api/env', (req, res) => {
  try {
    const envPath = path.join(__dirname, '../.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const vars = {};
    envContent.split('\n').forEach(line => {
      const [key, ...value] = line.split('=');
      if (key && value) {
        vars[key.trim()] = value.join('=').trim();
      }
    });
    
    res.json({
      HELIX_ENDPOINT: vars.HELIX_ENDPOINT || '',
      HELIX_API_KEY: vars.HELIX_API_KEY || '',
      X_SOURCE: vars.X_SOURCE || '',
      APP_URL: vars.APP_URL || '',
      BUSINESS_SERVICE_KEY: vars.BUSINESS_SERVICE_KEY || '',
      HELIX_EVENTS_ENDPOINT: vars.HELIX_EVENTS_ENDPOINT || ''
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read .env file' });
  }
});

// POST update environment variables
app.post('/api/env', (req, res) => {
  const { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE, APP_URL, BUSINESS_SERVICE_KEY, HELIX_EVENTS_ENDPOINT } = req.body;
  try {
    const envPath = path.join(__dirname, '../.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    // Trim values so trailing whitespace from copy/paste doesn't propagate.
    const trim = (v) => (typeof v === 'string' ? v.trim() : '');
    const updates = {
      HELIX_ENDPOINT: trim(HELIX_ENDPOINT),
      HELIX_API_KEY: trim(HELIX_API_KEY),
      X_SOURCE: trim(X_SOURCE),
      APP_URL: trim(APP_URL),
      BUSINESS_SERVICE_KEY: trim(BUSINESS_SERVICE_KEY),
      HELIX_EVENTS_ENDPOINT: trim(HELIX_EVENTS_ENDPOINT),
    };

    let lines = envContent.split('\n');
    Object.keys(updates).forEach(key => {
      let found = false;
      lines = lines.map(line => {
        if (line.startsWith(`${key}=`)) {
          found = true;
          return `${key}=${updates[key]}`;
        }
        return line;
      });
      // Only append when the user actually set a value. Empty values for keys
      // that aren't already in .env stay out of the file rather than creating
      // bare `KEY=` lines that confuse other env loaders.
      if (!found && updates[key]) {
        lines.push(`${key}=${updates[key]}`);
      }
    });

    const newContent = lines.join('\n');
    fs.writeFileSync(envPath, newContent, 'utf8');
    
    // Reload into process.env so subsequent same-process reads see fresh
    // values. The collector container picks up the new values from .env via
    // docker-compose's env_file mapping on the next restart; the caller is
    // expected to follow this POST with /api/lifecycle/restart.
    process.env.HELIX_ENDPOINT = HELIX_ENDPOINT;
    process.env.HELIX_API_KEY = HELIX_API_KEY;
    process.env.X_SOURCE = X_SOURCE;
    process.env.APP_URL = APP_URL;
    process.env.BUSINESS_SERVICE_KEY = BUSINESS_SERVICE_KEY || '';
    process.env.HELIX_EVENTS_ENDPOINT = HELIX_EVENTS_ENDPOINT || '';

    // Intentionally NOT rewriting helix-otel-collector.yaml here. The shipped
    // YAML references ${env:HELIX_ENDPOINT} / ${env:HELIX_API_KEY} /
    // ${env:X_SOURCE}, so the collector substitutes these from its own
    // environment at startup. Inlining the literal values into the YAML
    // (previous behavior) leaked the API key onto disk in a committed file
    // and made `${env:...}` substitution stop working for subsequent edits.

    res.json({ message: 'Environment variables updated and reloaded' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update .env file' });
  }
});

// GET network diagnostics
app.get('/api/diagnostics/network', async (req, res) => {
  try {
    const envPath = path.join(__dirname, '../.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const vars = {};
    envContent.split('\n').forEach(line => {
      const [key, ...value] = line.split('=');
      if (key && value) vars[key.trim()] = value.join('=').trim();
    });

    const endpoint = vars.HELIX_ENDPOINT;
    if (!endpoint) throw new Error('HELIX_ENDPOINT not configured');
    
    const startTime = Date.now();
    await axios.get(endpoint, { timeout: 5000 }).catch(err => {
        // OTLP endpoints might return 405 or 404 on GET, which is still "reachable"
        if (err.response) return err.response;
        throw err;
    });
    
    res.json({ 
        status: 'Success', 
        latency: `${Date.now() - startTime}ms`,
        endpoint 
    });
  } catch (e) {
    res.status(500).json({ 
      status: 'Failed', 
      error: e.message,
      remediation: 'Endpoint unreachable. Verify the HELIX_ENDPOINT includes https:// and check your outbound firewall rules.'
    });
  }
});

// GET telemetry diagnostics
app.get('/api/diagnostics/telemetry', async (req, res) => {
  try {
    const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
    // Query collector's own metrics if available
    const response = await axios.get(`http://${targetContainer}:8888/metrics`);
    // Simple check if metrics are being exposed
    if (response.data.includes('otelcol_exporter_sent_spans')) {
        res.json({ status: 'Healthy', details: 'Collector is emitting spans' });
    } else {
        res.json({ status: 'Warning', details: 'Collector is running but no spans sent yet' });
    }
  } catch (e) {
    res.status(500).json({ status: 'Disconnected', error: 'Could not reach collector metrics endpoint' });
  }
});

// GET discovered services (base tokens for links)
app.get('/api/services', (req, res) => {
    try {
        res.json({
          debugId: `VERSION_${VERSION}_CLEAN`,
          baseUrl: (process.env.HELIX_ENDPOINT || '').replace(/\/$/, ''),
          tenantId: (process.env.HELIX_API_KEY || '').split('::')[0] || '',
          source: process.env.X_SOURCE || '',
          businessServiceKey: process.env.BUSINESS_SERVICE_KEY || ''
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate base tokens' });
    }
});

// Convert dockerode listContainers output to our { id, name, image, networks } shape
const mapContainer = (c) => {
  const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
  const networks = Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {}).join(',');
  return { id: c.Id, name, image: c.Image, networks };
};

// GET all local containers for auto-attach
app.get('/api/containers', async (req, res) => {
  try {
    const list = await docker.listContainers();
    const containers = list
      .map(mapContainer)
      .filter(c => !c.name.includes('helix') && !c.name.includes('configurator'));
    res.json(containers);
  } catch (e) {
    res.status(500).json({ error: 'Failed to list containers', details: e.message });
  }
});

// GET all local containers including infrastructure
app.get('/api/containers/full', async (req, res) => {
  try {
    const list = await docker.listContainers();
    const containers = list
      .map(mapContainer)
      .filter(c => !c.name.includes('configurator')); // Only exclude the UI itself
    res.json(containers);
  } catch (e) {
    res.status(500).json({ error: 'Failed to list containers', details: e.message });
  }
});

// GET inspect a container for instrumentation detection. The wizard uses this
// on Step 2 to pick the right path:
//   - hasOtelEnv:        the app uses OTEL_EXPORTER_OTLP_* env vars (SDK auto-instrument)
//   - hasCollectorConfig: a *.yaml mount looks like an OTel Collector config
//                        (has both `receivers:` and `service:` sections)
// When exactly one is true, Step 2 hides the tab picker and shows only that
// path. When both / neither are true, the user gets the picker.
app.get('/api/containers/inspect/:name', async (req, res) => {
  const { name } = req.params;
  if (!isValidContainerName(name)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  try {
    const info = await docker.getContainer(name).inspect();
    const env = (info.Config && info.Config.Env) || [];
    const otelVars = env.filter(e => e.startsWith('OTEL_'));
    const hasEndpoint = otelVars.some(e => e.startsWith('OTEL_EXPORTER_OTLP_ENDPOINT='));

    // Look for a likely collector config among the bind mounts. We check the
    // host-side path because the container path might be anything (e.g.,
    // /etc/otelcol-contrib/config.yaml). The signal is structural: a YAML
    // containing both `receivers:` and `service:` at column 0 is almost
    // certainly an OTel Collector config.
    let collectorConfigPath = null;
    let hasCollectorConfig = false;
    const mounts = info.Mounts || [];
    for (const m of mounts) {
      if (m.Type !== 'bind' || !m.Source) continue;
      if (!/\.ya?ml$/i.test(m.Source)) continue;
      try {
        const content = fs.readFileSync(m.Source, 'utf8');
        if (/^receivers:/m.test(content) && /^service:/m.test(content)) {
          collectorConfigPath = m.Source;
          hasCollectorConfig = true;
          break;
        }
      } catch { /* unreadable mount, skip */ }
    }

    res.json({
      name,
      hasOtelEnv: otelVars.length > 0,
      hasEndpoint,
      otelVars: otelVars.map(e => e.split('=')[0]), // names only — values may contain secrets
      hasCollectorConfig,
      collectorConfigPath,
    });
  } catch (e) {
    res.status(404).json({ error: 'Container not found', details: e.message });
  }
});

// POST attach container to helix-bridge
app.post('/api/containers/attach', async (req, res) => {
  const { containerName } = req.body;
  if (!isValidContainerName(containerName)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  try {
    await docker.getNetwork('helix-bridge').connect({ Container: containerName });
    res.json({ message: `Container ${containerName} attached to helix-bridge` });
  } catch (e) {
    // 403 from the API means already connected — treat as success
    if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
      return res.json({ message: `Container ${containerName} already attached to helix-bridge` });
    }
    res.status(500).json({ error: 'Failed to attach container', details: e.message });
  }
});

// POST disconnect container from helix-bridge
app.post('/api/containers/disconnect', async (req, res) => {
  const { containerName } = req.body;
  if (!isValidContainerName(containerName)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  try {
    await docker.getNetwork('helix-bridge').disconnect({ Container: containerName });
    res.json({ message: `Container ${containerName} disconnected from helix-bridge` });
  } catch (e) {
    if (/not connected/i.test(e.message || '')) {
      return res.json({ message: `Container ${containerName} was not connected` });
    }
    res.status(500).json({ error: 'Failed to disconnect container', details: e.message });
  }
});

// POST bridge sidecar to target application network
app.post('/api/lifecycle/bridge', async (req, res) => {
  const { APP_URL } = req.body;
  const sidecarName = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

  // APP_URL is optional. If the user didn't provide one, ensure the bridge
  // network exists but skip the auto-attach — they can use Discovered Services
  // to attach a container manually later.
  if (!APP_URL || !APP_URL.trim()) {
    try {
      await docker.createNetwork({ Name: 'helix-bridge' });
    } catch (e) { if (e.statusCode !== 409) console.warn('Network create warning:', e.message); }
    return res.json({ skipped: true, reason: 'No APP_URL provided — attach a container manually from Discovered Services.' });
  }

  // Ensure the shared network exists (idempotent)
  try {
    await docker.createNetwork({ Name: 'helix-bridge' });
  } catch (e) {
    // 409 means it already exists — fine
    if (e.statusCode !== 409) {
      // Other errors: log but don't fail; the network may already be in use
      console.warn('Network create warning:', e.message);
    }
  }

  // Derive target hostname from APP_URL. localhost / 127.0.0.1 / IPs can't be
  // resolved to a container, so treat them as "skipped" rather than failed —
  // the user keeps APP_URL for the dashboard deep-link, and uses the Step 2
  // network controls to attach helix-gateway instead.
  let parsedHost = '';
  try { parsedHost = new URL(APP_URL).hostname || ''; } catch { /* ignore */ }
  const looksLikeIp = /^[\d.]+$/.test(parsedHost);
  const isLoopback = parsedHost === 'localhost' || parsedHost === '127.0.0.1' || parsedHost === '::1';
  if (!parsedHost || isLoopback || looksLikeIp) {
    return res.json({
      skipped: true,
      reason: isLoopback
        ? `APP_URL "${APP_URL}" points at the host (not a Docker container) — auto-bridge can't infer a network from it.`
        : `APP_URL "${APP_URL}" is not a Docker container hostname — auto-bridge skipped.`,
    });
  }
  const targetHost = /^[a-zA-Z0-9.-]+$/.test(parsedHost) ? parsedHost : '';

  // Find a container whose name matches the target hostname.
  let containers;
  try {
    containers = await docker.listContainers();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to list containers', details: e.message });
  }

  const target = targetHost
    ? containers.find(c => {
        const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
        return name.includes(targetHost);
      })
    : null;

  if (!target) {
    return res.status(404).json({ error: `No running container matches hostname "${targetHost}"` });
  }
  const targetName = (target.Names && target.Names[0] && target.Names[0].replace(/^\//, '')) || '';

  // Pick the most specific user network. Object.keys is non-deterministic across
  // Docker daemon versions, so explicitly skip system networks and prefer a
  // user-defined bridge (which is what compose creates).
  const targetNetworks = Object.keys((target.NetworkSettings && target.NetworkSettings.Networks) || {});
  const SYSTEM_NETWORKS = new Set(['host', 'none', 'ingress', 'helix-bridge']);
  const candidates = targetNetworks.filter(n => !SYSTEM_NETWORKS.has(n));
  if (candidates.length === 0) {
    return res.status(500).json({
      error: 'Target container has no user network to bridge to',
      details: `Available: ${targetNetworks.join(', ') || '(none)'}`,
    });
  }

  // Inspect each candidate; prefer driver=bridge, then by name length (more
  // specific wins over a generic "default" network).
  const inspected = await Promise.all(candidates.map(async name => {
    try {
      const info = await docker.getNetwork(name).inspect();
      return { name, driver: info.Driver || '' };
    } catch { return { name, driver: '' }; }
  }));
  inspected.sort((a, b) => {
    if (a.driver === 'bridge' && b.driver !== 'bridge') return -1;
    if (b.driver === 'bridge' && a.driver !== 'bridge') return 1;
    return b.name.length - a.name.length;
  });
  const picked = inspected[0].name;

  try {
    await docker.getNetwork(picked).connect({ Container: sidecarName });
    res.json({
      message: `Successfully bridged ${sidecarName} to network: ${picked}`,
      network: picked,
      candidates: inspected.map(i => i.name),
      targetContainer: targetName,
    });
  } catch (e) {
    if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
      return res.json({
        message: `${sidecarName} already attached to ${picked}`,
        network: picked,
        candidates: inspected.map(i => i.name),
        targetContainer: targetName,
      });
    }
    res.status(500).json({ error: 'Failed to bridge networks', details: e.message });
  }
});

// POST attach the sidecar to an arbitrary Docker network by name. Used by
// the "Detected collectors" widget in Step 2 — one click to make
// helix-gateway reachable from a collector that lives on a different
// compose network. Idempotent; 403/"already exists" returns success.
app.post('/api/lifecycle/bridge-network', async (req, res) => {
  const { network } = req.body || {};
  const sidecarName = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  if (!network || typeof network !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(network)) {
    return res.status(400).json({ error: 'Invalid network name' });
  }
  if (['host', 'none', 'ingress', 'helix-bridge'].includes(network)) {
    return res.status(400).json({ error: `Refusing to bridge to system network "${network}"` });
  }
  try {
    await docker.getNetwork(network).connect({ Container: sidecarName });
    res.json({ message: `Attached ${sidecarName} to ${network}`, network });
  } catch (e) {
    if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
      return res.json({ message: `${sidecarName} already attached to ${network}`, network });
    }
    if (e.statusCode === 404) {
      return res.status(404).json({ error: `Network "${network}" not found` });
    }
    res.status(500).json({ error: 'Failed to attach network', details: e.message });
  }
});

// --- Smart-add: read/write the customer's collector config ---------------
//
// Powers the "Apply automatically" path on Step 2 of the wizard. We read the
// customer's collector YAML out of its container, propose a merge that wires
// helix-gateway in as an exporter on every existing pipeline, and (on
// confirm) write it back with a .helix-bak. The customer's collector then
// restarts to pick up the change.
//
// POC scope: targets the *first* --config= path discovered in the
// container's command line. Doesn't merge across multiple --config= overlays.
// dump() loses YAML comments — the original is preserved as a backup.

const readFileFromContainer = (container, filePath) => new Promise(async (resolve, reject) => {
  try {
    const archiveStream = await container.getArchive({ path: filePath });
    const extract = tarStream.extract();
    let content = '';
    extract.on('entry', (header, stream, next) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        content = Buffer.concat(chunks).toString('utf8');
        next();
      });
      stream.resume();
    });
    extract.on('finish', () => resolve(content));
    extract.on('error', reject);
    archiveStream.pipe(extract);
  } catch (e) { reject(e); }
});

const writeFileToContainer = async (container, filePath, content) => {
  const dir = path.posix.dirname(filePath);
  const fileName = path.posix.basename(filePath);
  const pack = tarStream.pack();
  pack.entry({ name: fileName, mode: 0o644 }, content);
  pack.finalize();
  await container.putArchive(pack, { path: dir });
};

// Write `content` to `hostFilePath` (a host-side path) by spawning a
// transient busybox container that bind-mounts the host directory and runs
// `cat > /target/<basename>`. Needed because putArchive on the original
// container goes through tar-extract, which calls `unlink` on existing
// entries — and bind-mounted files inside a container cannot be unlinked
// from inside the container. Writing via `cat >` uses O_WRONLY|O_TRUNC, which
// works against bind mounts.
const writeFileViaBusyboxSidecar = async (hostFilePath, content) => {
  if (typeof hostFilePath !== 'string' || !hostFilePath.startsWith('/')) {
    throw new Error(`writeFileViaBusyboxSidecar: hostFilePath must be an absolute path, got ${JSON.stringify(hostFilePath)}`);
  }
  const hostDir = path.posix.dirname(hostFilePath);
  const baseName = path.posix.basename(hostFilePath);
  if (!hostDir.startsWith('/') || !baseName) {
    throw new Error(`writeFileViaBusyboxSidecar: could not derive a bind mount from ${hostFilePath} (dir=${hostDir}, base=${baseName})`);
  }
  // Pull busybox if not cached locally. Subsequent calls are no-ops.
  try {
    await docker.getImage('busybox:latest').inspect();
  } catch {
    await new Promise((resolve, reject) => {
      docker.pull('busybox:latest', (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
      });
    });
  }
  const quoted = baseName.replace(/'/g, `'\\''`);
  const container = await docker.createContainer({
    Image: 'busybox:latest',
    Cmd: ['sh', '-c', `cat > '/target/${quoted}'`],
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    Tty: false,
    HostConfig: { Binds: [`${hostDir}:/target`] },
  });
  try {
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });
    await container.start();
    stream.end(content);
    const result = await container.wait();
    if (result.StatusCode !== 0) {
      throw new Error(`busybox sidecar write exited with code ${result.StatusCode}`);
    }
  } finally {
    try { await container.remove({ force: true }); } catch { /* may already be gone */ }
  }
};

const detectCollectorConfigPath = (inspect) => {
  const cmd = (inspect.Config && inspect.Config.Cmd) || [];
  const args = inspect.Args || [];
  const all = [...cmd, ...args];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--config=')) {
      return a.substring('--config='.length).replace(/^file:/, '');
    }
    if (a === '--config' && i + 1 < all.length) {
      return String(all[i + 1]).replace(/^file:/, '');
    }
  }
  return '/etc/otelcol-contrib/config.yaml';
};

// Walk the container's Mounts to find the host-side source for an
// in-container path. Returns the host path if the file (or one of its
// ancestor dirs) is bind-mounted from the host, otherwise null. Picks the
// most specific (deepest) matching destination so a file-level mount wins
// over a directory-level one.
const resolveHostMountPath = (inspect, inContainerPath) => {
  const mounts = (inspect && inspect.Mounts) || [];
  let best = null;
  for (const m of mounts) {
    if (m.Type !== 'bind' || !m.Source || !m.Destination) continue;
    const dest = m.Destination;
    if (inContainerPath === dest) {
      if (!best || dest.length >= best.dest.length) best = { dest, source: m.Source, rel: '' };
      continue;
    }
    const destWithSlash = dest.endsWith('/') ? dest : dest + '/';
    if (inContainerPath.startsWith(destWithSlash)) {
      const rel = inContainerPath.substring(destWithSlash.length);
      if (!best || dest.length > best.dest.length) best = { dest, source: m.Source, rel };
    }
  }
  if (!best) return null;
  return best.rel ? path.posix.join(best.source, best.rel) : best.source;
};

// Indent helpers used by the text-level patcher below.
const indentOf = (line) => {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
};
const isStructural = (line) => !(/^\s*$/.test(line) || /^\s*#/.test(line));
const escapeRe = (s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');

// Find the line index of `key` at exact column 0. Returns -1 if not found.
const findRootKey = (lines, key) => {
  const re = new RegExp(`^${escapeRe(key)}\\s*:`);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
};

// Find a child key `key` directly under the block headed at `parentIdx`
// (parent is at indent `parentCol`). Children are the first structural lines
// after parentIdx whose indent is consistent and strictly greater than parent.
const findChildKey = (lines, parentIdx, parentCol, key) => {
  let childCol = -1;
  for (let i = parentIdx + 1; i < lines.length; i++) {
    if (!isStructural(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind <= parentCol) break;
    if (childCol < 0) childCol = ind;
    if (ind !== childCol) continue;
    if (new RegExp(`^ {${childCol}}${escapeRe(key)}\\s*:`).test(lines[i])) return i;
  }
  return -1;
};

// First structural line index past blockHeader at indent ≤ parentCol, or EOF.
const findBlockEnd = (lines, parentIdx, parentCol) => {
  for (let i = parentIdx + 1; i < lines.length; i++) {
    if (!isStructural(lines[i])) continue;
    if (indentOf(lines[i]) <= parentCol) return i;
  }
  return lines.length;
};

// Patch the original YAML text to (a) append the new exporter under the root
// `exporters:` block and (b) wire it into the named pipelines' exporters
// lists. Preserves comments, quote styles, flow-vs-block sequence style, and
// blank lines because the edit is done at the text level, not via load/dump.
// Throws when the structure isn't supported (multi-doc, missing exporters
// section, multi-line flow lists, etc.) so callers can fall back gracefully.
const patchCollectorYaml = (text, plan) => {
  const lines = text.split('\n');
  const { exporterName, addedToPipelines } = plan;

  // --- 1. Wire exporterName into each named pipeline's `exporters:` list.
  const serviceIdx = findRootKey(lines, 'service');
  if (serviceIdx < 0) throw new Error('No `service:` section found');
  const serviceCol = 0;
  const pipelinesIdx = findChildKey(lines, serviceIdx, serviceCol, 'pipelines');
  if (pipelinesIdx < 0) throw new Error('No `service.pipelines:` section found');
  const pipelinesCol = indentOf(lines[pipelinesIdx]);

  // Pipelines are processed back-to-front so earlier insertions don't shift
  // later lookups out from under us.
  const pipelinesByLine = addedToPipelines
    .map((pname) => ({ pname, line: findChildKey(lines, pipelinesIdx, pipelinesCol, pname) }))
    .filter((p) => p.line >= 0)
    .sort((a, b) => b.line - a.line);

  for (const { pname, line: pIdx } of pipelinesByLine) {
    const pCol = indentOf(lines[pIdx]);
    const expIdx = findChildKey(lines, pIdx, pCol, 'exporters');
    if (expIdx < 0) throw new Error(`Pipeline "${pname}" has no exporters key`);
    const expLine = lines[expIdx];

    // Flow style: `exporters: [a, b, c]` on one line.
    const flow = expLine.match(/^(\s*exporters\s*:\s*)\[(.*)\](\s*(?:#.*)?)$/);
    if (flow) {
      const [, prefix, inside, suffix] = flow;
      const trimmed = inside.trim();
      const next = trimmed ? `${trimmed}, ${exporterName}` : exporterName;
      lines[expIdx] = `${prefix}[${next}]${suffix}`;
      continue;
    }
    // Multi-line flow (`exporters: [\n  a,\n  b\n]`) — not supported.
    if (/^\s*exporters\s*:\s*\[\s*(?:#.*)?$/.test(expLine)) {
      throw new Error(`Pipeline "${pname}" uses multi-line flow exporters — not supported`);
    }

    // Block style. Find the first list child (`- item`); append after the last
    // structural child of the block.
    const expCol = indentOf(expLine);
    let firstChild = -1;
    for (let i = expIdx + 1; i < lines.length; i++) {
      if (!isStructural(lines[i])) continue;
      if (indentOf(lines[i]) <= expCol) break;
      firstChild = i; break;
    }
    if (firstChild < 0) {
      lines.splice(expIdx + 1, 0, `${' '.repeat(expCol + 2)}- ${exporterName}`);
      continue;
    }
    const childCol = indentOf(lines[firstChild]);
    const blockEnd = findBlockEnd(lines, expIdx, expCol);
    let lastStructural = blockEnd - 1;
    while (lastStructural > expIdx && !isStructural(lines[lastStructural])) lastStructural--;
    lines.splice(lastStructural + 1, 0, `${' '.repeat(childCol)}- ${exporterName}`);
  }

  // --- 2. Append the new exporter definition under root `exporters:`.
  const exportersIdx = findRootKey(lines, 'exporters');
  if (exportersIdx < 0) throw new Error('No root `exporters:` section found');
  const exportersBlockEnd = findBlockEnd(lines, exportersIdx, 0);
  // Find child indent — default to 2 if the block is empty.
  let childCol = 2;
  for (let i = exportersIdx + 1; i < exportersBlockEnd; i++) {
    if (!isStructural(lines[i])) continue;
    childCol = indentOf(lines[i]);
    break;
  }
  const ci = ' '.repeat(childCol);
  const ci2 = ' '.repeat(childCol + 2);
  const ci3 = ' '.repeat(childCol + 4);
  const newBlock = [
    `${ci}${exporterName}:`,
    `${ci2}endpoint: http://helix-gateway:4318`,
    `${ci2}tls:`,
    `${ci3}insecure: true`,
  ];
  // Insert after the last structural line inside the exporters block (so we
  // don't push it past a trailing comment that belongs to the next section).
  let insertAfter = exportersBlockEnd - 1;
  while (insertAfter > exportersIdx && !isStructural(lines[insertAfter])) insertAfter--;
  lines.splice(insertAfter + 1, 0, ...newBlock);

  return lines.join('\n');
};

const proposeCollectorMerge = (yamlText) => {
  const parsed = yaml.load(yamlText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Could not parse collector YAML');
  }
  const exporters = parsed.exporters || {};

  // Already pointing at helix-gateway:4318? Skip.
  for (const [name, def] of Object.entries(exporters)) {
    if (def && typeof def === 'object' && /helix-gateway:4318/.test(def.endpoint || '')) {
      return { alreadyConfigured: true, existingExporterName: name };
    }
  }

  // Pick a non-colliding exporter name. Common case: customer has no
  // helix_sidecar exporter, so we land on the canonical name.
  const baseName = 'otlphttp/helix_sidecar';
  let exporterName = baseName;
  let n = 2;
  while (exporters[exporterName]) {
    exporterName = `${baseName}_${n++}`;
  }

  // Plan: which pipelines need the new exporter wired in. Computed off the
  // parsed object; the actual text edits happen via patchCollectorYaml below.
  const pipelines = (parsed.service && parsed.service.pipelines) || {};
  const addedToPipelines = [];
  for (const [pname, pipeline] of Object.entries(pipelines)) {
    if (!pipeline || typeof pipeline !== 'object') continue;
    const existing = Array.isArray(pipeline.exporters) ? pipeline.exporters : [];
    if (!existing.includes(exporterName)) addedToPipelines.push(pname);
  }

  const proposedYaml = patchCollectorYaml(yamlText, { exporterName, addedToPipelines });
  return {
    alreadyConfigured: false,
    exporterName,
    addedToPipelines,
    existingExporters: Object.keys(exporters),
    existingPipelines: Object.keys(pipelines),
    proposedYaml,
  };
};

const isRecognizedCollectorContainer = async (name) => {
  const containers = await docker.listContainers();
  return containers.some(c => {
    const cName = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
    if (cName !== name) return false;
    const image = c.Image || '';
    const command = c.Command || '';
    return /opentelemetry-collector/i.test(image) || /otelcol/i.test(image) || /otelcol/i.test(command);
  });
};

// GET — read the collector's config, return the proposed merge. No side effects.
app.get('/api/discovery/collector-config/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  if (!(await isRecognizedCollectorContainer(name))) {
    return res.status(403).json({ error: `Container "${name}" is not a recognized OTel collector` });
  }
  try {
    const container = docker.getContainer(name);
    const inspect = await container.inspect();
    const configPath = detectCollectorConfigPath(inspect);
    const hostConfigPath = resolveHostMountPath(inspect, configPath);
    const configText = await readFileFromContainer(container, configPath);
    const proposal = proposeCollectorMerge(configText);
    res.json({ name, configPath, hostConfigPath, configText, ...proposal });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read collector config', details: e.message });
  }
});

// POST — apply the merge: write a .helix-bak, write the new config, restart.
app.post('/api/discovery/collector-apply/:name', async (req, res) => {
  const name = req.params.name;
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  if (!(await isRecognizedCollectorContainer(name))) {
    return res.status(403).json({ error: `Container "${name}" is not a recognized OTel collector` });
  }
  try {
    const container = docker.getContainer(name);
    const inspect = await container.inspect();
    const configPath = detectCollectorConfigPath(inspect);
    const hostConfigPath = resolveHostMountPath(inspect, configPath);
    console.log(`[smart-add] apply on ${name}: configPath=${configPath}, hostConfigPath=${hostConfigPath || '<image-baked>'}`);
    const configText = await readFileFromContainer(container, configPath);
    const proposal = proposeCollectorMerge(configText);
    if (proposal.alreadyConfigured) {
      console.log(`[smart-add] apply on ${name}: already configured via ${proposal.existingExporterName}, no-op`);
      return res.json({
        success: true,
        alreadyConfigured: true,
        existingExporterName: proposal.existingExporterName,
        configPath,
      });
    }
    const backupPath = `${configPath}.helix-bak`;
    if (hostConfigPath && hostConfigPath.startsWith('/')) {
      // Bind-mounted config: write via busybox sidecar mounting the host
      // directory, so we don't trigger an unlink on the in-container path.
      console.log(`[smart-add] apply on ${name}: writing via busybox sidecar (bind-mounted at ${hostConfigPath})`);
      await writeFileViaBusyboxSidecar(`${hostConfigPath}.helix-bak`, configText);
      await writeFileViaBusyboxSidecar(hostConfigPath, proposal.proposedYaml);
    } else {
      // Image-baked config (no host bind-mount): putArchive writes into the
      // container's writable overlay and works as-is.
      console.log(`[smart-add] apply on ${name}: writing via putArchive (no resolvable host path)`);
      await writeFileToContainer(container, backupPath, configText);
      await writeFileToContainer(container, configPath, proposal.proposedYaml);
    }
    await container.restart();
    console.log(`[smart-add] apply on ${name}: applied ${proposal.exporterName} into ${proposal.addedToPipelines.join(', ')}; container restarted`);
    res.json({
      success: true,
      configPath,
      backupPath,
      exporterName: proposal.exporterName,
      addedToPipelines: proposal.addedToPipelines,
    });
  } catch (e) {
    console.error(`[smart-add] apply on ${name} failed:`, e);
    res.status(500).json({ error: 'Failed to apply collector config', details: e.message });
  }
});

// POST restart an OTel collector container by name. Used by the "stream
// stalled" affordance on /otel-data when the upstream collector's
// memory_limiter has tripped (common after the OTel demo runs for hours).
// Safety: the target must show up in /api/discovery/collectors — we won't
// restart arbitrary infra by name.
app.post('/api/lifecycle/restart-container', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  try {
    const containers = await docker.listContainers();
    const isCollector = containers.some(c => {
      const cName = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
      if (cName !== name) return false;
      const image = c.Image || '';
      const command = c.Command || '';
      return /opentelemetry-collector/i.test(image) || /otelcol/i.test(image) || /otelcol/i.test(command);
    });
    if (!isCollector) {
      return res.status(403).json({ error: `Container "${name}" is not a recognized OTel collector` });
    }
    await docker.getContainer(name).restart();
    res.json({ message: `Restarted ${name}`, name });
  } catch (e) {
    if (e.statusCode === 404) {
      return res.status(404).json({ error: `Container "${name}" not found` });
    }
    res.status(500).json({ error: 'Failed to restart container', details: e.message });
  }
});

// GET candidate OTel collectors running on this host. Used by Step 2
// onboarding to surface a "we found a collector — here's how to plug it in"
// path, instead of asking the user to choose between YAML and env-var
// instrumentation blind. Heuristic: image name contains opentelemetry-collector
// or otelcol, or the command line invokes otelcol. The sidecar itself
// (helix-gateway) is excluded.
app.get('/api/discovery/collectors', async (req, res) => {
  const sidecarName = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    const containers = await docker.listContainers();
    const sidecarNetworks = await (async () => {
      try {
        const inspected = await docker.getContainer(sidecarName).inspect();
        return Object.keys((inspected.NetworkSettings && inspected.NetworkSettings.Networks) || {});
      } catch { return []; }
    })();
    const sidecarNetSet = new Set(sidecarNetworks);
    const candidates = containers
      .map(c => {
        const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
        const image = c.Image || '';
        const command = c.Command || '';
        return { c, name, image, command };
      })
      .filter(({ name, image, command }) => {
        if (name === sidecarName) return false;
        const looksLikeCollector =
          /opentelemetry-collector/i.test(image) ||
          /otelcol/i.test(image) ||
          /otelcol/i.test(command);
        return looksLikeCollector;
      })
      .map(({ c, name, image }) => {
        const networks = Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {})
          .filter(n => n !== 'host' && n !== 'none' && n !== 'ingress');
        const sharesNetworkWithSidecar = networks.some(n => sidecarNetSet.has(n));
        // K8s containers carry well-known kubelet labels. Detect via labels
        // first (most reliable) then fall back to image / command hints.
        const labels = c.Labels || {};
        const isKubernetes =
          Object.keys(labels).some(k => k.startsWith('io.kubernetes.')) ||
          /\b(kubelet|k8s|kubernetes)\b/i.test(image) ||
          /\b(kubelet|k8s|kubernetes)\b/i.test(c.Command || '');
        return { name, image, networks, sharesNetworkWithSidecar, isKubernetes };
      });
    res.json({ sidecar: sidecarName, sidecarNetworks, collectors: candidates });
  } catch (e) {
    res.status(500).json({ error: 'Failed to scan for collectors', details: e.message });
  }
});

// GET status of the collector container
app.get('/api/lifecycle/status', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    const data = await docker.getContainer(targetContainer).inspect();
    res.json({ status: (data.State && data.State.Status) || 'unknown' });
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
});

// GET detailed collector diagnostics
app.get('/api/diagnostics/collector', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  try {
    // Check 1: Container Status — also surface exit code when not running so a
    // crash-loop is distinguishable from a clean stop.
    const inspectData = await docker.getContainer(targetContainer).inspect();
    const state = (inspectData && inspectData.State) || {};
    const status = state.Status || 'unknown';
    if (status !== 'running') {
      const exitCode = state.ExitCode;
      const errMsg = exitCode !== undefined && exitCode !== 0
        ? `Container ${status} (exit code ${exitCode})`
        : `Container state: ${status}`;
      return res.json({
        status: 'FAIL',
        error: errMsg,
        remediation: exitCode !== 0
          ? 'The sidecar exited with an error. Check logs for the cause and click Restart after fixing.'
          : 'The sidecar container is not in a running state. Review configuration and click "Restart".',
      });
    }

    // Check 2: Configuration/Unmarshal errors in the last 15s
    const since = Math.floor(Date.now() / 1000) - 15;
    const logs = await containerLogs(targetContainer, { since });
    const logOutput = logs.toLowerCase();
    if (logOutput.includes('invalid keys') || logOutput.includes('cannot unmarshal') || logOutput.includes('failed to get config')) {
      const lines = logs.split('\n');
      const errorLine = lines.find(l => l.includes('Error:') || l.includes('error')) || 'Fatal configuration error detected';
      return res.json({
        status: 'FAIL',
        error: errorLine.trim(),
        remediation: 'The collector schema is outdated or malformed. Ensure service.telemetry.metrics uses the "readers" array format.'
      });
    }

    // Check 3: Uptime sanity. A container that just started reports running but
    // hasn't yet had a chance to surface real errors. Only treat as PASS if it
    // has been up at least 5s; otherwise return CHECKING so the UI keeps polling.
    const startedAt = state.StartedAt ? Date.parse(state.StartedAt) : 0;
    const uptimeMs = startedAt ? Date.now() - startedAt : Infinity;
    if (uptimeMs < 5000) {
      return res.json({ status: 'CHECKING', error: 'Collector just started — verifying...' });
    }

    res.json({ status: 'PASS', uptimeSec: Math.floor(uptimeMs / 1000) });
  } catch (e) {
    res.json({
      status: 'FAIL',
      error: `Container state: unknown`,
      remediation: e.message,
    });
  }
});

// GET detailed API key diagnostics
app.get('/api/diagnostics/apikey', async (req, res) => {
  try {
    const envPath = path.join(__dirname, '../.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const vars = {};
    envContent.split('\n').forEach(line => {
      const [key, ...value] = line.split('=');
      if (key && value) vars[key.trim()] = value.join('=').trim();
    });

    const apiKey = vars.HELIX_API_KEY || '';
    const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

    // Step 1: Loose structural check — three non-empty :: separated tokens.
    const keyRegex = /^[^:]+::[^:]+::[^:]+$/;
    if (!keyRegex.test(apiKey)) {
      return res.json({
        status: 'FAIL',
        error: 'Invalid format',
        remediation: 'Must match TenantID::AccessKey::SecretKey'
      });
    }

    // Step 2: Cross-reference logs for authentication failures in the last 15s
    const since = Math.floor(Date.now() / 1000) - 15;
    let logs = '';
    try {
      logs = await containerLogs(targetContainer, { since });
    } catch (e) { /* container may be down — fall through to PASS */ }

    // Word-boundary match so "403" inside timestamps, response sizes, port numbers, etc.
    // doesn't trigger a false rejection.
    const authFailureRe = /\b(unauthenticated|unauthorized|forbidden|401|403)\b/i;
    if (authFailureRe.test(logs)) {
      return res.json({
        status: 'FAIL',
        error: 'Helix rejected credentials',
        remediation: 'Format is valid, but Helix rejected the credentials. Verify the key in the BMC Helix Portal.'
      });
    }

    // Cross-check the failed-exports counter. If exporter is failing without a
    // matching log line in the 15s window, the apikey check would otherwise
    // pass silently while telemetry is being dropped.
    try {
      const failedSignal = await checkExporterFailing(targetContainer);
      if (failedSignal.failing) {
        return res.json({
          status: 'FAIL',
          error: `Exporter is dropping telemetry (${failedSignal.failed} failed, ${failedSignal.sent} sent)`,
          remediation: 'The exporter is failing. Common causes: invalid API key, expired key, or tenant blocking the source IP. Verify the key in the BMC Helix Portal.'
        });
      }
    } catch (e) { /* metrics endpoint unreachable — fall through */ }

    res.json({ status: 'PASS' });
  } catch (e) {
    res.status(500).json({ status: 'FAIL', error: 'Failed to read env for check' });
  }
});

const server = app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
  console.log(`Helix Ingest Endpoint: ${process.env.HELIX_ENDPOINT || 'NOT CONFIGURED'}`);
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — closing log streams and HTTP server...`);
  for (const proc of activeLogProcesses) {
    try { proc.kill(); } catch (e) { /* ignore */ }
  }
  activeLogProcesses.clear();
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // Force-exit after 5s if server.close hangs (open SSE connections etc.)
  setTimeout(() => {
    console.warn('Forced exit after 5s timeout.');
    process.exit(1);
  }, 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
