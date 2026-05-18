// Step 0 Layer 2 — realistic synthetic scenario generator. Hosts three
// endpoints (/start /stop /status) and the in-process generation loop.
//
// Module-scope state: `activeRun` holds the currently-running or
// last-completed run's metadata. Only ONE run at a time — /start returns
// 409 when activeRun.running is true.

let activeRun = null;

// Reset module state — for tests only.
const __resetForTests = () => { activeRun = null; };

// Snapshot of the public run state, suitable for /status responses.
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

function register(app, _deps) {
  app.get('/api/step-zero/synthetic/status', (req, res) => {
    res.json(snapshot());
  });
}

module.exports = { register, __resetForTests };
