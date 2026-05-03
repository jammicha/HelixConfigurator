const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
const crypto = require('crypto');
const Docker = require('dockerode');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const docker = new Docker(); // uses /var/run/docker.sock by default

// Demultiplex docker logs() output when the container isn't TTY-attached.
// Each multiplexed frame is: [streamType:1][padding:3][length:4_BE][payload].
const demuxLogBuffer = (buf) => {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  const out = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) {
      // Not a header — treat the whole buffer as raw text (TTY container)
      return buf.toString('utf8');
    }
    const length = buf.readUInt32BE(offset + 4);
    out.push(buf.slice(offset + 8, offset + 8 + length).toString('utf8'));
    offset += 8 + length;
  }
  if (offset < buf.length) out.push(buf.slice(offset).toString('utf8'));
  return out.join('');
};

const containerLogs = async (containerName, options = {}) => {
  const container = docker.getContainer(containerName);
  const buf = await container.logs({
    stdout: true,
    stderr: true,
    follow: false,
    timestamps: false,
    ...options,
  });
  return demuxLogBuffer(buf);
};

// --- UI auth (shared-password) --------------------------------------------
// If UI_AUTH_PASSWORD is unset, auth is disabled (open access). Set it to enable.
const UI_AUTH_REQUIRED = !!process.env.UI_AUTH_PASSWORD;
const sessions = new Set();

const parseCookies = (req) => {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    out[k] = decodeURIComponent(v.join('='));
  });
  return out;
};

const requireAuth = (req, res, next) => {
  if (!UI_AUTH_REQUIRED) return next();
  // Allow auth endpoints through unauthenticated
  if (
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/status' ||
    req.path === '/api/auth/logout' ||
    req.path === '/api/health'
  ) {
    return next();
  }
  const cookies = parseCookies(req);
  if (cookies.session && sessions.has(cookies.session)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
};
// --------------------------------------------------------------------------

const app = express();
const port = 3001;

const CONFIG_PATH = path.join(__dirname, '../helix-otel-collector.yaml');
const TEMPLATES_DIR = path.join(__dirname, '../templates');

// Reject anything that isn't a valid Docker container name to prevent shell
// injection if a route ever reaches exec/spawn with user-controlled input.
const isValidContainerName = (name) =>
  typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name);

// Track active log streaming subprocesses so we can clean them up on shutdown.
const activeLogProcesses = new Set();

// --- YAML structural validation -------------------------------------------
const TOP_LEVEL_KEYS = ['receivers', 'processors', 'exporters', 'extensions', 'connectors', 'service'];

const levenshtein = (a, b) => {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
};

const closestKey = (key, candidates) => {
  let best = null, bestDist = Infinity;
  candidates.forEach(c => {
    const d = levenshtein(key.toLowerCase(), c.toLowerCase());
    if (d < bestDist && d <= 3) { best = c; bestDist = d; }
  });
  return best;
};

const findLineForKey = (yamlText, key) => {
  const lines = yamlText.split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
};

const validateConfig = (yamlString) => {
  const warnings = [];
  let parsed;
  try { parsed = yaml.load(yamlString); } catch { return warnings; }
  if (!parsed || typeof parsed !== 'object') return warnings;

  // Typos at top level
  Object.keys(parsed).forEach(key => {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      const suggestion = closestKey(key, TOP_LEVEL_KEYS);
      warnings.push({
        line: findLineForKey(yamlString, key),
        message: `Unknown top-level key "${key}"${suggestion ? ` — did you mean "${suggestion}"?` : ''}`,
      });
    }
  });

  const definedReceivers = Object.keys(parsed.receivers || {});
  const definedProcessors = Object.keys(parsed.processors || {});
  const definedExporters = Object.keys(parsed.exporters || {});

  if (definedReceivers.length === 0) {
    warnings.push({ line: 1, message: 'No receivers defined — gateway has no telemetry input' });
  }
  if (definedExporters.length === 0) {
    warnings.push({ line: 1, message: 'No exporters defined — gateway has no telemetry output' });
  }

  if (!parsed.service) {
    warnings.push({ line: 1, message: 'Missing required "service" section' });
  } else if (parsed.service.pipelines) {
    Object.entries(parsed.service.pipelines).forEach(([pipelineName, pipeline]) => {
      const pipelineLine = findLineForKey(yamlString, pipelineName);
      ['receivers', 'processors', 'exporters'].forEach(kind => {
        const refs = (pipeline && pipeline[kind]) || [];
        const defined = kind === 'receivers' ? definedReceivers : kind === 'processors' ? definedProcessors : definedExporters;
        if (refs.length === 0 && kind !== 'processors') {
          warnings.push({ line: pipelineLine, message: `Pipeline "${pipelineName}" has no ${kind} — telemetry won't flow` });
        }
        refs.forEach(ref => {
          if (!defined.includes(ref)) {
            const singular = kind.slice(0, -1);
            const suggestion = closestKey(ref, defined);
            warnings.push({
              line: pipelineLine,
              message: `Pipeline "${pipelineName}" references undefined ${singular} "${ref}"${suggestion ? ` — did you mean "${suggestion}"?` : ''}`,
            });
          }
        });
      });
    });
  }

  return warnings;
};
// --------------------------------------------------------------------------

app.use(cors({ credentials: true }));
app.use(express.json());

// Serve static frontend (auth gate is on /api/* only — static assets stay public)
app.use(express.static(path.join(__dirname, '../frontend-dist')));

// --- Auth endpoints (must register BEFORE the requireAuth middleware) ----
app.get('/api/auth/status', (req, res) => {
  if (!UI_AUTH_REQUIRED) return res.json({ required: false, authenticated: true });
  const cookies = parseCookies(req);
  const authenticated = !!(cookies.session && sessions.has(cookies.session));
  res.json({ required: true, authenticated });
});

app.post('/api/auth/login', (req, res) => {
  if (!UI_AUTH_REQUIRED) return res.json({ ok: true });
  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== process.env.UI_AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomUUID();
  sessions.add(token);
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session) sessions.delete(cookies.session);
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// Health endpoint (public — for k8s liveness probes, load balancers, monitoring)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '1.0.5' });
});

// Gate everything else under /api/*
app.use('/api', requireAuth);
// --------------------------------------------------------------------------

// GET current config
app.get('/api/config', (req, res) => {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    res.json({ yaml: fileContents });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read config file' });
  }
});

// POST update config
app.post('/api/config', (req, res) => {
  const { content } = req.body;
  try {
    // Validate YAML syntax
    yaml.load(content);
    const warnings = validateConfig(content);
    fs.writeFileSync(CONFIG_PATH, content, 'utf8');
    res.json({ message: 'Config updated successfully', warnings });
  } catch (e) {
    if (e.mark) {
      return res.status(400).json({ 
        error: 'Invalid YAML syntax', 
        mark: { 
          line: e.mark.line, 
          column: e.mark.column, 
          message: e.reason 
        } 
      });
    }
    res.status(400).json({ error: 'Invalid YAML syntax', details: e.message });
  }
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

// GET live metrics parsing
app.get('/api/diagnostics/metrics/live', async (req, res) => {
  const targetContainer = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
  const url = `http://${targetContainer}:8888/metrics`;
  
  try {
    const response = await axios.get(url, { timeout: 2000 });
    const metrics = response.data;

    const extractSum = (baseName) => {
      const name = baseName + '_total';
      let sum = 0;
      const lines = metrics.split('\n');

      lines.forEach(line => {
        if (line.startsWith(name)) {
          // Prometheus emits counters as float64 — use parseFloat so values like
          // "1.234e+05" don't get truncated to 1 by parseInt.
          const parts = line.trim().split(/\s+/);
          const val = parseFloat(parts[parts.length - 1]);

          if (!isNaN(val)) {
            // If it's an exporter metric, only count the bmchelix one
            if (baseName.includes('exporter')) {
              if (line.includes('exporter="otlphttp/bmchelix"')) {
                sum += val;
              }
            } else {
              sum += val;
            }
          }
        }
      });
      return Math.round(sum);
    };

    const result = {
      received: extractSum('otelcol_receiver_accepted_spans') + extractSum('otelcol_receiver_accepted_metric_points') + extractSum('otelcol_receiver_accepted_log_records'),
      sent: extractSum('otelcol_exporter_sent_spans') + extractSum('otelcol_exporter_sent_metric_points') + extractSum('otelcol_exporter_sent_log_records'),
      failed: extractSum('otelcol_exporter_send_failed_spans') + extractSum('otelcol_exporter_send_failed_metric_points') + extractSum('otelcol_exporter_send_failed_log_records')
    };
    
    res.json(result);
  } catch (e) {
    console.error(`Failed to fetch metrics from ${url}:`, e.message);
    res.json({ received: 0, sent: 0, failed: 0, error: e.message });
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
      BUSINESS_SERVICE_KEY: vars.BUSINESS_SERVICE_KEY || ''
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read .env file' });
  }
});

// POST update environment variables
app.post('/api/env', (req, res) => {
  const { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE, APP_URL, BUSINESS_SERVICE_KEY } = req.body;
  try {
    const envPath = path.join(__dirname, '../.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    const updates = { HELIX_ENDPOINT, HELIX_API_KEY, X_SOURCE, APP_URL, BUSINESS_SERVICE_KEY };
    
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
      if (!found) {
        lines.push(`${key}=${updates[key]}`);
      }
    });

    const newContent = lines.join('\n');
    fs.writeFileSync(envPath, newContent, 'utf8');
    
    // Reload into process.env
    process.env.HELIX_ENDPOINT = HELIX_ENDPOINT;
    process.env.HELIX_API_KEY = HELIX_API_KEY;
    process.env.X_SOURCE = X_SOURCE;
    process.env.APP_URL = APP_URL;
    process.env.BUSINESS_SERVICE_KEY = BUSINESS_SERVICE_KEY || '';
    
    // Inject YAML settings directly
    try {
      const configContent = fs.readFileSync(CONFIG_PATH, 'utf8');
      const configObj = yaml.load(configContent) || {};
      
      // Ensure basic structure exists
      configObj.exporters = configObj.exporters || {};
      configObj.exporters['otlphttp/bmchelix'] = configObj.exporters['otlphttp/bmchelix'] || {};
      
      // Update exporter endpoint and headers
      configObj.exporters['otlphttp/bmchelix'].endpoint = HELIX_ENDPOINT;
      configObj.exporters['otlphttp/bmchelix'].headers = {
        'X-Api-Key': String(HELIX_API_KEY).trim(),
        'X-Source': String(X_SOURCE).trim()
      };
      configObj.exporters['otlphttp/bmchelix'].sending_queue = { enabled: true };

      // Ensure service telemetry metrics readers format
      configObj.service = configObj.service || {};
      configObj.service.telemetry = configObj.service.telemetry || {};
      configObj.service.telemetry.metrics = {
        readers: [
          {
            pull: {
              exporter: {
                prometheus: {
                  host: '0.0.0.0',
                  port: 8888
                }
              }
            }
          }
        ]
      };

      const newYaml = yaml.dump(configObj, { lineWidth: -1 });
      fs.writeFileSync(CONFIG_PATH, newYaml, 'utf8');
    } catch (yamlErr) {
      console.error('Failed to update YAML settings:', yamlErr.message);
    }
    
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
          debugId: 'VERSION_1.0.5_CLEAN',
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

  // Derive target hostname from APP_URL
  let targetHost = '';
  try {
    const url = new URL(APP_URL);
    const h = url.hostname;
    if (h && h !== 'localhost' && /^[a-zA-Z0-9.-]+$/.test(h)) targetHost = h;
  } catch (e) { /* ignore */ }

  // Find a container that matches either the hostname or "opentelemetry-demo" fallback
  let containers;
  try {
    containers = await docker.listContainers();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to list containers', details: e.message });
  }

  const matchKey = targetHost || 'opentelemetry-demo';
  const target = containers.find(c => {
    const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
    return name.includes(matchKey);
  });

  if (!target) {
    return res.status(404).json({ error: 'Target application container not found' });
  }

  const firstNetwork = Object.keys((target.NetworkSettings && target.NetworkSettings.Networks) || {})[0];
  if (!firstNetwork) {
    return res.status(500).json({ error: 'Target container has no networks' });
  }

  try {
    await docker.getNetwork(firstNetwork).connect({ Container: sidecarName });
    res.json({ message: `Successfully bridged ${sidecarName} to network: ${firstNetwork}` });
  } catch (e) {
    if (e.statusCode === 403 || /already exists/i.test(e.message || '')) {
      return res.json({ message: `${sidecarName} already attached to ${firstNetwork}` });
    }
    res.status(500).json({ error: 'Failed to bridge networks', details: e.message });
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
    // Check 1: Container Status
    const inspectData = await docker.getContainer(targetContainer).inspect();
    const status = (inspectData.State && inspectData.State.Status) || 'unknown';
    if (status !== 'running') {
      return res.json({
        status: 'FAIL',
        error: `Container state: ${status}`,
        remediation: 'The sidecar container is not in a running state. Review configuration and click "Restart".'
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
    res.json({ status: 'PASS' });
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

    const logOutput = logs.toLowerCase();
    if (logOutput.includes('unauthenticated') || logOutput.includes('401') || logOutput.includes('403')) {
      return res.json({
        status: 'FAIL',
        error: 'Helix rejected credentials',
        remediation: 'Format is valid, but Helix rejected the credentials. Verify the key in the BMC Helix Portal.'
      });
    }
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
