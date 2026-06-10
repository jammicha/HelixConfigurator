const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const { OtelStore } = require('./otelStore');
const { makeContainerLogs } = require('./util');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

const VERSION = require('./package.json').version;

const docker = new Docker(); // uses /var/run/docker.sock by default
const containerLogs = makeContainerLogs(docker);

const { requireAuth, registerAuthRoutes } = require('./auth');

const { resolvePort } = require('./portConfig');
const port = resolvePort(process.env);
const app = express();

const CONFIG_PATH = path.join(__dirname, '../helix-otel-collector.yaml');
const TEMPLATES_DIR = path.join(__dirname, '../templates');

app.use(cors({ credentials: true }));
// Raw body for OTLP ingest — must come BEFORE express.json() so the stream
// isn't consumed by the JSON parser. Cap at 32MB to absorb large batches.
app.use(['/api/otlp/traces', '/api/otlp/logs', '/api/otlp/metrics'], express.raw({
  type: '*/*',
  limit: '32mb',
}));
app.use(express.json({ limit: '4mb' }));

// Serve static frontend (auth gate is on /api/* only — static assets stay public)
app.use(express.static(path.join(__dirname, '../frontend-dist')));

// SPA fallback for the View OTel Data route.
app.get(/^\/otel-data(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend-dist/index.html'));
});

// SPA fallback for the Step 0 zero-to-OTel onboarding route.
app.get(/^\/step-zero(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend-dist/index.html'));
});

// SPA fallback for the dashboard layout mockup (design review only).
app.get(/^\/dashboard-mockup(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend-dist/index.html'));
});

// Auth endpoints (must register BEFORE the requireAuth middleware so the
// login / logout / status routes themselves are reachable when auth is on).
registerAuthRoutes(app);

// Health endpoint (public — for k8s liveness probes, load balancers, monitoring)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, demoInstall: false });
});

// Update-check endpoint (public — banner works without auth, like /api/health)
require('./routes/version').register(app, { current: VERSION });

// --- OTel trace store (local fan-out from helix-gateway) -----------------
// SQLite lives in a mounted volume so traces survive container restarts.
// Outside Docker we fall back to backend/data so dev is self-contained.
const { resolveDataDir } = require('./statePaths');
const DATA_DIR = resolveDataDir({ appDirExists: fs.existsSync('/app'), backendDir: __dirname });
const OTEL_DB_PATH = process.env.OTEL_DB_PATH || path.join(DATA_DIR, 'otel-store.db');
const otelStore = new OtelStore({ dbPath: OTEL_DB_PATH });
console.log(`OTel trace store: ${OTEL_DB_PATH}`);

require('./routes/otlp').register(app, { otelStore });

// Gate everything else under /api/*
app.use('/api', requireAuth);

require('./routes/traces').register(app, { otelStore, docker });
require('./routes/situations').register(app, { otelStore });
require('./routes/business-service').register(app, { otelStore });
require('./routes/discovery').register(app, { docker });
require('./routes/containers').register(app, { docker });
require('./routes/lifecycle').register(app, { docker, configPath: CONFIG_PATH });
require('./routes/step-zero/synthetic').register(app, { docker });
require('./routes/step-zero/instrument').register(app);
require('./routes/env').register(app);
require('./routes/k8s').register(app, {
  configPath: CONFIG_PATH,
  projectRoot: path.resolve(__dirname, '..'),
});
// One-click self-update (native macOS/Linux installs; others report
// supported:false and the banner shows instructions instead of a button).
require('./routes/update').register(app, { currentVersion: VERSION });

const diagnostics = require('./routes/diagnostics');
diagnostics.register(app, { docker, containerLogs, configPath: CONFIG_PATH, otelStore });

require('./routes/config').register(app, {
  docker,
  containerLogs,
  configPath: CONFIG_PATH,
  templatesDir: TEMPLATES_DIR,
});


const server = app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
  console.log(`Helix Ingest Endpoint: ${process.env.HELIX_ENDPOINT || 'NOT CONFIGURED'}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is in use. Set PORT in .env to a free port and relaunch.\n`);
    process.exit(1);
  }
  throw e;
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — closing log streams and HTTP server...`);
  diagnostics.closeActiveLogProcesses();
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
