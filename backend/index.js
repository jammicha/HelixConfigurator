const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const { OtelStore } = require('./otelStore');
const { makeContainerLogs, IS_CONTAINERIZED } = require('./util');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

const VERSION = require('./package.json').version;

// Per-process identity. The startup preflight probes our own port on both IP
// stacks and compares this value, which is the only reliable way to tell
// "the port answers and it is us" from "the port answers and it is a stale
// Docker port proxy".
const INSTANCE_ID = require('node:crypto').randomUUID();

const docker = new Docker(); // uses /var/run/docker.sock by default
const containerLogs = makeContainerLogs(docker);

const { requireAuth, registerAuthRoutes } = require('./auth');
const { errorHandler } = require('./errorHandler');
const { classifyPortOwnership, reportPortOwnership } = require('./preflight');

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
  res.json({ ok: true, version: VERSION, demoInstall: false, instanceId: INSTANCE_ID });
});

// Update-check endpoint (public — banner works without auth, like /api/health)
require('./routes/version').register(app, { current: VERSION });

// --- OTel trace store (local fan-out from helix-gateway) -----------------
// SQLite lives in a mounted volume so traces survive container restarts.
// Outside Docker we fall back to backend/data so dev is self-contained.
const { resolveDataDir } = require('./statePaths');
const DATA_DIR = resolveDataDir({ appDirExists: IS_CONTAINERIZED, backendDir: __dirname });
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

// Terminal error handler — MUST be registered after every route. Catches any
// synchronous throw, and (under Express 5) any rejected async handler, that a
// route didn't catch itself, so it returns a JSON 500 instead of leaking a
// stack-trace page or crashing the process on an unhandledRejection.
app.use(errorHandler);

// Bind each address family explicitly. A single app.listen(port) binds `::`
// dual-stack, and when another process already holds the IPv4 wildcard the
// bind silently degrades to IPv6-only with no error at all. That is invisible
// in the browser (localhost resolves to ::1 first) and fatal to the gateway's
// viewer fan-out (host.docker.internal is IPv4). Two explicit listeners turn
// that into a real EADDRINUSE we can see and explain.
const listenOn = (opts) => new Promise((resolve, reject) => {
  const s = app.listen(opts);
  const onError = (e) => { s.removeListener('listening', onListening); reject(e); };
  const onListening = () => {
    s.removeListener('error', onError);
    s.on('error', (e) => console.error(`Listener error on ${opts.host}:${opts.port}:`, e));
    resolve(s);
  };
  s.once('error', onError);
  s.once('listening', onListening);
});

const servers = [];
let ipv4Bound = false;

const start = async () => {
  // IPv6 first, and ipv6Only so it cannot claim the v4 wildcard implicitly.
  try {
    servers.push(await listenOn({ port, host: '::', ipv6Only: true }));
  } catch (e) {
    // A host with no IPv6 at all is fine; we fall through to the v4 bind.
    if (e.code !== 'EADDRINUSE' && e.code !== 'EAFNOSUPPORT' && e.code !== 'EADDRNOTAVAIL') throw e;
  }

  try {
    servers.push(await listenOn({ port, host: '0.0.0.0' }));
    ipv4Bound = true;
  } catch (e) {
    // EADDRINUSE is the expected squatter case; the preflight below explains
    // it. Any other IPv4 bind error is logged and tolerated as long as IPv6
    // is already up — exiting is only correct when neither stack bound.
    if (e.code !== 'EADDRINUSE') {
      if (servers.length === 0) throw e;
      console.error(`IPv4 bind on port ${port} failed:`, e);
    }
  }

  if (servers.length === 0) {
    console.error(`\nPort ${port} is in use. Set PORT in .env to a free port and relaunch.\n`);
    process.exit(1);
  }

  console.log(`Backend listening at http://localhost:${port}`);
  console.log(`Helix Ingest Endpoint: ${process.env.HELIX_ENDPOINT || 'NOT CONFIGURED'}`);

  // Non-fatal, and deliberately after the listening log so the URL is the
  // first thing a user sees. Failures here must never block startup.
  try {
    reportPortOwnership(await classifyPortOwnership({ port, instanceId: INSTANCE_ID, ipv4Bound }));
  } catch (e) {
    console.warn('Port preflight skipped:', e.message);
  }
};

start().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — closing log streams and HTTP server...`);
  diagnostics.closeActiveLogProcesses();
  const toClose = servers.length;
  Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
    .then(() => {
      console.log(toClose > 0 ? 'HTTP server closed.' : 'No listeners were open (signal arrived during startup).');
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
