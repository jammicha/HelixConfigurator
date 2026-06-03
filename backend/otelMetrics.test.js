import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import otelStoreModule from './otelStore.js';

const { OtelStore, extractMetricPoints, metricResourceKey } = otelStoreModule;

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
