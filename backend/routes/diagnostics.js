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
const { demuxLogBuffer, isValidContainerName, withDockerTimeout, sendDockerTimeoutResponse, resolveGatewayOtlpBase, resolveGatewayMetricsBase } = require('../util');
const errorLog = require('../errorLog');
const { analyzeCollectorErrorLog } = require('../exportErrorScan');

// Docker-API name (logs / inspect / restart) only. HTTP requests from this
// process must go through resolveGateway*Base — container DNS doesn't exist
// on native installs.
const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

// Synthetic diagnostic traces (inject-trace) carry an explicit OTel namespace
// so Helix groups them on their own. Without it Helix
// falls back to the X-Source header, landing these internal health checks
// inside the customer's namespace and cluttering the AIOps topology/demo.
const DIAGNOSTIC_NAMESPACE = 'Helix-Configurator-Internal';

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

// Sum a Prometheus `<baseName>_total` counter across every label permutation
// in a /metrics scrape. Prometheus emits float64, so parseFloat keeps
// "1.234e+05" from truncating. When exporterFilter is set, only lines
// carrying exporter="<filter>" count — used to isolate the bmchelix exporter
// from the local-viewer fan-out so "sent" reflects Helix delivery alone.
const sumPromCounter = (metricsText, baseName, { exporterFilter } = {}) => {
  const name = baseName + '_total';
  let sum = 0;
  for (const line of metricsText.split('\n')) {
    if (!line.startsWith(name)) continue;
    if (exporterFilter && !line.includes(`exporter="${exporterFilter}"`)) continue;
    const parts = line.trim().split(/\s+/);
    const val = parseFloat(parts[parts.length - 1]);
    if (!isNaN(val)) sum += val;
  }
  return Math.round(sum);
};

// The collector self-telemetry metrics block in the modern (otelcol 0.123+)
// reader format. Rewritten on every debug-mode toggle so a config still
// carrying the legacy `metrics: { address: ... }` shape gets healed to the
// format the gateway's Prometheus scrape (and our counter checks) expect.
const healedMetricsTelemetry = () => ({
  readers: [{ pull: { exporter: { prometheus: { host: '0.0.0.0', port: 8888 } } } }],
});

// Shared helper: parse the gateway's Prometheus metrics endpoint into
// { received, sent, failed }. Counters are cumulative since collector start;
// callers that need rates must compute deltas.
const fetchCounters = async () => {
  const url = `${resolveGatewayMetricsBase()}/metrics`;
  const response = await axios.get(url, { timeout: 2000 });
  const metrics = response.data;

  // Exporter counters are scoped to the bmchelix exporter so the local-viewer
  // fan-out doesn't inflate "sent"; receiver counters sum across all labels.
  const extractSum = (baseName) =>
    sumPromCounter(metrics, baseName,
      baseName.includes('exporter') ? { exporterFilter: 'otlphttp/bmchelix' } : {});

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
const checkExporterFailing = async () => {
  const c = await fetchCounters();
  return { failing: c.failed > 0 && c.sent === 0, ...c };
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

// ---------------------------------------------------------------------------
// Minimal hand-rolled OTLP TracesData protobuf encoder.
//
// Why hand-rolled: the gateway's otlphttp/bmchelix exporter ships protobuf
// (the OTel SDK default), not JSON. BMC Helix accepts protobuf but rejects
// JSON-encoded OTLP with HTTP 400 — so a JSON-bodied probe produced a false
// "tenant rejected the request, check your URL" verdict for endpoints that
// worked fine for the actual data path. Matching the gateway's wire format
// here eliminates the false positive without pulling in
// @opentelemetry/exporter-trace-otlp-proto and its ~7-package transitive
// closure for a single probe payload.
//
// Schema reference (frozen since OTel 1.0): opentelemetry/proto/trace/v1/
// trace.proto and common/v1/common.proto. Only the fields actually emitted
// below are encoded; everything else uses proto3's "absent fields are
// default-valued" rule, which the spec requires receivers to accept.
// ---------------------------------------------------------------------------
function pbVarint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 128n) {
    out.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  out.push(Number(v & 127n));
  return Buffer.from(out);
}
function pbTag(field, wireType) { return pbVarint((field << 3) | wireType); }
function pbVarintField(field, n) { return Buffer.concat([pbTag(field, 0), pbVarint(n)]); }
function pbI64Field(field, bigN) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(bigN));
  return Buffer.concat([pbTag(field, 1), b]);
}
function pbLenField(field, payload) {
  return Buffer.concat([pbTag(field, 2), pbVarint(payload.length), payload]);
}
function pbStringField(field, s) { return pbLenField(field, Buffer.from(s, 'utf8')); }
function pbBytesField(field, buf) { return pbLenField(field, buf); }

function encodeOtlpProbeTracesPayload() {
  // AnyValue { string_value (field 1) }
  const anyValue = pbStringField(1, 'helix-configurator-probe');
  // KeyValue { key (1), value (2) }
  const kv = Buffer.concat([
    pbStringField(1, 'service.name'),
    pbLenField(2, anyValue),
  ]);
  // Resource body { attributes (1, repeated) }
  const resourceBody = pbLenField(1, kv);
  // ResourceSpans.resource (field 1)
  const resourceField = pbLenField(1, resourceBody);

  // Span body. Field numbers from trace.proto:
  //   1=trace_id, 2=span_id, 5=name, 6=kind, 7=start_time_unix_nano,
  //   8=end_time_unix_nano, 15=status.
  const traceId = crypto.randomBytes(16);
  const spanId = crypto.randomBytes(8);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const statusBody = pbVarintField(3, 1); // Status.code = STATUS_CODE_OK
  const spanBody = Buffer.concat([
    pbBytesField(1, traceId),
    pbBytesField(2, spanId),
    pbStringField(5, 'apikey-probe'),
    pbVarintField(6, 1), // SPAN_KIND_INTERNAL
    pbI64Field(7, nowNs),
    pbI64Field(8, nowNs + 1n),
    pbLenField(15, statusBody),
  ]);

  // InstrumentationScope body { name (1) }. Some receivers require the
  // scope field to be present, even with empty values.
  const scopeBody = pbStringField(1, 'helix-configurator-probe');

  // ScopeSpans body { scope (1), spans (2, repeated) }
  const scopeSpansBody = Buffer.concat([
    pbLenField(1, scopeBody),
    pbLenField(2, spanBody),
  ]);
  // ResourceSpans.scope_spans (field 2)
  const scopeSpansField = pbLenField(2, scopeSpansBody);

  // ResourceSpans body
  const resourceSpansBody = Buffer.concat([resourceField, scopeSpansField]);
  // TracesData.resource_spans (field 1, repeated). Top-level message is
  // written as just its field bytes — no outer length prefix on the wire.
  return pbLenField(1, resourceSpansBody);
}

// ---------------------------------------------------------------------------
// runOtlpProbe(endpoint, apiKey)
//
// Posts a minimal synthetic OTLP traces span directly to
// `${endpoint}/v1/traces` and returns a structured result object:
//
//   { status, httpStatus?, latencyMs?, message, remediation? }
//
// `status` is one of: 'valid' | 'rejected' | 'tenant-error' | 'helix-error'
//                    | 'network-error'
//
// Used by /api/diagnostics/test-connection (Step 1's "Test connection") to
// probe Helix with in-request credentials rather than process.env values.
// ---------------------------------------------------------------------------
async function runOtlpProbe(endpoint, apiKey) {
  const url = `${endpoint}/v1/traces`;
  // Protobuf body (matches the gateway's exporter wire format — see encoder
  // comment above for why this isn't JSON).
  const body = encodeOtlpProbeTracesPayload();

  const t0 = Date.now();
  try {
    const r = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Accept': 'application/x-protobuf',
        'X-Api-Key': apiKey,
        'X-Source': 'helix-configurator-probe',
      },
      timeout: 8000,
      validateStatus: () => true,
      // Don't let axios try to parse a protobuf response as JSON.
      responseType: 'arraybuffer',
    });
    const latencyMs = Date.now() - t0;
    // For non-success responses, surface the (text-decoded, truncated) body
    // so the operator can see what Helix actually objected to instead of
    // guessing from the status code alone.
    const bodySnippet = (() => {
      try {
        const s = Buffer.from(r.data || []).toString('utf8').trim();
        if (!s) return '';
        return s.length > 240 ? `${s.slice(0, 240)}…` : s;
      } catch { return ''; }
    })();
    if (r.status >= 200 && r.status < 300) {
      return {
        status: 'valid',
        httpStatus: r.status,
        latencyMs,
        message: `Helix accepted the probe trace (HTTP ${r.status} in ${latencyMs}ms).`,
      };
    }
    if (r.status === 401) {
      return {
        status: 'rejected',
        httpStatus: 401,
        message: `Helix rejected the API key (HTTP 401 Unauthorized).${bodySnippet ? ` Response: ${bodySnippet}` : ''}`,
        remediation: 'The key is malformed, expired, or revoked. Generate a new one in the BMC Helix Portal and paste it on Step 1.',
      };
    }
    if (r.status === 403) {
      return {
        status: 'rejected',
        httpStatus: 403,
        message: `Helix accepted the key but the tenant refused this request (HTTP 403).${bodySnippet ? ` Response: ${bodySnippet}` : ''}`,
        remediation: 'The key is recognized but lacks permission, or the tenant is blocking the source IP. Verify the key role in the BMC Helix Portal.',
      };
    }
    if (r.status >= 400 && r.status < 500) {
      return {
        status: 'tenant-error',
        httpStatus: r.status,
        message: `Helix returned HTTP ${r.status}.${bodySnippet ? ` Response: ${bodySnippet}` : ''}`,
        remediation: 'The endpoint accepted the connection but rejected the OTLP payload. Common causes: HELIX_ENDPOINT includes a trailing /v1/traces (it should be the OTLP root, e.g. https://<tenant>.onbmc.com/otlp), or the tenant requires a different content type. Your real gateway traffic may still be working — confirm via Step 4\'s verify-trace flow.',
      };
    }
    return {
      status: 'helix-error',
      httpStatus: r.status,
      message: `Helix returned HTTP ${r.status}.${bodySnippet ? ` Response: ${bodySnippet}` : ''}`,
      remediation: 'Helix-side error. Retry shortly; if persistent, check the tenant status page.',
    };
  } catch (e) {
    const code = e.code || '';
    const isTimeout = code === 'ECONNABORTED' || /timeout/i.test(e.message || '');
    const isConnect = code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
    return {
      status: 'network-error',
      message: isTimeout
        ? `Probe timed out talking to ${url}.`
        : isConnect
        ? `Could not reach ${url} (${code || 'connection error'}).`
        : `Probe failed: ${e.message}`,
      remediation: 'Verify HELIX_ENDPOINT is reachable from this host (firewall, DNS, https://).',
    };
  }
}

function register(app, { docker, containerLogs, configPath, otelStore }) {
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
        configObj.service.telemetry.metrics = healedMetricsTelemetry();

        const newYaml = yaml.dump(configObj, { lineWidth: -1 });
        fs.writeFileSync(configPath, newYaml, 'utf8');
        await docker.getContainer(targetContainer).restart().catch(() => {});
        console.log('Failsafe: Debug mode reverted and container restarted.');
      }
    } catch (e) {
      console.error('Failsafe revert failed:', e.message);
    }
  };

  // GET system-health summary — everything the dashboard's System Health panel
  // needs in a single round-trip: gateway container status, OTel throughput,
  // store usage, and recent logged errors.
  app.get('/api/diagnostics/system-health', async (req, res) => {
    const targetContainer = TARGET_CONTAINER();
    let gatewayStatus = 'unknown';
    let gatewayExitCode;
    try {
      const inspect = await withDockerTimeout(docker.getContainer(targetContainer).inspect(), 'container.inspect', 5_000);
      gatewayStatus = inspect.State?.Status || 'unknown';
      if (gatewayStatus !== 'running') gatewayExitCode = inspect.State?.ExitCode;
    } catch (e) {
      gatewayStatus = 'error';
    }
    const throughput = otelStore.recentThroughput();
    const recentErrors = errorLog.recent(10);
    res.json({ gatewayStatus, gatewayExitCode, throughput, recentErrors });
  });

  // POST clear the local OTel store — wipes all stored traces, spans, logs, and
  // errors. This is the "clean data slate" the reset-onboarding handler defers
  // to (that route intentionally leaves trace data intact). Local only: it does
  // not touch the Helix tenant, whose copy is retention-bound server-side.
  // Powers the OTel data page's Diagnostics → "Clear stored data" action.
  app.post('/api/diagnostics/clear-otel-store', (req, res) => {
    try {
      const cleared = otelStore.clearAll();
      res.json({ ok: true, cleared });
    } catch (e) {
      errorLog.push('otel-store.clear', e.message);
      res.status(500).json({ error: 'Failed to clear the OTel store', details: e.message });
    }
  });

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

    // Independent probes fan out in parallel: gateway inspect, collector
    // inspect (if named), receiver HTTP, and exporter baseline. The 3s wait
    // for the exporter delta is the dominant cost; folding the inspects and
    // receiver probe into the same Promise.all shaves the obvious 5s+2s
    // serial wait. `Promise.allSettled` lets each probe fail independently
    // — a topology failure shouldn't drag the receiver verdict down.
    // helix-gateway is recreated on every attach — the OTLP listener has to be
    // rebound to accept on the freshly-connected network interface (see the
    // bridge-network route). otelcol then takes ~1-3s to re-bind :4318, and the
    // frontend fires this verify the instant the attach POST returns, so a
    // single probe routinely catches the gateway mid-boot. Retry briefly so a
    // boot-window miss doesn't become a sticky false "unreachable" (the Step 3
    // effect only re-runs verify when the collector identity changes, so a
    // false negative here lingers on screen until the user navigates away). A
    // healthy gateway answers the first attempt, so steady-state adds no delay.
    const probeReceiver = async () => {
      const deadline = Date.now() + 3500;
      for (;;) {
        try {
          // Container DNS in the Docker image, published host ports natively —
          // the hardcoded container name read "unreachable" on every native install.
          await axios.get(`${resolveGatewayOtlpBase()}/`, { timeout: 2000, validateStatus: () => true });
          return 'ok';
        } catch (err) {
          const transient = err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
          if (!transient) return 'unknown'; // DNS/other — not a down receiver
          if (Date.now() >= deadline) return 'unreachable';
          await new Promise(r => setTimeout(r, 600));
        }
      }
    };

    const probes = await Promise.allSettled([
      withDockerTimeout(docker.getContainer(targetContainer).inspect(), 'container.inspect', 5_000),
      collector ? withDockerTimeout(docker.getContainer(collector).inspect(), 'container.inspect', 5_000) : Promise.resolve(null),
      probeReceiver(),
      collector ? fetchCustomerCollectorCounters(collector) : Promise.resolve(null),
    ]);
    const [gwInspectRes, colInspectRes, receiverRes, exporterBaselineRes] = probes;

    // Topology: derive from the inspect results.
    let topology = 'unknown';
    let sharedNetwork = null;
    if (gwInspectRes.status === 'fulfilled') {
      const gwNetworks = new Set(Object.keys(gwInspectRes.value.NetworkSettings?.Networks || {}));
      if (collector && colInspectRes.status === 'fulfilled' && colInspectRes.value) {
        const colNetworks = Object.keys(colInspectRes.value.NetworkSettings?.Networks || {});
        sharedNetwork = colNetworks.find(n => gwNetworks.has(n)) || null;
        topology = sharedNetwork ? 'ok' : 'missing';
      } else if (!collector) {
        // No collector named — caller is asking "is the gateway alive at all"
        // on some non-helix-bridge network. Any user network counts.
        const userNetworks = [...gwNetworks].filter(n => n !== 'helix-bridge' && n !== 'host' && n !== 'none' && n !== 'ingress');
        sharedNetwork = userNetworks[0] || null;
        topology = sharedNetwork ? 'ok' : 'missing';
      }
    } else {
      console.warn('step3-verify topology probe:', gwInspectRes.reason?.message || gwInspectRes.reason);
    }

    // Receiver verdict from probeReceiver: 'ok' (any HTTP response — 404 still
    // proves the listener is bound), 'unreachable' (conn-refused/timeout for the
    // whole retry window), or 'unknown' (DNS/other). It resolves rather than
    // rejects, so a rejected settle here is itself an unexpected failure.
    const gatewayReceiver = receiverRes.status === 'fulfilled' ? receiverRes.value : 'unknown';

    // Exporter: needs a 3s second sample after the baseline to detect a
    // non-zero send_failed delta. Baseline was fetched in the parallel
    // phase above; only the "after" measurement stays serial.
    let collectorExporter = 'not-probed';
    let exporterDetail = null;
    if (collector) {
      const baseline = exporterBaselineRes.status === 'fulfilled' ? exporterBaselineRes.value : null;
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
          collectorExporter = (failedDelta > 0 && sentDelta <= 0) ? 'failing' : 'ok';
        }
      }
    }

    // Tri-state overall verdict. The exporter check is informational at
    // Step 3 — exporter=unknown is the *common* state immediately after
    // bridging (smart-add may not have applied yet, or the collector
    // hasn't restarted to pick up the helix-targeted exporter). Treating
    // unknown as yellow misleads users into thinking Step 3 has a problem
    // when really the wiring just hasn't been validated end-to-end yet.
    // Only an active "failing" signal pulls the verdict down — that means
    // the exporter exists and is logging real failures.
    let overall = 'green';
    let message = collector
      ? `Network connection to \`${collector}\` is good. helix-gateway's OTLP receiver is reachable.`
      : 'Network connection is good. helix-gateway\'s OTLP receiver is reachable.';
    let remediation;
    if (topology === 'missing' || gatewayReceiver === 'unreachable' || collectorExporter === 'failing') {
      overall = 'red';
      if (topology === 'missing') {
        message = collector
          ? `helix-gateway and \`${collector}\` don't share a Docker network.`
          : 'helix-gateway isn\'t on any user network yet.';
        remediation = 'Re-attach via the Detected list above.';
      } else if (gatewayReceiver === 'unreachable') {
        message = 'helix-gateway\'s OTLP receiver isn\'t reachable on :4318.';
        remediation = 'The gateway is running but the receiver isn\'t listening — check Step 1 saved a valid YAML and the container restarted cleanly.';
      } else {
        message = `\`${collector}\`'s helix exporter is failing (failed +${exporterDetail?.failedDelta || 0} in 3s, sent +${exporterDetail?.sentDelta || 0}).`;
        remediation = 'The collector can\'t deliver to helix-gateway. Most common causes: DNS for "helix-gateway" doesn\'t resolve from the collector\'s network, or TLS/auth mismatched.';
      }
    } else if (gatewayReceiver === 'unknown' || topology === 'unknown') {
      overall = 'yellow';
      message = 'Network connection looks good but I couldn\'t verify the gateway receiver from this side.';
      remediation = 'You can continue to Verify; the Step 4 check will catch lingering issues.';
    }
    // Note: collector exporter status is appended as informational context
    // only — it never alone determines the verdict at Step 3.
    if (overall === 'green' && collector) {
      if (collectorExporter === 'ok') {
        message = `Network connection to \`${collector}\` is good, and its helix exporter is succeeding.`;
      } else if (collectorExporter === 'not-probed' || collectorExporter === 'unknown') {
        message += ' (Exporter status will be confirmed in Step 4.)';
      }
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
      configObj.service.telemetry.metrics = healedMetricsTelemetry();

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
        resource: { attributes: [
          { key: 'service.name', value: { stringValue: 'helix-gateway' } },
          { key: 'service.namespace', value: { stringValue: DIAGNOSTIC_NAMESPACE } },
        ] },
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

    const url = `${resolveGatewayOtlpBase()}/v1/traces`;

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

  // GET live metrics parsing.
  app.get('/api/diagnostics/metrics/live', async (req, res) => {
    try {
      const result = await fetchCounters();
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
    const url = `${resolveGatewayMetricsBase()}/metrics`;
    try {
      const response = await axios.get(url, { timeout: 2000 });
      const sumOf = (baseName) => sumPromCounter(response.data, baseName);
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
            timestamps: true,
          });
          const analysis = analyzeCollectorErrorLog(demuxLogBuffer(buf), Date.now());
          return analysis ? { container: name, ...analysis } : null;
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
    const url = `${resolveGatewayMetricsBase()}/metrics`;
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
      // Query collector's own metrics if available.
      const response = await axios.get(`${resolveGatewayMetricsBase()}/metrics`);
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
        const failedSignal = await checkExporterFailing();
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

  // POST probe Helix reachability with in-request credentials. Accepts
  // { endpoint, apiKey } in the body and delegates to runOtlpProbe. Used by
  // Step 1's Test Connection button to let users probe Helix with what they've
  // typed into the form, before saving and triggering a gateway recreate.
  app.post('/api/diagnostics/test-connection', async (req, res) => {
    const { endpoint, apiKey } = req.body || {};
    if (typeof endpoint !== 'string' || !/^https?:\/\/[^\s]+$/.test(endpoint)) {
      return res.status(400).json({ status: 'invalid-input', error: 'Invalid endpoint URL' });
    }
    if (typeof apiKey !== 'string' || !/^[^:]+::[^:]+::[^:]+$/.test(apiKey)) {
      return res.status(400).json({ status: 'invalid-input', error: 'API key must be three :: separated parts' });
    }
    try {
      // Strip trailing slash so the probe URL doesn't become https://foo//v1/traces
      const result = await runOtlpProbe(endpoint.replace(/\/$/, ''), apiKey);
      res.json(result);
    } catch (e) {
      res.status(500).json({ status: 'error', message: `Probe setup failed: ${e.message}` });
    }
  });
}

module.exports = { register, closeActiveLogProcesses, runOtlpProbe };
