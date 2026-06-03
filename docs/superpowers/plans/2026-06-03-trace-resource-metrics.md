# Per-trace resource metrics (CPU / memory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show CPU + memory utilization for a trace's service over a context window around the trace, in the trace detail drawer of the local OTel viewer.

**Architecture:** Fan the gateway's existing OTLP `metrics` pipeline out to the configurator (mirroring traces/logs), decode `process.*` runtime metrics into an in-memory ring buffer keyed by `(service.namespace, service.name)`, and join to a trace by that service identity over the trace's time window ± a context pad. A new "Resources" panel in the drawer fetches and renders the series with the existing `Sparkline`.

**Tech Stack:** Node 20 + Express, better-sqlite3 (store class only — metrics stay in-memory), Vitest, React 19 + TypeScript + Tailwind, OTLP/JSON.

**Spec:** [`docs/superpowers/specs/2026-06-03-trace-resource-metrics-design.md`](../specs/2026-06-03-trace-resource-metrics-design.md)

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `backend/otelStore.js` | OTLP metrics parsing + in-memory ring + join query | Modify: add `RESOURCE_METRIC_NAMES`, `metricResourceKey`, `extractMetricPoints`, metrics constants, ring init in constructor, `ingestMetricPoints`, `getResourceSeries`, exports |
| `backend/otelMetrics.test.js` | Unit tests for parser + ring + join | Create |
| `backend/routes/otlp.js` | `POST /api/otlp/metrics` receiver | Modify |
| `backend/index.js` | Raw-body middleware for the metrics ingest path | Modify (1 line) |
| `backend/routes/traces.js` | `GET /api/traces/:traceId/resources` query | Modify |
| `helix-otel-collector.yaml` | Fan the `metrics` pipeline to the local viewer | Modify |
| `frontend/src/components/otel-data/trace-detail/ResourcesPanel.tsx` | The Resources panel UI | Create |
| `frontend/src/components/otel-data/trace-detail/Waterfall.tsx` | Mount the panel at the summary/breakdown seam | Modify (2 spots) |

Metrics never touch SQLite — the ring lives on the `OtelStore` instance, so the store's self-heal/corruption path is untouched.

---

## Task 1: OTLP metrics parser (`extractMetricPoints`)

**Files:**
- Modify: `backend/otelStore.js`
- Test: `backend/otelMetrics.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/otelMetrics.test.js`:

```js
import { describe, it, expect } from 'vitest';
import otelStoreModule from './otelStore.js';

const { extractMetricPoints, metricResourceKey } = otelStoreModule;

// A realistic OTLP/JSON metrics payload: two runtime metrics we keep (a gauge
// and a sum) plus one histogram we must ignore, under one resource.
const SAMPLE = {
  resourceMetrics: [{
    resource: { attributes: [
      { key: 'service.name', value: { stringValue: 'cart' } },
      { key: 'service.namespace', value: { stringValue: 'shop' } },
    ] },
    scopeMetrics: [{
      metrics: [
        { name: 'process.cpu.utilization', gauge: { dataPoints: [
          { timeUnixNano: '1000000000', asDouble: 0.42 },
          { timeUnixNano: '2000000000', asDouble: 0.55 },
        ] } },
        { name: 'process.memory.usage', sum: { dataPoints: [
          { timeUnixNano: '1000000000', asInt: '104857600' },
        ] } },
        { name: 'http.server.duration', histogram: { dataPoints: [
          { timeUnixNano: '1000000000' },
        ] } },
      ],
    }],
  }],
};

describe('extractMetricPoints', () => {
  it('keeps only allowlisted process.* points, reads gauge+sum and asInt/asDouble', () => {
    const points = extractMetricPoints(SAMPLE);
    const key = metricResourceKey('shop', 'cart');

    // 2 cpu + 1 memory = 3; the histogram is dropped.
    expect(points).toHaveLength(3);
    expect(points.every(p => p.resourceKey === key)).toBe(true);

    const cpu = points.filter(p => p.metricName === 'process.cpu.utilization');
    expect(cpu.map(p => p.value)).toEqual([0.42, 0.55]);
    expect(cpu.map(p => p.tsNs)).toEqual([1_000_000_000, 2_000_000_000]);

    const mem = points.filter(p => p.metricName === 'process.memory.usage');
    expect(mem).toHaveLength(1);
    expect(mem[0].value).toBe(104857600);
  });

  it('returns [] for a body with no resourceMetrics', () => {
    expect(extractMetricPoints({})).toEqual([]);
    expect(extractMetricPoints(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run otelMetrics`
Expected: FAIL — `extractMetricPoints is not a function` (not yet exported).

- [ ] **Step 3: Add the constants + key helper**

In `backend/otelStore.js`, after the `SPARK_BUCKETS` constant (around line 70), add:

```js
// Resource metrics (CPU/mem per trace) — the small allowlist of OTLP runtime
// metric names the viewer joins to a trace. Kept narrow on purpose: high-volume
// app metrics shouldn't land in the in-memory ring. Add spellings here if a
// runtime emits an alternate semconv name.
const RESOURCE_METRIC_NAMES = new Set([
  'process.cpu.utilization', // gauge, 0..1 fraction
  'process.memory.usage',    // bytes (RSS)
]);
```

- [ ] **Step 4: Add `metricResourceKey` next to `flattenAttributes`**

In `backend/otelStore.js`, immediately after the `flattenAttributes` function (around line 112), add:

```js
// The join key between a trace and its resource metrics: service identity only,
// because service.name (+ namespace) is the one resource attribute a trace and
// an app-emitted metric reliably share in every environment (Docker, K8s, VM).
// NUL-separated so a namespace containing the service name can't collide.
const metricResourceKey = (namespace, service) =>
  `${namespace || ''}\u0000${service || 'unknown_service'}`;
```

- [ ] **Step 5: Add `extractMetricPoints` after `extractLogRecords`**

In `backend/otelStore.js`, find the end of `extractLogRecords` (it returns `out;` then `};`) and add immediately after it:

```js
// OTLP metrics body → flat normalized points for the in-memory ring. Only the
// RESOURCE_METRIC_NAMES allowlist is kept; gauge and sum data points are read
// (histograms/summaries ignored), values from asDouble or asInt. Mirrors
// extractSpans/extractLogRecords in shape and tolerance.
const extractMetricPoints = (body) => {
  const out = [];
  const resourceMetrics = body && body.resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return out;
  for (const rm of resourceMetrics) {
    const resourceAttrs = flattenAttributes(rm.resource && rm.resource.attributes);
    const serviceName = resourceAttrs['service.name'] || 'unknown_service';
    const serviceNamespace = resourceAttrs['service.namespace'] || null;
    const resourceKey = metricResourceKey(serviceNamespace, serviceName);
    const scopeMetrics = rm.scopeMetrics || rm.instrumentationLibraryMetrics || [];
    for (const sm of scopeMetrics) {
      const metrics = sm.metrics || [];
      for (const m of metrics) {
        if (!m || !RESOURCE_METRIC_NAMES.has(m.name)) continue;
        const dps = (m.gauge && m.gauge.dataPoints) || (m.sum && m.sum.dataPoints) || [];
        for (const dp of dps) {
          const tsNs = Number(dp.timeUnixNano || 0);
          if (!tsNs) continue;
          const value = dp.asDouble !== undefined ? dp.asDouble
            : dp.asInt !== undefined ? Number(dp.asInt)
            : undefined;
          if (value === undefined || !Number.isFinite(value)) continue;
          out.push({ resourceKey, metricName: m.name, tsNs, value });
        }
      }
    }
  }
  return out;
};
```

- [ ] **Step 6: Export the new symbols**

In `backend/otelStore.js`, the last line is:

```js
module.exports = { OtelStore, extractSpans, extractLogRecords, latencySparkline, TRACE_CAP, TRACE_LIST_MAX, TRACE_RETENTION_MS };
```

Replace it with:

```js
module.exports = { OtelStore, extractSpans, extractLogRecords, extractMetricPoints, metricResourceKey, latencySparkline, TRACE_CAP, TRACE_LIST_MAX, TRACE_RETENTION_MS };
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd backend && npx vitest run otelMetrics`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add backend/otelStore.js backend/otelMetrics.test.js
git commit -m "feat(otel-metrics): parse process.* OTLP metrics into normalized points"
```

---

## Task 2: In-memory ring + join query (store)

**Files:**
- Modify: `backend/otelStore.js`
- Test: `backend/otelMetrics.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `backend/otelMetrics.test.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { OtelStore } = otelStoreModule;

describe('OtelStore resource-metrics ring', () => {
  let tmpDir = null;
  let store = null;

  const newStore = (opts) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otelmetrics-'));
    store = new OtelStore({ dbPath: path.join(tmpDir, 'otel-store.db'), ...opts });
    return store;
  };
  // Seed a trace so getResourceSeries has a window + service identity to join on.
  const seedTrace = (startNs, endNs, ns = 'shop', svc = 'cart') => {
    store.ingestSpans([{
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: '',
      serviceName: svc, serviceNamespace: ns, containerName: null,
      name: 'GET /cart', kind: 2, startTimeNs: startNs, endTimeNs: endNs,
      durationMs: (endNs - startNs) / 1e6, statusCode: 1, statusMessage: '',
      attributes: {}, events: [],
    }]);
    return 'a'.repeat(32);
  };

  afterEach(() => {
    if (store) {
      try { store.stopMaintenance(); } catch { /* noop */ }
      try { store.db.close(); } catch { /* noop */ }
      store = null;
    }
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
  });

  it('slices to the context window, sorts, and reports peak + at-trace', () => {
    newStore({ metricsRetentionMs: 0 }); // disable age prune for fixed timestamps
    const startNs = 100e9, endNs = 100e9 + 5e6;
    const traceId = seedTrace(startNs, endNs);
    const key = metricResourceKey('shop', 'cart');
    store.ingestMetricPoints([
      { resourceKey: key, metricName: 'process.cpu.utilization', tsNs: 70e9, value: 0.3 },
      { resourceKey: key, metricName: 'process.cpu.utilization', tsNs: 100e9, value: 0.9 },
      { resourceKey: key, metricName: 'process.cpu.utilization', tsNs: 130e9, value: 0.5 },
      { resourceKey: key, metricName: 'process.cpu.utilization', tsNs: 5e9, value: 0.1 }, // outside ±90s window
      { resourceKey: key, metricName: 'process.memory.usage', tsNs: 100e9, value: 1e8 },
    ]);

    const r = store.getResourceSeries(traceId);
    expect(r).not.toBeNull();
    expect(r.empty).toBe(false);
    expect(r.window).toEqual({ startNs, endNs });
    expect(r.cpu.points.map(p => p.value)).toEqual([0.3, 0.9, 0.5]); // sorted, 5e9 excluded
    expect(r.cpu.peak).toBe(0.9);
    expect(r.cpu.atTrace).toBe(0.9); // last sample at/before endNs
    expect(r.memory.points).toHaveLength(1);
  });

  it('caps points per series, keeping the most recent', () => {
    newStore({ metricsRetentionMs: 0, metricsMaxPoints: 3 });
    const traceId = seedTrace(100e9, 100e9 + 5e6);
    const key = metricResourceKey('shop', 'cart');
    for (const [tsNs, value] of [[60e9, 0.1], [80e9, 0.2], [100e9, 0.3], [120e9, 0.4], [140e9, 0.5]]) {
      store.ingestMetricPoints([{ resourceKey: key, metricName: 'process.cpu.utilization', tsNs, value }]);
    }
    const r = store.getResourceSeries(traceId);
    expect(r.cpu.points.map(p => p.value)).toEqual([0.3, 0.4, 0.5]); // oldest two dropped
  });

  it('prunes points older than the retention window', () => {
    newStore({ metricsRetentionMs: 60_000 }); // 60s
    const nowMs = Date.now();
    const traceId = seedTrace(nowMs * 1e6 - 1e9, nowMs * 1e6);
    const key = metricResourceKey('shop', 'cart');
    store.ingestMetricPoints([
      { resourceKey: key, metricName: 'process.cpu.utilization', tsNs: (nowMs - 75_000) * 1e6, value: 0.1 }, // older than 60s
      { resourceKey: key, metricName: 'process.cpu.utilization', tsNs: nowMs * 1e6, value: 0.9 },
    ]);
    const r = store.getResourceSeries(traceId);
    expect(r.cpu.points.map(p => p.value)).toEqual([0.9]); // stale point pruned
  });

  it('returns null for an unknown trace and empty for a service with no metrics', () => {
    newStore({ metricsRetentionMs: 0 });
    expect(store.getResourceSeries('f'.repeat(32))).toBeNull();
    const traceId = seedTrace(100e9, 100e9 + 5e6);
    const r = store.getResourceSeries(traceId);
    expect(r.empty).toBe(true);
    expect(r.cpu.points).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run otelMetrics`
Expected: FAIL — `store.ingestMetricPoints is not a function`.

- [ ] **Step 3: Add metrics constants**

In `backend/otelStore.js`, directly below the `RESOURCE_METRIC_NAMES` block from Task 1, add:

```js
// Ring retention: drop points older than this (<=0 disables age pruning, used
// by tests). Default 1h — comfortably covers any trace still in the store.
const METRICS_RETENTION_MS = 60 * 60 * 1000;
// Per-series point cap (most-recent kept) and a defensive ceiling on distinct
// (namespace,service) series. Both bound memory regardless of producer volume.
const METRICS_MAX_POINTS_PER_SERIES = 2000;
const METRICS_MAX_SERIES = 1000;
// Context pad around a trace's window when slicing the series. Runtime metrics
// sample every ~10s while most traces are sub-second, so an exact-window slice
// would return <=1 point — pad to ~90s each side so the sparkline shows a real
// trend with the trace moment inside it.
const METRICS_CONTEXT_PAD_NS = 90 * 1e9;
```

- [ ] **Step 4: Initialize the ring in the constructor**

In `backend/otelStore.js`, the constructor signature (around line 229) is:

```js
  constructor({ dbPath, retentionMs, maxTraces } = {}) {
```

Replace it with:

```js
  constructor({ dbPath, retentionMs, maxTraces, metricsRetentionMs, metricsMaxPoints } = {}) {
```

Then, immediately after the line `this.maxTraces = Number.isFinite(maxTraces) && maxTraces > 0 ? maxTraces : TRACE_CAP;` (around line 237), add:

```js
    // Resource-metrics ring: Map<resourceKey, Map<metricName, {tsNs,value}[]>>.
    // In-memory only — never written to SQLite, so it can't affect the store's
    // self-heal/corruption path. Retention overridable per store (tests).
    this.metricsRetentionMs = Number.isFinite(metricsRetentionMs) ? metricsRetentionMs : METRICS_RETENTION_MS;
    this.metricsMaxPoints = Number.isFinite(metricsMaxPoints) && metricsMaxPoints > 0 ? metricsMaxPoints : METRICS_MAX_POINTS_PER_SERIES;
    this.metricsRing = new Map();
```

- [ ] **Step 5: Add `ingestMetricPoints` and `getResourceSeries`**

In `backend/otelStore.js`, add these two methods immediately before `getTrace(traceId) {` (around line 1173):

```js
  // Append normalized metric points (from extractMetricPoints) into the ring,
  // pruning each touched series by age + per-series cap. O(points); no I/O.
  ingestMetricPoints(points) {
    if (!Array.isArray(points) || points.length === 0) return;
    const cutoffNs = this.metricsRetentionMs > 0
      ? (Date.now() - this.metricsRetentionMs) * 1e6
      : null;
    for (const p of points) {
      if (!p || !p.resourceKey || !p.metricName) continue;
      if (!Number.isFinite(p.tsNs) || !Number.isFinite(p.value)) continue;
      let byMetric = this.metricsRing.get(p.resourceKey);
      if (!byMetric) { byMetric = new Map(); this.metricsRing.set(p.resourceKey, byMetric); }
      let arr = byMetric.get(p.metricName);
      if (!arr) { arr = []; byMetric.set(p.metricName, arr); }
      arr.push({ tsNs: p.tsNs, value: p.value });
      // Points arrive in roughly ascending time order; prune the stale prefix.
      if (cutoffNs !== null) {
        let i = 0;
        while (i < arr.length && arr[i].tsNs < cutoffNs) i++;
        if (i > 0) arr.splice(0, i);
      }
      if (arr.length > this.metricsMaxPoints) arr.splice(0, arr.length - this.metricsMaxPoints);
    }
    // Defensive series ceiling — drop the oldest-inserted series if exceeded.
    // Rarely hit (distinct services are few); guards against a pathological key.
    if (this.metricsRing.size > METRICS_MAX_SERIES) {
      const overflow = this.metricsRing.size - METRICS_MAX_SERIES;
      let n = 0;
      for (const k of this.metricsRing.keys()) {
        if (n++ >= overflow) break;
        this.metricsRing.delete(k);
      }
    }
  }

  // Join a trace to its service's CPU/memory series over the trace window plus a
  // context pad. Returns null if the trace is unknown, else { window, cpu,
  // memory, empty }. cpu/memory each carry sorted points + peak + at-trace value.
  getResourceSeries(traceId) {
    const summary = this.selectTraceSummary.get(traceId);
    if (!summary) return null;
    const startNs = summary.start_time_ns;
    const endNs = summary.end_time_ns;
    const fromNs = startNs - METRICS_CONTEXT_PAD_NS;
    const toNs = endNs + METRICS_CONTEXT_PAD_NS;
    const byMetric = this.metricsRing.get(metricResourceKey(summary.service_namespace, summary.service_name));
    const build = (name, unit) => {
      const raw = (byMetric && byMetric.get(name)) || [];
      const points = raw
        .filter(p => p.tsNs >= fromNs && p.tsNs <= toNs)
        .sort((a, b) => a.tsNs - b.tsNs)
        .map(p => ({ tsNs: p.tsNs, value: p.value }));
      let peak = null;
      let atTrace = null;
      for (const p of points) {
        if (peak === null || p.value > peak) peak = p.value;
        if (p.tsNs <= endNs) atTrace = p.value; // last sample at/before trace end
      }
      if (atTrace === null && points.length) atTrace = points[points.length - 1].value;
      return { points, peak, atTrace, unit };
    };
    const cpu = build('process.cpu.utilization', 'ratio');
    const memory = build('process.memory.usage', 'bytes');
    return {
      window: { startNs, endNs },
      cpu,
      memory,
      empty: cpu.points.length === 0 && memory.points.length === 0,
    };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run otelMetrics`
Expected: PASS (all `extractMetricPoints` + ring tests).

- [ ] **Step 7: Run the full backend suite (no regressions)**

Run: `cd backend && npx vitest run`
Expected: PASS — existing `otelStore.test.js` suites still green.

- [ ] **Step 8: Commit**

```bash
git add backend/otelStore.js backend/otelMetrics.test.js
git commit -m "feat(otel-metrics): in-memory ring + per-trace resource-series join"
```

---

## Task 3: `POST /api/otlp/metrics` receiver

**Files:**
- Modify: `backend/routes/otlp.js`
- Modify: `backend/index.js:30`

- [ ] **Step 1: Add the metrics route**

In `backend/routes/otlp.js`, the first import line is:

```js
const { extractSpans, extractLogRecords } = require('../otelStore');
```

Replace it with:

```js
const { extractSpans, extractLogRecords, extractMetricPoints } = require('../otelStore');
```

Then, immediately before the closing `}` of the `register` function (after the `/api/otlp/logs` handler), add:

```js
  // POST /api/otlp/metrics — receives OTLP metrics from helix-gateway's
  // metrics-pipeline fan-out. Only allowlisted process.* runtime metrics are
  // kept (extractMetricPoints), landing in an in-memory ring the trace drawer's
  // Resources panel queries by service identity. Public, like the other OTLP
  // routes — the gateway speaks plain HTTP from inside helix-bridge.
  app.post('/api/otlp/metrics', (req, res) => {
    try {
      const body = decodeOtlpBody(req);
      const points = extractMetricPoints(body);
      otelStore.ingestMetricPoints(points);
      res.json({});
    } catch (e) {
      console.error('OTLP metrics ingest error:', e.message);
      res.status(400).json({ error: e.message });
    }
  });
```

- [ ] **Step 2: Add the metrics path to the raw-body middleware**

In `backend/index.js`, line 30 is:

```js
app.use(['/api/otlp/traces', '/api/otlp/logs'], express.raw({
```

Replace it with:

```js
app.use(['/api/otlp/traces', '/api/otlp/logs', '/api/otlp/metrics'], express.raw({
```

- [ ] **Step 3: Smoke-test the endpoint against the dev backend**

Start the backend (separate shell): `cd backend && npm run dev`
Then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/api/otlp/metrics \
  -H 'Content-Type: application/json' \
  -d '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"cart"}}]},"scopeMetrics":[{"metrics":[{"name":"process.cpu.utilization","gauge":{"dataPoints":[{"timeUnixNano":"1717000000000000000","asDouble":0.5}]}}]}]}]}'
```

Expected: `200` (body `{}`). A malformed body returns `400` with `{ "error": ... }`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/otlp.js backend/index.js
git commit -m "feat(otel-metrics): add public /api/otlp/metrics ingest route"
```

---

## Task 4: `GET /api/traces/:traceId/resources` query

**Files:**
- Modify: `backend/routes/traces.js`

- [ ] **Step 1: Add the resources query route**

In `backend/routes/traces.js`, find the `/api/traces/:traceId` handler (around line 329-337). Immediately after its closing `});`, add:

```js
  // Per-trace resource utilization (CPU/mem) for the Resources panel. Joins the
  // trace's service to the in-memory metrics ring over the trace window plus a
  // context pad. 404 when the trace is unknown; `empty: true` when the service
  // emitted no process.* in the window (the panel renders an empty state).
  app.get('/api/traces/:traceId/resources', (req, res) => {
    const { traceId } = req.params;
    if (!/^[0-9a-fA-F]{1,64}$/.test(traceId)) {
      return res.status(400).json({ error: 'Invalid trace id' });
    }
    const resources = otelStore.getResourceSeries(traceId.toLowerCase());
    if (!resources) return res.status(404).json({ error: 'Not found' });
    res.json(resources);
  });
```

(Express matches `/api/traces/:traceId/resources` distinctly from `/api/traces/:traceId` — different segment count — so route order is fine.)

- [ ] **Step 2: Verify it serves through the dev backend**

With `cd backend && npm run dev` running, an unknown trace must 404:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/traces/ffffffffffffffffffffffffffffffff/resources
```

Expected: `404`. (A real traceId returns the `{ window, cpu, memory, empty }` JSON — exercised end-to-end in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add backend/routes/traces.js
git commit -m "feat(otel-metrics): add GET /api/traces/:traceId/resources"
```

---

## Task 5: Fan the gateway `metrics` pipeline to the viewer + validate the join (Phase 0 gate)

**Files:**
- Modify: `helix-otel-collector.yaml`

- [ ] **Step 1: Add the metrics endpoint to the local-viewer exporter**

In `helix-otel-collector.yaml`, the `otlphttp/helix_local_viewer` exporter lists `traces_endpoint` and `logs_endpoint`. Add a `metrics_endpoint` line directly below `logs_endpoint`:

```yaml
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
    encoding: json
    compression: none
    tls:
      insecure: true
    sending_queue:
      enabled: false
    retry_on_failure:
      enabled: false
```

- [ ] **Step 2: Add the exporter to the metrics pipeline**

In the same file, the `metrics` pipeline currently reads:

```yaml
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix]
```

Replace it with:

```yaml
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer]
```

- [ ] **Step 3: Restart the gateway and confirm it stays healthy**

```bash
docker compose restart helix-gateway
docker compose logs --tail=40 helix-gateway
```

Expected: collector starts cleanly (no `error decoding 'exporters'` / no config error), `Everything is ready` line present. If it crashes, the `metrics_endpoint`/pipeline edit has a typo — fix before continuing.

- [ ] **Step 4: VALIDATE THE JOIN on live data (the Phase 0 gate)**

Generate traffic (the OTel Demo / your app pointed at the gateway), let it run ~1 min, then ask the running configurator backend what landed in the ring for a real trace:

```bash
# Pick a recent trace id for an application service:
curl -s 'http://localhost:3001/api/traces?limit=5' | python3 -c 'import sys,json; [print(t["trace_id"], t["service_name"]) for t in json.load(sys.stdin)["traces"]]'
# Then query its resources (replace <TRACE_ID>):
curl -s http://localhost:3001/api/traces/<TRACE_ID>/resources | python3 -m json.tool
```

Decision:
- **`empty: false` with cpu/memory points** → the join works. `service.name` lined up. Proceed to Task 6. Note in Task 8 which attribute matched.
- **`empty: true`** → the app emits no `process.*`, OR the metric's `service.name` differs from the trace's. Confirm which by checking whether any metrics arrived at all (add a temporary `console.log` of `points.length` in the metrics route, or inspect gateway debug). If the app simply emits no runtime metrics, that is the documented trigger for the **`hostmetrics` fast-follow** — record the finding in Task 8 and still proceed to Task 6 (the panel's empty state is the correct UX until the fallback ships).
- **CPU value scale looks like 0–100 rather than 0–1** → note it; the panel assumes the semconv 0–1 ratio. If a runtime emits percent, add a normalization in `ResourcesPanel`'s `formatPct` (Task 6) and record it.

- [ ] **Step 5: Commit**

```bash
git add helix-otel-collector.yaml
git commit -m "feat(otel-metrics): fan the gateway metrics pipeline to the local viewer"
```

---

## Task 6: Resources panel component

**Files:**
- Create: `frontend/src/components/otel-data/trace-detail/ResourcesPanel.tsx`

- [ ] **Step 1: Create the component**

Create `frontend/src/components/otel-data/trace-detail/ResourcesPanel.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { Sparkline } from '../../Sparkline';

type MetricSeries = {
  points: { tsNs: number; value: number }[];
  peak: number | null;
  atTrace: number | null;
  unit: string;
};
type ResourcePayload = {
  window: { startNs: number; endNs: number };
  cpu: MetricSeries;
  memory: MetricSeries;
  empty: boolean;
};

const formatPct = (ratio: number | null): string =>
  ratio == null ? '—' : `${Math.round(ratio * 100)}%`;

const formatBytes = (n: number | null): string => {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

// One metric row: a label + headline (at-trace / peak) and a Sparkline of the
// surrounding context window. Reuses the shared Sparkline (no axis/markers).
const MetricRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  series: MetricSeries;
  stroke: string;
  format: (v: number | null) => string;
}> = ({ icon, label, series, stroke, format }) => (
  <div className="flex items-center justify-between gap-4 py-2">
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-gray-500">{icon}</span>
      <span className="text-sm text-gray-300">{label}</span>
    </div>
    <div className="flex items-center gap-4">
      <div className="text-right">
        <div className="text-sm font-semibold text-gray-100">{format(series.atTrace)}</div>
        <div className="text-tiny text-gray-500">peak {format(series.peak)}</div>
      </div>
      <Sparkline data={series.points.map(p => p.value)} stroke={stroke} width={140} height={32} filled />
    </div>
  </div>
);

// Resource utilization (CPU / memory) for the trace's service, sampled over a
// context window around the trace. Supplementary: it never blocks the drawer —
// loading and fetch failures render nothing, and a service with no process.*
// metrics renders a quiet empty state.
export const ResourcesPanel: React.FC<{ traceId: string }> = ({ traceId }) => {
  const [data, setData] = useState<ResourcePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setData(null);
    fetch(`/api/traces/${traceId}/resources`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setFailed(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [traceId]);

  if (loading || failed || !data) return null;

  return (
    <div className="mb-4 bg-gray-900 border border-gray-800 rounded p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-semibold text-gray-200">Resources</span>
        <span className="text-tiny text-gray-500">CPU &amp; memory around this trace (±90s)</span>
      </div>
      {data.empty ? (
        <div className="text-tiny text-gray-500 py-2">
          No resource metrics for this service in this window — enable runtime
          metrics (<code className="font-mono text-gray-400">process.*</code>) or
          the hostmetrics fallback.
        </div>
      ) : (
        <div className="divide-y divide-gray-800">
          <MetricRow
            icon={<Cpu className="w-4 h-4" />}
            label="CPU utilization"
            series={data.cpu}
            stroke="#3759d8"
            format={formatPct}
          />
          <MetricRow
            icon={<MemoryStick className="w-4 h-4" />}
            label="Memory usage"
            series={data.memory}
            stroke="#0aa4a4"
            format={formatBytes}
          />
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no errors). If `Cpu`/`MemoryStick` aren't exported by the installed `lucide-react`, swap to `Activity` / `Server` (already used in `Waterfall.tsx`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/otel-data/trace-detail/ResourcesPanel.tsx
git commit -m "feat(otel-metrics): Resources panel (CPU/mem sparklines) for the trace drawer"
```

---

## Task 7: Mount the panel in the trace drawer

**Files:**
- Modify: `frontend/src/components/otel-data/trace-detail/Waterfall.tsx`

- [ ] **Step 1: Import the panel**

In `frontend/src/components/otel-data/trace-detail/Waterfall.tsx`, the import block ends with:

```tsx
import { FlameView } from './FlameView';
```

Add directly below it:

```tsx
import { ResourcesPanel } from './ResourcesPanel';
```

- [ ] **Step 2: Render it at the summary/breakdown seam**

In the same file, find (around line 508):

```tsx
      {serviceBreakdown.length > 0 && (
        <ServiceBreakdownPanel
```

Replace those two lines with:

```tsx
      {/* Resource utilization for this trace's service — sampled around the
          trace window. Self-contained: fetches /api/traces/:id/resources. */}
      <ResourcesPanel traceId={summary.trace_id} />

      {serviceBreakdown.length > 0 && (
        <ServiceBreakdownPanel
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify in the browser (preview workflow)**

Ensure the dev servers are up (`cd backend && npm run dev`, `cd frontend && npm run dev`), generate traffic so metrics flow, open `/otel-data`, open a trace whose service emits `process.*`, and confirm the Resources panel renders two sparklines with at-trace + peak numbers (or the empty state for a service with no runtime metrics). Capture a screenshot for the handoff.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/otel-data/trace-detail/Waterfall.tsx
git commit -m "feat(otel-metrics): mount Resources panel in the trace detail drawer"
```

---

## Task 8: End-to-end verification + team write-up

**Files:**
- (No code) — produces the brief's step-5 deliverable.

- [ ] **Step 1: Full-stack smoke test**

```bash
docker compose up -d --build helix-configurator
docker compose restart helix-gateway
```

Drive traffic, open a slow trace in `/otel-data`, confirm the Resources panel shows CPU/memory around the trace. Re-run `cd backend && npx vitest run` — all green.

- [ ] **Step 2: Write the source recommendation + join finding**

Append a short "Findings" section to the spec (`docs/superpowers/specs/2026-06-03-trace-resource-metrics-design.md`) capturing, from Task 5: which resource attribute the join used (`service.name`/`service.namespace`), whether the demo app emitted `process.*`, the CPU value scale (0–1 vs 0–100), and the explicit A-vs-B recommendation for the team (primary = app `process.*`; fallback = `hostmetrics` where coverage is thin). This closes the brief's "research the best product fit" ask.

- [ ] **Step 3: Commit (docs are gitignored — note only)**

The spec lives under the gitignored `docs/` tree (local-only by repo convention). No commit needed; it's a working note. If the team wants it tracked, `git add -f` it deliberately.

---

## Self-review notes

- **Spec coverage:** ingestion path (Tasks 3–5), source-agnostic ring store (Task 2), `service.name` join (Task 2), Resources panel + empty state (Tasks 6–7), Phase-0 join validation gate (Task 5 Step 4), unit tests (Tasks 1–2), write-up (Task 8). Fast-follows (hostmetrics, Helix push, badge, filter, overlay, persistence) intentionally absent.
- **Naming consistency:** `metricResourceKey`, `extractMetricPoints`, `ingestMetricPoints`, `getResourceSeries`, and the `{ window, cpu, memory, empty }` / `{ points, peak, atTrace, unit }` shapes match across store, route, and component.
- **Context pad (90s):** introduced in Task 2 and surfaced in the panel copy and the spec (kept in sync); replaces the spec's original "few seconds" once the sample-interval reality is accounted for.
