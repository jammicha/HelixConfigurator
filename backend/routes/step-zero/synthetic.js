// Step 0 Layer 2 — realistic synthetic scenario generator. Hosts three
// endpoints (/start /stop /status) and the in-process generation loop.
//
// Module-scope state: `activeRun` holds the currently-running or
// last-completed run's metadata. Only ONE run at a time — /start returns
// 409 when activeRun.running is true.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { buildHelixServiceMapLink } = require('./helix-link');

const DEFAULT_DURATION_S = 60;
const DEFAULT_TRACES_PER_S = 8;
const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

let activeRun = null;
const __resetForTests = () => { activeRun = null; };

const snapshot = () => {
  if (!activeRun) {
    return { running: false, sent_traces: 0, sent_with_errors: 0 };
  }
  const elapsedMs = Date.now() - activeRun.startedAt;
  const elapsed_s = Math.round(elapsedMs / 1000);
  const eta_s = activeRun.expectedEndAt
    ? Math.max(0, Math.round((activeRun.expectedEndAt - Date.now()) / 1000))
    : null;
  return {
    running: activeRun.running,
    run_id: activeRun.runId,
    sent_traces: activeRun.sentTraces,
    sent_with_errors: activeRun.sentWithErrors,
    elapsed_s,
    eta_s,
    destination: activeRun.destination,
    continuous: activeRun.continuous,
    helix_deep_link: activeRun.helixDeepLink,
    local_deep_link: '/otel-data',
  };
};

// Default gateway-probe: 1s HEAD against :4318/. 4xx-but-reachable counts
// as up. Replaced in tests via DI.
const defaultProbeGateway = async () => {
  try {
    await axios.get(`http://${TARGET_CONTAINER()}:4318/`, {
      timeout: 1000,
      validateStatus: () => true,
    });
    return true;
  } catch { return false; }
};

// Default env reader: parse the .env mounted at /app/.env (matching the
// pattern in diagnostics.js#apikey-probe). Replaced in tests via DI.
const defaultReadEnv = () => {
  const envPath = path.join(__dirname, '../../../.env');
  try {
    const txt = fs.readFileSync(envPath, 'utf8');
    const out = {};
    for (const line of txt.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k && v.length) out[k.trim()] = v.join('=').trim();
    }
    return out;
  } catch { return {}; }
};

// Default sender: stubbed-no-op in this task. The next task replaces
// this with the real OTLP POST sender plus the driving loop.
const defaultSend = async () => { /* no-op stub */ };

function register(app, deps = {}) {
  const probeGateway = deps.probeGateway || defaultProbeGateway;
  const readEnv = deps.readEnv || defaultReadEnv;
  const send = deps.send || defaultSend;

  app.get('/api/step-zero/synthetic/status', (req, res) => {
    res.json(snapshot());
  });

  app.post('/api/step-zero/synthetic/start', async (req, res) => {
    if (activeRun && activeRun.running) {
      return res.status(409).json({
        error: 'A synthetic run is already in progress',
        run_id: activeRun.runId,
      });
    }

    const continuous = !!(req.body && req.body.continuous);
    const env = readEnv();
    const gatewayUp = await probeGateway();
    const useGateway = gatewayUp && !!env.HELIX_ENDPOINT;
    const destination = useGateway ? 'gateway' : 'local';
    const helixDeepLink = useGateway ? buildHelixServiceMapLink(env) : null;

    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    const expectedEndAt = continuous ? null : startedAt + DEFAULT_DURATION_S * 1000;

    activeRun = {
      runId, startedAt, expectedEndAt,
      continuous, destination, helixDeepLink,
      sentTraces: 0, sentWithErrors: 0,
      running: true, stopRequested: false,
    };

    res.json({
      run_id: runId,
      expected_end_at: expectedEndAt,
      destination,
      helix_deep_link: helixDeepLink,
      local_deep_link: '/otel-data',
    });

    // The next task wires the generation loop here, using `send` to POST
    // OTLP payloads at the configured rate.
  });
}

module.exports = { register, __resetForTests };
