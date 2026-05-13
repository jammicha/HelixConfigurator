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
    // The customer's collector / app is rarely on helix-bridge itself —
    // the typical bridge flow is "attach helix-gateway to the customer's
    // existing compose network", so the peers worth scanning live on
    // whatever networks helix-gateway is currently a member of. Enumerate
    // those instead of hardcoding helix-bridge.
    const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
    let attachedNetworks = [];
    try {
      const gw = await docker.getContainer(targetContainer).inspect();
      attachedNetworks = Object.keys((gw.NetworkSettings && gw.NetworkSettings.Networks) || {});
    } catch {
      return res.json({ candidates: [], errors: [], note: `${targetContainer} not running` });
    }
    if (attachedNetworks.length === 0) {
      return res.json({ candidates: [], errors: [], note: `${targetContainer} has no networks attached yet` });
    }

    const candidateSet = new Set();
    for (const netName of attachedNetworks) {
      try {
        const net = await docker.getNetwork(netName).inspect();
        for (const c of Object.values(net.Containers || {})) {
          const name = c.Name;
          if (name && !name.startsWith('helix-')) candidateSet.add(name);
        }
      } catch { /* network gone between listing and inspect — skip */ }
    }
    const candidates = Array.from(candidateSet);

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

// Returns an ordered list of candidate in-container paths for the collector
// config. The endpoint tries each until one yields parseable
// receivers:/service: YAML — that's what makes smart-add robust against
// collectors that don't pass --config explicitly, run from a non-default
// image, or use a bind mount at an unusual location.
const detectCollectorConfigPaths = (inspect) => {
  const candidates = [];
  const seen = new Set();
  const add = (p) => {
    if (typeof p !== 'string' || !p) return;
    const clean = p.replace(/^file:/, '');
    if (seen.has(clean)) return;
    seen.add(clean);
    candidates.push(clean);
  };

  // 1. Explicit --config flag, anywhere in Cmd/Args.
  const all = [...((inspect.Config && inspect.Config.Cmd) || []), ...(inspect.Args || [])];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--config=')) add(a.substring('--config='.length));
    else if (a === '--config' && i + 1 < all.length) add(String(all[i + 1]));
  }

  // 2. Bind-mounted YAML destinations — these are almost always the config.
  //    Sort by descending length so file-level mounts take precedence over
  //    parent directory mounts (matches resolveHostMountPath's bias).
  const mounts = (inspect.Mounts || []).slice().sort((a, b) => (b.Destination || '').length - (a.Destination || '').length);
  for (const m of mounts) {
    if (m.Type !== 'bind' || !m.Destination) continue;
    if (/\.ya?ml$/i.test(m.Destination)) add(m.Destination);
  }

  // 3. Common defaults across the otel-collector image family. Order: the
  //    contrib image's default first (most common in the wild), then the
  //    upstream non-contrib default, then frequently-seen custom locations.
  add('/etc/otelcol-contrib/config.yaml');
  add('/etc/otelcol/config.yaml');
  add('/etc/otel-collector/config.yaml');
  add('/conf/otel-collector-config.yaml');
  add('/etc/opentelemetry-collector/config.yaml');

  return candidates;
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

// Try each candidate config path in order and return the first one that
// reads AND looks like a collector config (`receivers:` + `service:` at
// column 0). Returns null when none work, plus a structured `attempts` log
// so the endpoint can surface which paths it tried.
const resolveCollectorConfig = async (container, inspect) => {
  const candidates = detectCollectorConfigPaths(inspect);
  const attempts = [];
  for (const candidate of candidates) {
    try {
      const text = await readFileFromContainer(container, candidate);
      // Validate the shape — without this, an unrelated YAML mounted at one
      // of our default paths would be accepted and patched, which would
      // corrupt the container.
      if (/^receivers:/m.test(text) && /^service:/m.test(text)) {
        return { configPath: candidate, configText: text, attempts };
      }
      attempts.push({ path: candidate, reason: 'not a collector config (missing receivers: and/or service:)' });
    } catch (e) {
      attempts.push({ path: candidate, reason: e.message || 'read failed' });
    }
  }
  return { configPath: null, configText: null, attempts };
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
    const { configPath, configText, attempts } = await resolveCollectorConfig(container, inspect);
    if (!configPath) {
      return res.status(404).json({
        error: 'Could not locate a collector config inside the container',
        details: `Tried ${attempts.length} candidate path(s); none returned valid OTel collector YAML. Common reasons: the container reads its config from env (--config=env:...) instead of a file, or the config lives at an unexpected path. Apply the snippet below manually.`,
        attempts,
      });
    }
    const hostConfigPath = resolveHostMountPath(inspect, configPath);
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
    const { configPath, configText, attempts } = await resolveCollectorConfig(container, inspect);
    if (!configPath) {
      console.log(`[smart-add] apply on ${name}: no config found, tried ${attempts.length} paths`);
      return res.status(404).json({
        error: 'Could not locate a collector config inside the container',
        details: 'Apply the snippet below manually.',
        attempts,
      });
    }
    const hostConfigPath = resolveHostMountPath(inspect, configPath);
    console.log(`[smart-add] apply on ${name}: configPath=${configPath}, hostConfigPath=${hostConfigPath || '<image-baked>'}`);
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
