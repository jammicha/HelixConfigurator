// Diagnostics surface — the auth-gated read- and write-side of "is the
// gateway healthy and is telemetry actually getting through?" Powers the
// Diagnostic Health Check session on the dashboard plus the wizard's
// Step 2 verifier and Step 4 export-error scan.
//
// Module-scope state: a debugTimer (so the 5-minute "force-revert debug
// logging" timeout can be cleared across requests) and a Set of
// active log SSE consumers (so the index.js shutdown handler can kill
// them all on SIGTERM). Both were previously globals in index.js.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { demuxLogBuffer, isValidContainerName, withDockerTimeout, sendDockerTimeoutResponse } = require('../util');

const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

// Module-scope mutable state. activeLogProcesses is exported via
// closeActiveLogProcesses() so the index.js shutdown handler can drain it.
let debugTimer = null;
const activeLogProcesses = new Set();

const closeActiveLogProcesses = () => {
  for (const proc of activeLogProcesses) {
    try { proc.kill(); } catch (e) { /* ignore */ }
  }
  activeLogProcesses.clear();
};

// Shared helper: parse the gateway's Prometheus metrics endpoint into
// { received, sent, failed }. Counters are cumulative since collector start;
// callers that need rates must compute deltas.
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

// True when the exporter is producing failures with zero successes — strong
// signal that auth/network is broken rather than intermittent flakiness.
// Used by the apikey check to escalate even when log scraping misses the
// failure window.
const checkExporterFailing = async (targetContainer) => {
  const c = await fetchCounters(targetContainer);
  return { failing: c.failed > 0 && c.sent === 0, ...c };
};

// Read the otlphttp/bmchelix exporter's sending-queue size from the gateway's
// Prometheus metrics. A non-zero value during the verify wait means Helix is
// accepting connections but the gateway hasn't drained the queue yet — usually
// "Helix is slow" rather than "your config is broken." Returns null when the
// metric isn't exposed (older otelcol versions or scrape failed).
const fetchHelixQueueSize = async (targetContainer) => {
  try {
    const url = `http://${targetContainer}:8888/metrics`;
    const response = await axios.get(url, { timeout: 2000 });
    for (const line of response.data.split('\n')) {
      if (!line.startsWith('otelcol_exporter_queue_size')) continue;
      if (!line.includes('exporter="otlphttp/bmchelix"')) continue;
      const parts = line.trim().split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (!isNaN(val)) return val;
    }
  } catch { /* metrics scrape failed — treat as unknown */ }
  return null;
};

// Read counters from the *customer's* collector — same metrics shape as the
// gateway's, but filtered to the helix_sidecar exporter (or whatever exporter
// targets http://helix-gateway:4318). Used by verify-trace to distinguish
// "trace stuck at customer side, gateway unreachable" from "trace stuck at
// gateway side, BMC slow." Returns null when the collector doesn't expose
// metrics or the exporter name can't be matched; callers fall back to
// gateway-only verdicts in that case.
const fetchCustomerCollectorCounters = async (collectorName, port = 8888) => {
  if (!collectorName) return null;
  try {
    const url = `http://${collectorName}:${port}/metrics`;
    const response = await axios.get(url, { timeout: 2000 });
    const metrics = response.data;
    // Match exporters whose name contains "helix" — smart-add writes
    // otlphttp/helix_sidecar, but a user who applied the snippet manually
    // might have a different exporter name. The substring catch is
    // intentionally loose — anything else pointing at helix-gateway also
    // matches. False positives are unlikely in a single collector config.
    const isHelixExporter = (line) => /exporter="[^"]*helix[^"]*"/i.test(line);
    let sent = 0, failed = 0, queueSize = null;
    let sentSeen = false, failedSeen = false;
    for (const line of metrics.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!isHelixExporter(trimmed)) continue;
      const parts = trimmed.split(/\s+/);
      const val = parseFloat(parts[parts.length - 1]);
      if (isNaN(val)) continue;
      if (trimmed.startsWith('otelcol_exporter_sent_')) { sent += val; sentSeen = true; }
      else if (trimmed.startsWith('otelcol_exporter_send_failed_')) { failed += val; failedSeen = true; }
      else if (trimmed.startsWith('otelcol_exporter_queue_size')) { queueSize = val; }
      // Older otelcol versions called the queue gauge "queue_capacity"; keep
      // looking even after queue_size is set so a newer name overrides.
      else if (trimmed.startsWith('otelcol_exporter_queue_capacity') && queueSize == null) queueSize = val;
    }
    // If we didn't see any helix-targeted exporter rows, the collector either
    // doesn't have a helix-sidecar exporter wired in yet or doesn't expose
    // metrics for it. Signal "unknown" so callers don't read undercounts as
    // real numbers.
    if (!sentSeen && !failedSeen && queueSize == null) return null;
    return { sent: Math.round(sent), failed: Math.round(failed), queueSize };
  } catch {
    // Unreachable, no metrics endpoint, network not bridged yet — all
    // collapse to "unknown" from the verdict's perspective.
    return null;
  }
};

function register(app, { docker, containerLogs, configPath }) {
  // Strip debug logs from the collector YAML and restart. Used as both the
  // 5-minute failsafe (so a forgotten debug session doesn't pin the gateway)
  // and the explicit "disable" toggle.
  const revertDebugMode = async () => {
    const targetContainer = TARGET_CONTAINER();
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const configObj = yaml.load(configContent);
      if (configObj.service && configObj.service.telemetry) {
        delete configObj.service.telemetry.logs;

        // Force heal metrics format.
        configObj.service.telemetry.metrics = {
          readers: [{ pull: { exporter: { prometheus: { host: '0.0.0.0', port: 8888 } } } }]
        };

        const newYaml = yaml.dump(configObj, { lineWidth: -1 });
        fs.writeFileSync(configPath, newYaml, 'utf8');
        await docker.getContainer(targetContainer).restart().catch(() => {});
        console.log('Failsafe: Debug mode reverted and container restarted.');
      }
    } catch (e) {
      console.error('Failsafe revert failed:', e.message);
    }
  };

  // POST deep verification of the Step 3 bridge. Step 3 today shows green
  // purely on a topology check (does the customer collector share a network
  // with helix-gateway?). That misses two real failure modes:
  //   1. Receiver isn't actually listening on the shared network's interface
  //      — gateway crashed, OTLP receiver disabled in YAML, or the network
  //      attached after the receiver bound (rare after the pre-start attach
  //      fix in commit 81b8bfe, but still possible if reconcile re-attached
  //      mid-run).
  //   2. Customer collector's helix-targeted exporter is failing or stuck in
  //      retry backoff — config wrong, DNS for helix-gateway not resolving
  //      from the collector's network namespace, TLS misconfigured.
  //
  // Returns three sub-results + an overall verdict. yellow = couldn't
  // perform a deeper check (collector has no metrics endpoint, common in
  // minimal builds); red = an explicit failure; green = all probes passed.
  app.post('/api/diagnostics/step3-verify', async (req, res) => {
    const { collectorName } = req.body || {};
    const targetContainer = TARGET_CONTAINER();
    const collector = (typeof collectorName === 'string' && /^[a-zA-Z0-9_.-]+$/.test(collectorName))
      ? collectorName : null;

    // Topology check: confirm gateway and collector still share a network.
    // Cheaper than the receiver/exporter probes and a useful sanity check
    // for callers that didn't pre-confirm via /api/discovery/collectors.
    let topology = 'unknown';
    let sharedNetwork = null;
    try {
      const gwInspect = await withDockerTimeout(docker.getContainer(targetContainer).inspect(), 'container.inspect', 5_000);
      const gwNetworks = new Set(Object.keys(gwInspect.NetworkSettings?.Networks || {}));
      if (collector) {
        const colInspect = await withDockerTimeout(docker.getContainer(collector).inspect(), 'container.inspect', 5_000);
        const colNetworks = Object.keys(colInspect.NetworkSettings?.Networks || {});
        sharedNetwork = colNetworks.find(n => gwNetworks.has(n)) || null;
        topology = sharedNetwork ? 'ok' : 'missing';
      } else {
        // No collector name passed — caller is asking "is the gateway alive
        // at all" on some non-helix-bridge network. Treat any non-helix-
        // bridge network as evidence of topology being in place.
        const userNetworks = [...gwNetworks].filter(n => n !== 'helix-bridge' && n !== 'host' && n !== 'none' && n !== 'ingress');
        sharedNetwork = userNetworks[0] || null;
        topology = sharedNetwork ? 'ok' : 'missing';
      }
    } catch (e) {
      // Inspect failed — most often "gateway not running." Caller's UI shows
      // this as 'unknown' rather than implying topology is broken.
      console.warn('step3-verify topology probe:', e.message);
    }

    // Receiver probe: a tiny HTTP GET against the gateway's OTLP receiver.
    // 404 is fine — the receiver responds to GET with a method-not-allowed
    // but the listener is bound. Connection refused or timeout → not bound.
    let gatewayReceiver = 'unknown';
    try {
      await axios.get(`http://${targetContainer}:4318/`, { timeout: 2000, validateStatus: () => true });
      gatewayReceiver = 'ok';
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) {
        gatewayReceiver = 'unreachable';
      } else {
        gatewayReceiver = 'unknown';
      }
    }

    // Exporter probe: 3-second delta on the customer collector's
    // helix-targeted exporter counters. Failing means non-zero growth in
    // send_failed_* over the window; ok means send_failed stable at the
    // baseline OR sent grew at least as fast. Skipped (not-probed) when
    // no collector was named or the collector doesn't expose metrics.
    let collectorExporter = 'not-probed';
    let exporterDetail = null;
    if (collector) {
      const baseline = await fetchCustomerCollectorCounters(collector);
      if (!baseline) {
        collectorExporter = 'unknown';
      } else {
        await new Promise(r => setTimeout(r, 3000));
        const after = await fetchCustomerCollectorCounters(collector);
        if (!after) {
          collectorExporter = 'unknown';
        } else {
          const sentDelta = after.sent - baseline.sent;
          const failedDelta = after.failed - baseline.failed;
          exporterDetail = { sentDelta, failedDelta };
          if (failedDelta > 0 && sentDelta <= 0) collectorExporter = 'failing';
          else collectorExporter = 'ok';
        }
      }
    }

    // Tri-state overall verdict — strict: any explicit failure → red;
    // any unknown on a probe we attempted → yellow; otherwise green.
    let overall = 'green';
    let message = 'helix-gateway is bridged and the collector exporter is succeeding.';
    let remediation;
    if (topology === 'missing' || gatewayReceiver === 'unreachable' || collectorExporter === 'failing') {
      overall = 'red';
      if (topology === 'missing') {
        message = collector
          ? `helix-gateway and \`${collector}\` don't share a network.`
          : 'helix-gateway isn\'t on any user network yet.';
        remediation = 'Re-attach via Step 3 or the Bridge controls below.';
      } else if (gatewayReceiver === 'unreachable') {
        message = 'helix-gateway\'s OTLP receiver isn\'t reachable on :4318.';
        remediation = 'The gateway is running but the receiver isn\'t listening — check Step 1 saved a valid YAML and the container restarted cleanly.';
      } else {
        message = `\`${collector}\`'s helix exporter is failing (failed +${exporterDetail?.failedDelta || 0} in 3s, sent +${exporterDetail?.sentDelta || 0}).`;
        remediation = 'The collector can\'t deliver to helix-gateway. Most common causes: DNS for "helix-gateway" doesn\'t resolve from the collector\'s network, or TLS/auth mismatched.';
      }
    } else if (gatewayReceiver === 'unknown' || (collector && collectorExporter === 'unknown') || topology === 'unknown') {
      overall = 'yellow';
      message = collector
        ? `Topology looks good but I couldn't fully verify ${collectorExporter === 'unknown' ? `\`${collector}\`'s exporter` : 'the gateway receiver'}.`
        : 'Topology looks good but I couldn\'t fully verify the gateway receiver.';
      remediation = 'You can continue to Verify; the Step 4 check will catch lingering issues.';
    }
    res.json({
      topology,
      gatewayReceiver,
      collectorExporter,
      sharedNetwork,
      exporterDetail,
      overall,
      message,
      remediation,
    });
  });

  // POST toggle debug logging in YAML and restart.
  app.post('/api/diagnostics/toggle-debug', async (req, res) => {
    const { enable } = req.body;
    const targetContainer = TARGET_CONTAINER();

    if (debugTimer) {
      clearTimeout(debugTimer);
      debugTimer = null;
    }

    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const configObj = yaml.load(configContent);

      configObj.service = configObj.service || {};
      configObj.service.telemetry = configObj.service.telemetry || {};

      // Force heal metrics format.
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
      fs.writeFileSync(configPath, newYaml, 'utf8');

      try {
        await withDockerTimeout(docker.getContainer(targetContainer).restart(), 'container.restart', 30_000);
        res.json({ message: `Debug mode ${enable ? 'enabled' : 'disabled'}` });
      } catch (restartErr) {
        if (sendDockerTimeoutResponse(res, restartErr)) return;
        res.status(500).json({ error: 'Failed to restart for debug toggle', details: restartErr.message });
      }
    } catch (e) {
      res.status(500).json({ error: 'Failed to toggle debug mode', details: e.message });
    }
  });

  // POST inject a synthetic OTLP trace with retries.
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

    const targetContainer = TARGET_CONTAINER();
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

  // POST inject a synthetic trace and verify it actually exported to Helix.
  // Used by the wizard's "Verify Telemetry Flow" — proves the gateway→Helix
  // path independent of whether the user's app is instrumented yet.
  app.post('/api/diagnostics/inject-trace-verify', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    const otlpUrl = `http://${targetContainer}:4318/v1/traces`;
    const traceId = crypto.randomBytes(16).toString('hex');
    const spanId = crypto.randomBytes(8).toString('hex');

    // Optional: the Step 3-selected customer collector. When provided, the
    // poll loop also reads its helix-targeted exporter counters so the
    // verdict can distinguish "stuck at customer side, gateway unreachable"
    // from "stuck at gateway side, BMC slow." When omitted, the route falls
    // back to its prior gateway-only behavior.
    const customerCollector = (req.body && typeof req.body.collectorName === 'string'
      && /^[a-zA-Z0-9_.-]+$/.test(req.body.collectorName))
      ? req.body.collectorName : null;

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
    // Customer baseline is best-effort — missing data here just means we
    // skip the dual-side analysis later, not that the verify call fails.
    const customerBaseline = customerCollector
      ? await fetchCustomerCollectorCounters(customerCollector)
      : null;

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

    // Poll the gateway sent/failed counters for up to 20s, and (when a
    // customer collector was named) the customer's helix-exporter counters
    // alongside. We're looking for a delta — either the trace exported
    // (gateway sent went up), Helix rejected it (gateway failed went up),
    // the customer side is queueing (customer queue/failed grew while
    // gateway counters stayed flat), or nothing moved (true timeout).
    //
    // The 5s → 15s → 20s history: original 5s false-failed when Helix took
    // a beat to ack; 15s caught most cases; 20s splits the difference with
    // the TODO ask (30s) — 90th-percentile real traces should land in
    // 10-15s, leaving a healthy margin without making the user wait forever
    // on a stalled pipeline.
    const deadline = Date.now() + 20000;
    let lastQueueSize = null;
    let lastCustomer = customerBaseline;
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
        // Track the sending_queue size on the bmchelix exporter so the timeout
        // verdict can call out "queue is backed up" vs "Helix is silent".
        const q = await fetchHelixQueueSize(targetContainer);
        if (q != null) lastQueueSize = q;
        // Refresh the customer-side snapshot if we have one. Only useful in
        // the timeout-verdict logic below — a customer-side delta is a
        // tiebreaker for "where did the trace get stuck," not a success
        // signal in its own right.
        if (customerCollector) {
          const cur = await fetchCustomerCollectorCounters(customerCollector);
          if (cur) lastCustomer = cur;
        }
      } catch { /* metrics blip — keep polling */ }
    }

    // Timeout path. Three-way disambiguation:
    //   queued_customer  → customer exporter queue grew OR send_failed grew
    //                      while gateway counters stayed flat. The trace
    //                      never left the customer side.
    //   queued_gateway   → gateway queue > 0 and nothing customer-side moved
    //                      worse. Trace is sitting in the gateway's outbound
    //                      queue waiting on Helix.
    //   pending          → nothing observable moved anywhere. Fallback.
    //
    // We only branch into queued_customer when we have both baseline and
    // current snapshots; otherwise the customer state is "unknown" and the
    // gateway-side verdict stands.
    const customerDelta = (customerBaseline && lastCustomer) ? {
      sent: lastCustomer.sent - customerBaseline.sent,
      failed: lastCustomer.failed - customerBaseline.failed,
      queueSize: lastCustomer.queueSize,
      queueSizeDelta: (customerBaseline.queueSize != null && lastCustomer.queueSize != null)
        ? lastCustomer.queueSize - customerBaseline.queueSize
        : null,
    } : null;
    const customerStuck = customerDelta && (
      (customerDelta.failed > 0) ||
      (customerDelta.queueSizeDelta != null && customerDelta.queueSizeDelta > 0) ||
      (customerDelta.queueSize != null && customerDelta.queueSize > 0)
    );

    if (customerStuck) {
      return res.json({
        status: 'queued_customer',
        customer: customerDelta,
        queueSize: lastQueueSize,
        message: `Trace is stuck at \`${customerCollector}\` — helix-gateway looks unreachable from it.`,
        remediation: 'The collector is queueing or failing to send. Check Step 3: confirm the collector and helix-gateway share a network, and that the collector can resolve "helix-gateway" via DNS. Then restart the collector.',
      });
    }
    if (lastQueueSize != null && lastQueueSize > 0) {
      return res.json({
        status: 'queued_gateway',
        queueSize: lastQueueSize,
        customer: customerDelta,
        message: `Trace is queued at the gateway (${lastQueueSize} item${lastQueueSize === 1 ? '' : 's'} pending) — Helix hasn't acknowledged yet`,
        remediation: 'Helix is slow to accept or briefly unreachable. The gateway will keep retrying; watch the Sent counter for the next minute.',
      });
    }
    if (lastQueueSize === 0) {
      return res.json({
        status: 'pending',
        queueSize: 0,
        customer: customerDelta,
        message: 'Gateway drained the queue but Helix returned no acknowledgement within 20s',
        remediation: 'The trace left the gateway but no success counter moved. Verify the tenant is configured to accept your X-Source, and that HELIX_API_KEY has the right role.',
      });
    }
    res.json({
      status: 'pending',
      customer: customerDelta,
      message: 'Trace accepted by gateway but no exporter delta within 20s',
      remediation: 'Open Diagnostic Health Check and watch the Sent/Dropped counters for the next minute.',
    });
  });

  // GET live metrics parsing.
  app.get('/api/diagnostics/metrics/live', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
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
    const targetContainer = TARGET_CONTAINER();
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

  // GET collector-side export-error scan. When the App→Gateway counters stay
  // at zero despite the user applying a snippet, the cause is usually on the
  // customer's COLLECTOR side: an exporter unable to resolve helix-gateway
  // (DNS / wrong network), using the wrong protocol, or refused by Helix.
  //
  // Scope is intentionally tight: we only scan containers that *look like*
  // OTel collectors (image name contains opentelemetry-collector / otelcol,
  // or command invokes otelcol) AND share a network with helix-gateway.
  // App containers can log strings like "connection refused" or "rpc error"
  // for entirely unrelated reasons (their own DB, internal gRPC, etc.) —
  // surfacing those here was noisy and misleading, so they're excluded.
  app.get('/api/diagnostics/app-export-errors', async (req, res) => {
    // Lines containing any of these substrings — lower-cased match — are
    // the ones we care about.
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
      const targetContainer = TARGET_CONTAINER();
      let gatewayNetworks;
      try {
        const gw = await withDockerTimeout(docker.getContainer(targetContainer).inspect(), 'container.inspect', 5_000);
        gatewayNetworks = new Set(Object.keys(gw.NetworkSettings?.Networks ?? {}));
      } catch (e) {
        if (sendDockerTimeoutResponse(res, e)) return;
        return res.json({ collectors: [], errors: [], note: `${targetContainer} not running` });
      }
      if (gatewayNetworks.size === 0) {
        return res.json({ collectors: [], errors: [], note: `${targetContainer} has no networks attached yet` });
      }

      // Enumerate containers once, filter to collectors that share a network
      // with helix-gateway. helix-* containers are always excluded so our own
      // gateway/configurator don't show up.
      const all = await withDockerTimeout(docker.listContainers(), 'docker.listContainers');
      const collectors = all
        .map(c => ({
          name: (c.Names?.[0] || '').replace(/^\//, ''),
          image: c.Image || '',
          command: c.Command || '',
          networks: Object.keys(c.NetworkSettings?.Networks || {}),
        }))
        .filter(c => {
          if (!c.name || c.name.startsWith('helix-')) return false;
          const looksLikeCollector =
            /opentelemetry-collector/i.test(c.image) ||
            /otelcol/i.test(c.image) ||
            /otelcol/i.test(c.command);
          if (!looksLikeCollector) return false;
          return c.networks.some(n => gatewayNetworks.has(n));
        })
        .map(c => c.name);

      const errors = (await Promise.all(collectors.map(async (name) => {
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
              // Two-part match: the line must mention `helix` AND a known
              // error signal. The `helix` substring narrows scope to the
              // helix-bound exporter (component.id contains helix_sidecar,
              // endpoint contains helix-gateway). Without this, unrelated
              // receiver/processor failures with overlapping vocabulary
              // (e.g. kafkametrics "connection refused" against a Kafka
              // broker) leak in as false positives.
              if (!lower.includes('helix')) return false;
              return errorSignals.some(sig => lower.includes(sig));
            })
            .slice(-5); // most recent 5 matching lines per container
          return matches.length ? { container: name, lines: matches } : null;
        } catch { return null; /* container unreadable, skip */ }
      }))).filter(Boolean);

      res.json({ collectors, errors });
    } catch (e) {
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to scan collector logs', details: e.message });
    }
  });

  // GET stream logs from docker with optional container targeting and prefixing.
  app.get('/api/diagnostics/logs/stream', async (req, res) => {
    const { container } = req.query;
    if (container && !isValidContainerName(container)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    const targetContainer = container || TARGET_CONTAINER();
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

      // Wrap so the shutdown handler can kill it like a ChildProcess.
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

      // Demultiplex the docker frame format into a single PassThrough stream.
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

  // GET raw Prometheus metrics output from the gateway (debug aid).
  app.get('/api/diagnostics/metrics/raw', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    const url = `http://${targetContainer}:8888/metrics`;
    try {
      const response = await axios.get(url, { timeout: 2000 });
      res.type('text/plain').send(response.data);
    } catch (e) {
      res.status(500).type('text/plain').send(`Failed to fetch metrics from ${url}: ${e.message}`);
    }
  });

  // GET non-streaming tail of gateway logs (used by Copy Support Bundle).
  app.get('/api/diagnostics/logs/recent', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    const tailRaw = parseInt(req.query.tail, 10);
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 && tailRaw <= 200 ? tailRaw : 5;
    try {
      const logs = await containerLogs(targetContainer, { tail });
      res.json({ logs });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch recent logs', details: e.message });
    }
  });

  // POST start specific container diagnostics.
  app.post('/api/diagnostics/start', (req, res) => {
    const { containerName } = req.body;
    console.log(`Diagnostic session requested for: ${containerName}`);
    res.json({ status: 'OK', message: `Diagnostics started for ${containerName}` });
  });

  // GET network diagnostics.
  app.get('/api/diagnostics/network', async (req, res) => {
    try {
      const envPath = path.join(__dirname, '../../.env');
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
        // OTLP endpoints might return 405 or 404 on GET, which is still "reachable".
        if (err.response) return err.response;
        throw err;
      });

      res.json({
        status: 'Success',
        latency: `${Date.now() - startTime}ms`,
        endpoint,
      });
    } catch (e) {
      res.status(500).json({
        status: 'Failed',
        error: e.message,
        remediation: 'Endpoint unreachable. Verify the HELIX_ENDPOINT includes https:// and check your outbound firewall rules.',
      });
    }
  });

  // GET telemetry diagnostics.
  app.get('/api/diagnostics/telemetry', async (req, res) => {
    try {
      const targetContainer = TARGET_CONTAINER();
      // Query collector's own metrics if available.
      const response = await axios.get(`http://${targetContainer}:8888/metrics`);
      // Simple check if metrics are being exposed.
      if (response.data.includes('otelcol_exporter_sent_spans')) {
        res.json({ status: 'Healthy', details: 'Collector is emitting spans' });
      } else {
        res.json({ status: 'Warning', details: 'Collector is running but no spans sent yet' });
      }
    } catch (e) {
      res.status(500).json({ status: 'Disconnected', error: 'Could not reach collector metrics endpoint' });
    }
  });

  // GET detailed collector diagnostics.
  app.get('/api/diagnostics/collector', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    try {
      // Check 1: Container Status — also surface exit code when not running so a
      // crash-loop is distinguishable from a clean stop.
      const inspectData = await withDockerTimeout(docker.getContainer(targetContainer).inspect(), 'container.inspect', 5_000);
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

      // Check 2: Configuration/Unmarshal errors in the last 15s.
      const since = Math.floor(Date.now() / 1000) - 15;
      const logs = await containerLogs(targetContainer, { since });
      const logOutput = logs.toLowerCase();
      if (logOutput.includes('invalid keys') || logOutput.includes('cannot unmarshal') || logOutput.includes('failed to get config')) {
        const lines = logs.split('\n');
        const errorLine = lines.find(l => l.includes('Error:') || l.includes('error')) || 'Fatal configuration error detected';
        return res.json({
          status: 'FAIL',
          error: errorLine.trim(),
          remediation: 'The collector schema is outdated or malformed. Ensure service.telemetry.metrics uses the "readers" array format.',
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

  // GET detailed API key diagnostics.
  app.get('/api/diagnostics/apikey', async (req, res) => {
    try {
      const envPath = path.join(__dirname, '../../.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const vars = {};
      envContent.split('\n').forEach(line => {
        const [key, ...value] = line.split('=');
        if (key && value) vars[key.trim()] = value.join('=').trim();
      });

      const apiKey = vars.HELIX_API_KEY || '';
      const targetContainer = TARGET_CONTAINER();

      // Step 1: Loose structural check — three non-empty :: separated tokens.
      const keyRegex = /^[^:]+::[^:]+::[^:]+$/;
      if (!keyRegex.test(apiKey)) {
        return res.json({
          status: 'FAIL',
          error: 'Invalid format',
          remediation: 'Must match TenantID::AccessKey::SecretKey',
        });
      }

      // Step 2: Cross-reference logs for authentication failures in the last 15s.
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
          remediation: 'Format is valid, but Helix rejected the credentials. Verify the key in the BMC Helix Portal.',
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
            remediation: 'The exporter is failing. Common causes: invalid API key, expired key, or tenant blocking the source IP. Verify the key in the BMC Helix Portal.',
          });
        }
      } catch (e) { /* metrics endpoint unreachable — fall through */ }

      res.json({ status: 'PASS' });
    } catch (e) {
      res.status(500).json({ status: 'FAIL', error: 'Failed to read env for check' });
    }
  });

  // POST authoritative API key probe — bypass the gateway and post a minimal
  // synthetic OTLP traces payload directly to ${HELIX_ENDPOINT}/v1/traces with
  // X-Api-Key/X-Source set. The HTTP response is the source of truth for "is
  // this key currently accepted by Helix?", independent of whether the gateway
  // is up or the customer's collector is wired in.
  //
  // Surfaced from Step 4 when the existing "Verify gateway → Helix" check
  // fails, so the user can disambiguate "key rejected" from "pipeline broken".
  app.post('/api/diagnostics/apikey-probe', async (req, res) => {
    try {
      const envPath = path.join(__dirname, '../../.env');
      const envContent = fs.readFileSync(envPath, 'utf8');
      const vars = {};
      envContent.split('\n').forEach(line => {
        const [key, ...value] = line.split('=');
        if (key && value) vars[key.trim()] = value.join('=').trim();
      });

      const endpoint = (vars.HELIX_ENDPOINT || '').replace(/\/$/, '');
      const apiKey = vars.HELIX_API_KEY || '';
      const xSource = vars.X_SOURCE || 'helix-configurator-probe';
      if (!endpoint) {
        return res.json({ status: 'misconfigured', message: 'HELIX_ENDPOINT is not set in .env' });
      }
      if (!/^[^:]+::[^:]+::[^:]+$/.test(apiKey)) {
        return res.json({
          status: 'invalid-format',
          message: 'HELIX_API_KEY must match TenantID::AccessKey::SecretKey',
        });
      }
      if (apiKey.startsWith('FAKE-KEY-')) {
        return res.json({
          status: 'placeholder',
          message: 'HELIX_API_KEY is the demo placeholder (FAKE-KEY-…). Replace it with a real tenant key before probing.',
        });
      }

      // Minimal OTLP traces payload — one zero-duration span tagged with our
      // own service name so it's easy to identify in Helix if it lands.
      const payload = {
        resourceSpans: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'helix-configurator-probe' } }] },
          scopeSpans: [{
            spans: [{
              traceId: crypto.randomBytes(16).toString('hex'),
              spanId: crypto.randomBytes(8).toString('hex'),
              name: 'apikey-probe',
              kind: 1,
              startTimeUnixNano: Date.now() * 1_000_000,
              endTimeUnixNano: (Date.now() + 1) * 1_000_000,
              status: { code: 1 },
            }],
          }],
        }],
      };

      const url = `${endpoint}/v1/traces`;
      const t0 = Date.now();
      try {
        const r = await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': apiKey,
            'X-Source': xSource,
          },
          timeout: 8000,
          // Don't throw on 4xx/5xx — we want to inspect the status.
          validateStatus: () => true,
        });
        const latencyMs = Date.now() - t0;
        if (r.status >= 200 && r.status < 300) {
          return res.json({
            status: 'valid',
            httpStatus: r.status,
            latencyMs,
            message: `Helix accepted the probe trace (HTTP ${r.status} in ${latencyMs}ms).`,
          });
        }
        if (r.status === 401) {
          return res.json({
            status: 'rejected',
            httpStatus: 401,
            message: 'Helix rejected the API key (HTTP 401 Unauthorized).',
            remediation: 'The key is malformed, expired, or revoked. Generate a new one in the BMC Helix Portal and paste it on Step 1.',
          });
        }
        if (r.status === 403) {
          return res.json({
            status: 'rejected',
            httpStatus: 403,
            message: 'Helix accepted the key but the tenant refused this request (HTTP 403).',
            remediation: 'The key is recognized but lacks permission, or the tenant is blocking the source IP. Verify the key role in the BMC Helix Portal.',
          });
        }
        if (r.status >= 400 && r.status < 500) {
          return res.json({
            status: 'tenant-error',
            httpStatus: r.status,
            message: `Helix returned HTTP ${r.status}.`,
            remediation: 'The endpoint accepted the connection but rejected the request. Check that HELIX_ENDPOINT is the tenant-root URL (no trailing /otlp/v1/traces).',
          });
        }
        return res.json({
          status: 'helix-error',
          httpStatus: r.status,
          message: `Helix returned HTTP ${r.status}.`,
          remediation: 'Helix-side error. Retry shortly; if persistent, check the tenant status page.',
        });
      } catch (e) {
        const code = e.code || '';
        const isTimeout = code === 'ECONNABORTED' || /timeout/i.test(e.message || '');
        const isConnect = code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
        return res.json({
          status: 'network-error',
          message: isTimeout
            ? `Probe timed out talking to ${url}.`
            : isConnect
            ? `Could not reach ${url} (${code || 'connection error'}).`
            : `Probe failed: ${e.message}`,
          remediation: 'Verify HELIX_ENDPOINT is reachable from this host (firewall, DNS, https://).',
        });
      }
    } catch (e) {
      res.status(500).json({ status: 'error', message: `Probe setup failed: ${e.message}` });
    }
  });
}

module.exports = { register, closeActiveLogProcesses };
