// Step 0 Layer 2 — realistic synthetic scenario generator.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { buildHelixServiceMapLink } = require('./helix-link');
const { generateTrace } = require('./synthetic-scenario');

const DEFAULT_DURATION_S = 60;
const DEFAULT_TRACES_PER_S = 8;
const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
const SELF_BASE = () => `http://localhost:${process.env.PORT || 3001}`;

let activeRun = null;
const __resetForTests = () => { activeRun = null; };

// Public reset: halts any in-flight loop and wipes the run record entirely.
// Called from lifecycle.js's reset-onboarding handler so "Reset onboarding
// and start over" returns Layer 2's panel to the idle pre-run state.
const clearActiveRun = () => {
  if (activeRun) {
    activeRun.stopRequested = true;
    activeRun.running = false;
  }
  activeRun = null;
};

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

const defaultProbeGateway = async () => {
  try {
    await axios.get(`http://${TARGET_CONTAINER()}:4318/`, {
      timeout: 1000, validateStatus: () => true,
    });
    return true;
  } catch { return false; }
};

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

// Real sender: POST traces/logs/metrics to either the gateway (full
// pipeline → Helix + local viewer) or the configurator's own ingest
// endpoint (local fallback). Metrics are silently skipped on the local
// path — the local viewer doesn't have a metrics endpoint today.
const defaultSend = async ({ destination, payload }) => {
  const isGateway = destination === 'gateway';
  const tracesUrl = isGateway
    ? `http://${TARGET_CONTAINER()}:4318/v1/traces`
    : `${SELF_BASE()}/api/otlp/traces`;
  const logsUrl = isGateway
    ? `http://${TARGET_CONTAINER()}:4318/v1/logs`
    : `${SELF_BASE()}/api/otlp/logs`;
  const metricsUrl = isGateway ? `http://${TARGET_CONTAINER()}:4318/v1/metrics` : null;

  const headers = { 'Content-Type': 'application/json' };
  // Best-effort: each signal posts independently. A trace landing without
  // its log is better than nothing landing because logs failed.
  await Promise.allSettled([
    axios.post(tracesUrl, payload.traces, { headers, timeout: 3000 }),
    axios.post(logsUrl, payload.logs, { headers, timeout: 3000 }),
    metricsUrl
      ? axios.post(metricsUrl, payload.metrics, { headers, timeout: 3000 })
      : Promise.resolve(),
  ]);
};

// Async generation loop. Self-rate-limits with setTimeout between iterations
// so it doesn't peg the event loop. Stops on duration, stopRequested, or
// maxIterations (test-only override).
const runLoop = async ({ send, rateHz, maxIterations }) => {
  const intervalMs = Math.max(1, Math.round(1000 / rateHz));
  const ceiling = maxIterations || Infinity;
  let iterations = 0;
  try {
    while (
      activeRun &&
      activeRun.running &&
      !activeRun.stopRequested &&
      iterations < ceiling &&
      (activeRun.continuous || Date.now() < activeRun.expectedEndAt)
    ) {
      try {
        const payload = generateTrace();
        // Count a trace as "with errors" only when the user-visible root
        // span errored. Retry-storm traces (2 failed attempts + 1 success)
        // have intermediate errored spans, but the user ultimately got a
        // successful response — those shouldn't count as user-visible
        // failures. The root span is the one without a parentSpanId.
        const erroredTrace = payload.traces.resourceSpans.some(rs =>
          rs.scopeSpans.some(ss => ss.spans.some(s =>
            !s.parentSpanId && s.status && s.status.code === 2
          ))
        );
        await send({ destination: activeRun.destination, payload });
        activeRun.sentTraces++;
        if (erroredTrace) activeRun.sentWithErrors++;
      } catch (e) {
        // Best-effort: a single failed iteration (bad generate, send failure)
        // shouldn't kill the loop. Counter stays put for this iteration; loop
        // continues until duration, stop, or maxIterations.
      }
      iterations++;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  } finally {
    // Always clear the running flag on exit, even if the loop body throws
    // an unexpected error. Otherwise activeRun.running stays true forever,
    // /status reports stuck, and a new /start gets a 409.
    if (activeRun) activeRun.running = false;
  }
};

function register(app, deps = {}) {
  const probeGateway = deps.probeGateway || defaultProbeGateway;
  const readEnv = deps.readEnv || defaultReadEnv;
  const send = deps.send || defaultSend;
  const rateHz = deps.generationRateHz || DEFAULT_TRACES_PER_S;
  const maxIterations = deps.maxIterations || null;

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

    // Fire-and-forget the loop. The HTTP response has already been sent
    // above; the loop runs to completion or stop independently.
    runLoop({ send, rateHz, maxIterations }).catch(() => { /* loop is self-resilient */ });
  });

  app.post('/api/step-zero/synthetic/stop', async (req, res) => {
    if (!activeRun) {
      return res.status(404).json({ error: 'No active run' });
    }
    const requestedId = req.body && req.body.run_id;
    if (requestedId && requestedId !== activeRun.runId) {
      return res.status(409).json({
        error: 'run_id does not match the active run',
        active_run_id: activeRun.runId,
      });
    }
    activeRun.stopRequested = true;
    activeRun.running = false;
    const elapsed_s = Math.round((Date.now() - activeRun.startedAt) / 1000);
    res.json({
      stopped: true,
      sent_traces: activeRun.sentTraces,
      sent_with_errors: activeRun.sentWithErrors,
      elapsed_s,
    });
  });
}

module.exports = { register, __resetForTests, clearActiveRun };
