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
const { OtelStore } = require('./otelStore');
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

// --- OTel trace store (local fan-out from helix-gateway) -----------------
// SQLite lives in a mounted volume so traces survive container restarts.
// Outside Docker we fall back to backend/data so dev is self-contained.
const OTEL_DB_PATH = process.env.OTEL_DB_PATH ||
  (fs.existsSync('/app') ? '/app/data/otel-store.db' : path.join(__dirname, 'data', 'otel-store.db'));
const otelStore = new OtelStore({ dbPath: OTEL_DB_PATH });
console.log(`OTel trace store: ${OTEL_DB_PATH}`);

require('./routes/otlp').register(app, { otelStore });
// Demo install bundle (public — no auth). Mounted under /api/_demo/aiops/*
// and registered BEFORE the requireAuth middleware so the install one-liner
// works without a session cookie.
//
// IS_DEMO_INSTALL gates the entire demo plumbing. Defaults to on for
// backward compatibility with the in-repo .env and tunneled-demo flows.
// Set IS_DEMO_INSTALL=false in a real-product deployment so the routes
// 404 and the demo namespace is invisible to clients.
const demoInstallEnabled = (process.env.IS_DEMO_INSTALL || 'true').trim().toLowerCase() !== 'false';
if (demoInstallEnabled) {
  require('./routes/demo').register(app, { projectRoot: path.resolve(__dirname, '..') });
}
// --------------------------------------------------------------------------

// Gate everything else under /api/*
app.use('/api', requireAuth);
// --------------------------------------------------------------------------

require('./routes/traces').register(app, { otelStore, docker });
require('./routes/situations').register(app, { otelStore });
require('./routes/discovery').register(app, { docker });
require('./routes/containers').register(app, { docker });
require('./routes/lifecycle').register(app, { docker });


require('./routes/config').register(app, {
  docker,
  containerLogs,
  configPath: CONFIG_PATH,
  templatesDir: TEMPLATES_DIR,
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
// app collector unable to resolve helix-gateway (DNS / wrong network), using
// the wrong protocol (gRPC instead of HTTP), or refused by Helix. We peek at
// recent logs of non-helix containers sharing a network with helix-gateway
// and surface any OTel export errors back to the wizard.
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
    // The customer's collector / app is rarely on helix-bridge itself —
    // the typical bridge flow is "attach helix-gateway to the customer's
    // existing compose network", so the peers worth scanning live on
    // whatever networks helix-gateway is currently a member of. Enumerate
    // those instead of hardcoding helix-bridge.
    const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
    let attachedNetworks = [];
    try {
      const gw = await docker.getContainer(targetContainer).inspect();
      attachedNetworks = Object.keys(gw.NetworkSettings?.Networks ?? {});
    } catch {
      return res.json({ candidates: [], errors: [], note: `${targetContainer} not running` });
    }
    if (attachedNetworks.length === 0) {
      return res.json({ candidates: [], errors: [], note: `${targetContainer} has no networks attached yet` });
    }

    const candidateSet = new Set();
    await Promise.all(attachedNetworks.map(async (netName) => {
      try {
        const net = await docker.getNetwork(netName).inspect();
        for (const c of Object.values(net.Containers || {})) {
          const name = c.Name;
          if (name && !name.startsWith('helix-')) candidateSet.add(name);
        }
      } catch { /* network gone between listing and inspect — skip */ }
    }));
    const candidates = Array.from(candidateSet);

    const errors = (await Promise.all(candidates.map(async (name) => {
      try {
        const buf = await docker.getContainer(name).logs({
          stdout: true,
          stderr: true,
          follow: false,
          tail: 200,
          timestamps: false,
        });
        const matches = demuxLogBuffer(buf)
          .split('\n')
          .filter(l => {
            const lower = l.toLowerCase();
            return errorSignals.some(sig => lower.includes(sig));
          })
          .slice(-5); // most recent 5 matching lines per container
        return matches.length ? { container: name, lines: matches } : null;
      } catch { return null; /* container unreadable, skip */ }
    }))).filter(Boolean);

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


require('./routes/env').register(app);

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
