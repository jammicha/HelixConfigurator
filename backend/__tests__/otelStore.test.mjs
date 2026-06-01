import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// otelStore.js is CommonJS (module.exports). createRequire bridges to it
// from this .mjs test file so we don't have to rewrite the source.
const require = createRequire(import.meta.url);
const { OtelStore, extractSpans, latencySparkline } = require('../otelStore');
const Database = require('better-sqlite3');

const makeSpan = (overrides = {}) => {
  const start = overrides.startTimeNs ?? 1_000_000_000;
  const end = overrides.endTimeNs ?? start + 100_000_000;
  return {
    traceId: 't1',
    spanId: 's1',
    parentSpanId: '',
    serviceName: 'customer-app',
    name: 'op',
    kind: 1,
    startTimeNs: start,
    endTimeNs: end,
    durationMs: (end - start) / 1e6,
    statusCode: 0,
    statusMessage: '',
    attributes: {},
    events: [],
    ...overrides,
  };
};

describe('OtelStore', () => {
  let store;

  beforeEach(() => {
    // Fake timers prevent the maintenance setInterval/setTimeout from firing
    // and keeping the test process alive after db.close().
    vi.useFakeTimers();
    store = new OtelStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.stopMaintenance();
    store.db.close();
    vi.useRealTimers();
  });

  describe('count-ceiling eviction', () => {
    it('keeps the newest maxTraces, evicting oldest first', () => {
      // Dedicated store with a tiny ceiling and time eviction off, so this
      // exercises the count safety net directly (the prod ceiling is 100k).
      const cap = new OtelStore({ dbPath: ':memory:', maxTraces: 50, retentionMs: 0 });
      cap.stopMaintenance();
      const ceiling = 50;
      const overflow = 20;
      const total = ceiling + overflow;
      const id = (i) => `t${String(i).padStart(6, '0')}`;
      for (let i = 0; i < total; i++) {
        // Advance the clock so received_at strictly increases — eviction orders
        // by received_at ASC and ties are not guaranteed stable.
        vi.setSystemTime(Date.now() + 1);
        cap.ingestSpans([makeSpan({ traceId: id(i), spanId: `s${i}` })]);
      }
      expect(cap.countTraces.get().n).toBe(ceiling);
      // Oldest `overflow` evicted; newest `ceiling` retained.
      expect(cap.getTrace(id(0))).toBeNull();
      expect(cap.getTrace(id(overflow - 1))).toBeNull();
      expect(cap.getTrace(id(overflow))).not.toBeNull();
      expect(cap.getTrace(id(total - 1))).not.toBeNull();
      cap.db.close();
    });
  });

  describe('time-based retention', () => {
    it('evicts traces older than the horizon, with their spans + errors', () => {
      const ret = new OtelStore({ dbPath: ':memory:', retentionMs: 60 * 60 * 1000 }); // 1h
      ret.stopMaintenance();
      const t0 = Date.now();
      // A trace from 2h ago — beyond the 1h horizon — with a child error span.
      vi.setSystemTime(t0 - 2 * 60 * 60 * 1000);
      ret.ingestSpans([
        makeSpan({ traceId: 'old', spanId: 'os', serviceName: 'app', name: 'op' }),
        makeSpan({ traceId: 'old', spanId: 'oc', parentSpanId: 'os', serviceName: 'app', name: 'boom', statusCode: 2, events: [{ name: 'exception', timeUnixNano: 1, attributes: { 'exception.type': 'E', 'exception.message': 'x' } }] }),
      ]);
      // Back to now: the next ingest triggers the age sweep.
      vi.setSystemTime(t0);
      ret.ingestSpans([makeSpan({ traceId: 'fresh', spanId: 'fs', serviceName: 'app', name: 'op' })]);
      expect(ret.getTrace('old')).toBeNull();        // aged out
      expect(ret.getTrace('fresh')).not.toBeNull();  // within horizon
      // Cascade: the old trace's spans + error rows are gone too.
      expect(ret.db.prepare('SELECT COUNT(*) c FROM spans WHERE trace_id = ?').get('old').c).toBe(0);
      expect(ret.db.prepare('SELECT COUNT(*) c FROM span_errors WHERE trace_id = ?').get('old').c).toBe(0);
      ret.db.close();
    });

    it('retentionMs <= 0 disables time eviction (count ceiling only)', () => {
      const ret = new OtelStore({ dbPath: ':memory:', retentionMs: 0 });
      ret.stopMaintenance();
      const t0 = Date.now();
      vi.setSystemTime(t0 - 100 * 60 * 60 * 1000); // 100h ago
      ret.ingestSpans([makeSpan({ traceId: 'ancient', spanId: 'a', serviceName: 'app', name: 'op' })]);
      vi.setSystemTime(t0);
      ret.ingestSpans([makeSpan({ traceId: 'now', spanId: 'b', serviceName: 'app', name: 'op' })]);
      expect(ret.getTrace('ancient')).not.toBeNull(); // kept — no time eviction
      ret.db.close();
    });
  });

  describe('pragmas', () => {
    it('opens with incremental auto_vacuum', () => {
      expect(store.db.pragma('auto_vacuum', { simple: true })).toBe(2); // INCREMENTAL
    });
    it('uses in-memory temp store and a 16 MB page cache', () => {
      expect(store.db.pragma('temp_store', { simple: true })).toBe(2);     // MEMORY
      expect(store.db.pragma('cache_size', { simple: true })).toBe(-16000); // ~16 MB
    });
  });

  describe('recomputeTrace root resolution', () => {
    it('picks the earliest root consistently on a multi-root trace', () => {
      const t0 = 1_000_000_000;
      store.ingestSpans([
        // inserted first, but LATER start time
        makeSpan({ traceId: 'multi', spanId: 'b', parentSpanId: '', serviceName: 'svc-b', name: 'op-b', startTimeNs: t0 + 5_000_000, endTimeNs: t0 + 8_000_000 }),
        // inserted second, but EARLIER start time → the true root
        makeSpan({ traceId: 'multi', spanId: 'a', parentSpanId: '', serviceName: 'svc-a', name: 'op-a', startTimeNs: t0, endTimeNs: t0 + 4_000_000 }),
      ]);
      const row = store.db.prepare('SELECT service_name, root_operation FROM traces WHERE trace_id = ?').get('multi');
      expect(row.service_name).toBe('svc-a');   // earliest root...
      expect(row.root_operation).toBe('op-a');  // ...and the SAME span (consistent, not mixed)
    });

    it('treats a dangling-parent span as the root even when a child starts earlier', () => {
      const t0 = 1_000_000_000;
      store.ingestSpans([
        // the real root's parent was never ingested (dangling) — and it starts LAST
        makeSpan({ traceId: 'orphan', spanId: 'root', parentSpanId: 'never-ingested', serviceName: 'svc-root', name: 'op-root', startTimeNs: t0 + 10_000_000, endTimeNs: t0 + 20_000_000 }),
        // an in-trace child that starts EARLIER than the root
        makeSpan({ traceId: 'orphan', spanId: 'child', parentSpanId: 'root', serviceName: 'svc-child', name: 'op-child', startTimeNs: t0, endTimeNs: t0 + 3_000_000 }),
      ]);
      const row = store.db.prepare('SELECT service_name, root_operation FROM traces WHERE trace_id = ?').get('orphan');
      // The dangling-parent span is the root — not the earlier-starting child.
      expect(row.service_name).toBe('svc-root');
      expect(row.root_operation).toBe('op-root');
    });

    it('has_error reflects the root/entry span outcome, not handled downstream errors', () => {
      const t0 = 1_000_000_000;
      store.ingestSpans([
        // OK root (the request succeeded)...
        makeSpan({ traceId: 'okroot', spanId: 'root', parentSpanId: '', serviceName: 'frontend', name: 'Dispatch', startTimeNs: t0, endTimeNs: t0 + 9_000_000, statusCode: 0 }),
        // ...over a retried downstream failure (e.g. a Redis flake that recovers).
        makeSpan({ traceId: 'okroot', spanId: 'child', parentSpanId: 'root', serviceName: 'driver', name: 'Fetch Driver Profile', startTimeNs: t0 + 1_000_000, endTimeNs: t0 + 4_000_000, statusCode: 2, events: [{ name: 'exception', timeUnixNano: t0, attributes: { 'exception.type': 'redis timeout' } }] }),
      ]);
      expect(store.db.prepare('SELECT has_error FROM traces WHERE trace_id = ?').get('okroot').has_error).toBe(0);
      // The handled downstream error is still recorded — it drives error_count / the badge.
      expect(store.db.prepare('SELECT COUNT(*) c FROM span_errors WHERE trace_id = ?').get('okroot').c).toBeGreaterThan(0);
    });

    it('has_error is set when the root/entry span itself failed', () => {
      const t0 = 1_000_000_000;
      store.ingestSpans([
        makeSpan({ traceId: 'rootfail', spanId: 'root', parentSpanId: '', serviceName: 'frontend', name: 'Dispatch', startTimeNs: t0, endTimeNs: t0 + 5_000_000, statusCode: 2 }),
      ]);
      expect(store.db.prepare('SELECT has_error FROM traces WHERE trace_id = ?').get('rootfail').has_error).toBe(1);
    });

    it('_reconcileHasError corrects rows left over from the old trace-wide rule', () => {
      const t0 = 1_000_000_000;
      store.ingestSpans([
        makeSpan({ traceId: 'legacy', spanId: 'root', parentSpanId: '', serviceName: 'frontend', name: 'Dispatch', startTimeNs: t0, endTimeNs: t0 + 5_000_000, statusCode: 0 }),
        makeSpan({ traceId: 'legacy', spanId: 'child', parentSpanId: 'root', serviceName: 'driver', name: 'Fetch Driver Profile', startTimeNs: t0 + 1_000_000, endTimeNs: t0 + 2_000_000, statusCode: 2 }),
      ]);
      // Simulate a row written under the old trace-wide rule, then reconcile.
      store.db.prepare('UPDATE traces SET has_error = 1 WHERE trace_id = ?').run('legacy');
      store._reconcileHasError();
      expect(store.db.prepare('SELECT has_error FROM traces WHERE trace_id = ?').get('legacy').has_error).toBe(0);
    });
  });

  describe('incremental vacuum maintenance', () => {
    it('skips reclaim when ingest is recent (quiet-time gate)', () => {
      store.ingestSpans([makeSpan({ traceId: 'tq', spanId: 'sq' })]); // sets _lastIngestAt = now
      const spy = vi.spyOn(store.db, 'pragma');
      store._maybeIncrementalVacuum();
      const ranIncVac = spy.mock.calls.some(([arg]) => String(arg).includes('incremental_vacuum'));
      expect(ranIncVac).toBe(false);
      spy.mockRestore();
    });

    it('attempts reclaim once ingest has been quiet', () => {
      store.ingestSpans([makeSpan({ traceId: 'tq2', spanId: 'sq2' })]);
      store._lastIngestAt = Date.now() - 10_000; // older than the quiet window
      const spy = vi.spyOn(store.db, 'pragma');
      store._maybeIncrementalVacuum();
      const checkedFreelist = spy.mock.calls.some(([arg]) => String(arg).includes('freelist_count'));
      expect(checkedFreelist).toBe(true);
      spy.mockRestore();
    });
  });

  describe('listTraces participant filter', () => {
    it('includes traces with at least one non-internal participating span', () => {
      store.ingestSpans([
        makeSpan({ traceId: 't1', spanId: 'root', serviceName: 'helix-gateway', name: 'ingest' }),
        makeSpan({ traceId: 't1', spanId: 'child', parentSpanId: 'root', serviceName: 'customer-app', name: 'handle' }),
      ]);
      const traces = store.listTraces({});
      expect(traces).toHaveLength(1);
      expect(traces[0].trace_id).toBe('t1');
    });

    it('excludes traces composed entirely of internal services', () => {
      store.ingestSpans([
        makeSpan({ traceId: 't2', spanId: 'a', serviceName: 'helix-gateway', name: 'verify' }),
        makeSpan({ traceId: 't2', spanId: 'b', parentSpanId: 'a', serviceName: 'helix-configurator', name: 'noop' }),
      ]);
      expect(store.listTraces({})).toHaveLength(0);
    });
  });

  describe('listServices', () => {
    it('returns services without time-windowing', () => {
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
      store.ingestSpans([makeSpan({ traceId: 'told', spanId: 'a', serviceName: 'svc-from-2020' })]);
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const names = store.listServices().map(s => s.name);
      expect(names).toContain('svc-from-2020');
    });

    it('excludes internal services', () => {
      store.ingestSpans([makeSpan({ traceId: 't1', spanId: 'a', serviceName: 'helix-gateway' })]);
      store.ingestSpans([makeSpan({ traceId: 't2', spanId: 'b', serviceName: 'customer-app' })]);
      const names = store.listServices().map(s => s.name);
      expect(names).not.toContain('helix-gateway');
      expect(names).toContain('customer-app');
    });
  });

  describe('SSE trace emission', () => {
    it('tags emitted summary with participating_services across the whole trace', () => {
      const seen = [];
      store.events.on('trace', (s) => seen.push(s));
      store.ingestSpans([
        makeSpan({ traceId: 't1', spanId: 'root', serviceName: 'frontend' }),
        makeSpan({ traceId: 't1', spanId: 'child', parentSpanId: 'root', serviceName: 'backend' }),
      ]);
      expect(seen).toHaveLength(1);
      expect(seen[0].trace_id).toBe('t1');
      expect(seen[0].participating_services.sort()).toEqual(['backend', 'frontend']);
    });

    it('skips emission for all-internal traces', () => {
      const seen = [];
      store.events.on('trace', (s) => seen.push(s));
      store.ingestSpans([
        makeSpan({ traceId: 't1', spanId: 'a', serviceName: 'helix-gateway' }),
        makeSpan({ traceId: 't1', spanId: 'b', parentSpanId: 'a', serviceName: 'helix-configurator' }),
      ]);
      expect(seen).toHaveLength(0);
    });
  });

  describe('slow-threshold plumbing', () => {
    const ingestFastAndSlow = () => {
      store.ingestSpans([makeSpan({
        traceId: 't_fast', spanId: 'a',
        startTimeNs: 1_000_000_000, endTimeNs: 1_800_000_000, // 800ms
        serviceName: 'app', name: 'op',
      })]);
      store.ingestSpans([makeSpan({
        traceId: 't_slow', spanId: 'b',
        startTimeNs: 1_000_000_000, endTimeNs: 2_200_000_000, // 1200ms
        serviceName: 'app', name: 'op',
      })]);
    };

    it('tracesHistogram classifies buckets by slowThresholdMs', () => {
      ingestFastAndSlow();
      const now = Date.now();
      const range = { sinceMs: now - 60_000, untilMs: now + 60_000, buckets: 10 };

      const h1000 = store.tracesHistogram({ ...range, slowThresholdMs: 1000 });
      const slow1000 = h1000.buckets.reduce((a, b) => a + b.slow, 0);
      const ok1000 = h1000.buckets.reduce((a, b) => a + b.ok, 0);
      expect(slow1000).toBe(1);
      expect(ok1000).toBe(1);

      const h500 = store.tracesHistogram({ ...range, slowThresholdMs: 500 });
      const slow500 = h500.buckets.reduce((a, b) => a + b.slow, 0);
      expect(slow500).toBe(2);
    });

    it('listOperations counts slow per operation by slowThresholdMs', () => {
      ingestFastAndSlow();
      const ops1000 = store.listOperations({ slowThresholdMs: 1000 });
      expect(ops1000).toHaveLength(1);
      expect(ops1000[0].slow_count).toBe(1);

      const ops500 = store.listOperations({ slowThresholdMs: 500 });
      expect(ops500[0].slow_count).toBe(2);
    });

    it('listOperations computes Apdex score per operation by slowThresholdMs', () => {
      // SLOW_MS = 1000
      // 1. Satisfied: duration <= 1000 (e.g. 800ms) and no error
      store.ingestSpans([makeSpan({ traceId: 't_sat', spanId: 'a', serviceName: 'app', name: 'op', startTimeNs: 1_000_000_000, endTimeNs: 1_800_000_000 })]); // 800ms
      // 2. Tolerating: 1000 < duration <= 4000 (e.g. 1500ms) and no error
      store.ingestSpans([makeSpan({ traceId: 't_tol', spanId: 'b', serviceName: 'app', name: 'op', startTimeNs: 1_000_000_000, endTimeNs: 2_500_000_000 })]); // 1500ms
      // 3. Frustrated: duration > 4000 (e.g. 4500ms) and no error
      store.ingestSpans([makeSpan({ traceId: 't_frust_slow', spanId: 'c', serviceName: 'app', name: 'op', startTimeNs: 1_000_000_000, endTimeNs: 5_500_000_000 })]); // 4500ms
      // 4. Frustrated: has error regardless of duration (e.g. 500ms, has error)
      store.ingestSpans([makeSpan({ traceId: 't_frust_err', spanId: 'd', serviceName: 'app', name: 'op', startTimeNs: 1_000_000_000, endTimeNs: 1_500_000_000, statusCode: 2 })]); // 500ms, errored

      const ops = store.listOperations({ slowThresholdMs: 1000 });
      const op = ops.find(o => o.service_name === 'app' && o.root_operation === 'op');
      expect(op).toBeDefined();
      expect(op.trace_count).toBe(4);
      // Apdex = (Satisfied + 0.5 * Tolerating) / Total = (1 + 0.5 * 1) / 4 = 1.5 / 4 = 0.375
      expect(op.apdex).toBe(0.375);
    });

    it('respects an active service filter (participant scope, like listTraces)', () => {
      // Trace A: rooted at checkout, with a cart-api child (cart-api is a
      // participant, never a root). Trace B: an unrelated search trace.
      store.ingestSpans([
        makeSpan({ traceId: 'ta', spanId: 'ra', parentSpanId: '', serviceName: 'checkout', name: 'POST /checkout' }),
        makeSpan({ traceId: 'ta', spanId: 'ca', parentSpanId: 'ra', serviceName: 'cart-api', name: 'GET /cart' }),
      ]);
      store.ingestSpans([
        makeSpan({ traceId: 'tb', spanId: 'rb', parentSpanId: '', serviceName: 'search', name: 'GET /search' }),
      ]);
      // Unfiltered: both trace-root operations are present.
      const all = store.listOperations();
      expect(all.some(o => o.root_operation === 'POST /checkout')).toBe(true);
      expect(all.some(o => o.root_operation === 'GET /search')).toBe(true);
      // Filtered to a participating (non-root) service: only the trace it took
      // part in stays in scope; the unrelated search trace drops out.
      const cart = store.listOperations({ service: 'cart-api' });
      expect(cart.some(o => o.root_operation === 'POST /checkout')).toBe(true);
      expect(cart.some(o => o.root_operation === 'GET /search')).toBe(false);
      // A service that appears in no trace yields nothing.
      expect(store.listOperations({ service: 'no-such-svc' })).toHaveLength(0);
    });
  });

  describe('default ("All" range) window', () => {
    it('overview() with no window spans from the earliest trace, not just last hour', () => {
      const t0 = Date.now();
      // Earliest trace landed ~2h ago — older than the legacy now-1h default.
      vi.setSystemTime(t0 - 2 * 60 * 60 * 1000);
      store.ingestSpans([makeSpan({ traceId: 'old', spanId: 's', serviceName: 'app', name: 'op' })]);
      vi.setSystemTime(t0);
      const ov = store.overview({});
      // Window start reaches back to the earliest trace rather than stopping at
      // now-1h, so "All" actually covers all retained data.
      expect(ov.windowMs.start).toBe(t0 - 2 * 60 * 60 * 1000);
      expect(ov.windowMs.end).toBe(t0);
    });
  });

  describe('listOperationLatencies', () => {
    // Five checkout traces: a traffic-generator root (POST /checkout) plus a
    // cart-api child (GET /cart/items). cart-api is never a trace root — the
    // demo shape where the trace-root rollup (listOperations) has no cart-api
    // entry, which is exactly why outlier flagging needs this span-level rollup.
    // Durations are set via start/end so the stored duration_ms equals `d`.
    const seedCheckoutTraces = (cartDurations) => {
      const startNs = 1_000_000_000;
      cartDurations.forEach((d, i) => {
        store.ingestSpans([
          makeSpan({ traceId: `tr${i}`, spanId: `root${i}`, parentSpanId: '', serviceName: 'traffic-generator', name: 'POST /checkout', startTimeNs: startNs, endTimeNs: startNs + 500_000_000 }),
          makeSpan({ traceId: `tr${i}`, spanId: `cart${i}`, parentSpanId: `root${i}`, serviceName: 'cart-api', name: 'GET /cart/items', startTimeNs: startNs, endTimeNs: startNs + d * 1_000_000 }),
        ]);
      });
    };

    it('produces a p95 baseline for a participating (non-root) service operation', () => {
      seedCheckoutTraces([10, 20, 30, 40, 1000]);
      const cart = store.listOperationLatencies()
        .find(o => o.service_name === 'cart-api' && o.operation === 'GET /cart/items');
      expect(cart).toBeDefined();
      expect(cart.count).toBe(5);
      // Nearest-rank p95, same formula as listOperations: idx = floor(5*0.95)=4.
      expect(cart.p95_ms).toBe(1000);
      expect(cart.p50_ms).toBe(30);
    });

    it('covers an operation the trace-root rollup misses (the outlier bug)', () => {
      seedCheckoutTraces([10, 20, 30, 40, 1000]);
      expect(store.listOperations().some(o => o.service_name === 'cart-api')).toBe(false);
      expect(store.listOperationLatencies().some(o => o.service_name === 'cart-api' && o.operation === 'GET /cart/items')).toBe(true);
    });

    it('still includes trace-root operations (root spans are spans too)', () => {
      seedCheckoutTraces([10, 20, 30]);
      const root = store.listOperationLatencies()
        .find(o => o.service_name === 'traffic-generator' && o.operation === 'POST /checkout');
      expect(root).toBeDefined();
      expect(root.count).toBe(3);
    });

    it('honors the time window via the owning trace received_at (spans carry none)', () => {
      seedCheckoutTraces([10, 20, 30]);
      expect(store.listOperationLatencies({ sinceMs: Date.now() + 1_000_000 })).toEqual([]);
      expect(store.listOperationLatencies().length).toBeGreaterThan(0);
    });

    it('scopes to a namespace via trace participation', () => {
      store.ingestSpans([{
        ...makeSpan({ traceId: 'tprod', spanId: 'p', serviceName: 'cart-api', name: 'GET /cart/items' }),
        serviceNamespace: 'prod',
      }]);
      store.ingestSpans([{
        ...makeSpan({ traceId: 'tstage', spanId: 's', serviceName: 'cart-api', name: 'GET /cart/items' }),
        serviceNamespace: 'staging',
      }]);
      const prod = store.listOperationLatencies({ namespace: 'prod' });
      expect(prod).toHaveLength(1);
      expect(prod[0]).toMatchObject({ service_name: 'cart-api', operation: 'GET /cart/items', count: 1 });
    });

    it('returns an empty list for an empty store', () => {
      expect(store.listOperationLatencies()).toEqual([]);
    });
  });

  describe('serviceMap', () => {
    const seedMapSpans = () => {
      store.ingestSpans([
        { ...makeSpan({ traceId: 'tprod', spanId: 'root-p', serviceName: 'frontend' }), serviceNamespace: 'prod', containerName: 'fe-container' },
        { ...makeSpan({ traceId: 'tprod', spanId: 'child-p', parentSpanId: 'root-p', serviceName: 'backend' }), serviceNamespace: 'prod', containerName: 'be-container' },
        { ...makeSpan({ traceId: 'tstage', spanId: 'root-s', serviceName: 'frontend' }), serviceNamespace: 'staging', containerName: 'fe-container' },
        { ...makeSpan({ traceId: 'tstage', spanId: 'child-s', parentSpanId: 'root-s', serviceName: 'backend' }), serviceNamespace: 'staging', containerName: 'be-container' },
      ]);
    };

    it('returns nodes and edges without filtering', () => {
      seedMapSpans();
      const map = store.serviceMap();
      expect(map.nodes.map(n => n.name).sort()).toEqual(['backend', 'frontend']);
      expect(map.edges).toHaveLength(1);
      expect(map.edges[0]).toMatchObject({ source: 'frontend', target: 'backend', callCount: 2 });
    });

    it('honors the namespace filter', () => {
      seedMapSpans();
      const map = store.serviceMap({ namespace: 'prod' });
      expect(map.nodes.find(n => n.name === 'frontend').traceCount).toBe(1);
      expect(map.edges[0]).toMatchObject({ source: 'frontend', target: 'backend', callCount: 1 });
    });

    it('honors the container filter', () => {
      seedMapSpans();
      const map = store.serviceMap({ container: 'fe-container' });
      expect(map.nodes.map(n => n.name).sort()).toEqual(['backend', 'frontend']);
      // Both traces include 'fe-container' (on frontend span)
      expect(map.edges[0].callCount).toBe(2);
    });

    it('honors the service filter', () => {
      seedMapSpans();
      // Only traces that participate in 'backend' service
      const map = store.serviceMap({ service: 'backend' });
      expect(map.nodes.map(n => n.name).sort()).toEqual(['backend', 'frontend']);
      expect(map.edges[0].callCount).toBe(2);
    });
  });

  describe('failing operation (listTraces)', () => {
    // start_time offset helper (ns from a fixed base) so "latest started" is
    // unambiguous across spans within a trace.
    const ns = (ms) => 1_000_000_000 + ms * 1_000_000;
    const excEvent = (type, atMs) => ({
      name: 'exception',
      timeUnixNano: String(ns(atMs)),
      attributes: { 'exception.type': type, 'exception.message': `${type} boom` },
    });

    it('names the latest-started exception-bearing span as the failing operation', () => {
      // OK root → status-only error (cascade) → deeper exception-bearing error,
      // started latest. deriveProbableCause picks the exception span; so do we.
      store.ingestSpans([
        makeSpan({ traceId: 't1', spanId: 'root', parentSpanId: '', serviceName: 'frontend', name: 'Request Ride', startTimeNs: ns(0), endTimeNs: ns(300), statusCode: 0 }),
        makeSpan({ traceId: 't1', spanId: 'mid', parentSpanId: 'root', serviceName: 'driver-svc', name: 'GET /dispatch', startTimeNs: ns(10), endTimeNs: ns(280), statusCode: 2, statusMessage: 'downstream error' }),
        makeSpan({ traceId: 't1', spanId: 'deep', parentSpanId: 'mid', serviceName: 'mysql', name: 'SELECT drivers', startTimeNs: ns(20), endTimeNs: ns(260), statusCode: 2, events: [excEvent('psycopg2.OperationalError', 260)] }),
      ]);
      const [row] = store.listTraces({});
      expect(row.failing_operation).toBe('SELECT drivers');
      expect(row.failing_service).toBe('mysql');
    });

    it('falls back to the latest-started error span when no exception events exist', () => {
      store.ingestSpans([
        makeSpan({ traceId: 't2', spanId: 'root', parentSpanId: '', serviceName: 'frontend', name: 'Request Ride', startTimeNs: ns(0), endTimeNs: ns(300), statusCode: 0 }),
        makeSpan({ traceId: 't2', spanId: 'early', parentSpanId: 'root', serviceName: 'driver-svc', name: 'GET /dispatch', startTimeNs: ns(10), endTimeNs: ns(120), statusCode: 2, statusMessage: 'err' }),
        makeSpan({ traceId: 't2', spanId: 'late', parentSpanId: 'root', serviceName: 'customer', name: 'SELECT customer', startTimeNs: ns(50), endTimeNs: ns(200), statusCode: 2, statusMessage: 'err' }),
      ]);
      const [row] = store.listTraces({});
      expect(row.failing_operation).toBe('SELECT customer');
      expect(row.failing_service).toBe('customer');
    });

    it('prefers the exception-bearing span even when a status-only error starts later', () => {
      store.ingestSpans([
        makeSpan({ traceId: 't4', spanId: 'root', parentSpanId: '', serviceName: 'frontend', name: 'Request Ride', startTimeNs: ns(0), endTimeNs: ns(300), statusCode: 0 }),
        makeSpan({ traceId: 't4', spanId: 'exc', parentSpanId: 'root', serviceName: 'mysql', name: 'SELECT drivers', startTimeNs: ns(20), endTimeNs: ns(100), statusCode: 2, events: [excEvent('psycopg2.OperationalError', 100)] }),
        makeSpan({ traceId: 't4', spanId: 'cascade', parentSpanId: 'root', serviceName: 'cart-api', name: 'POST /cart', startTimeNs: ns(200), endTimeNs: ns(260), statusCode: 2, statusMessage: 'cascade' }),
      ]);
      const [row] = store.listTraces({});
      expect(row.failing_operation).toBe('SELECT drivers');
      expect(row.failing_service).toBe('mysql');
    });

    it('leaves failing_operation/service null when the trace has no errors', () => {
      store.ingestSpans([
        makeSpan({ traceId: 't3', spanId: 'root', parentSpanId: '', serviceName: 'frontend', name: 'Request Ride', statusCode: 0 }),
        makeSpan({ traceId: 't3', spanId: 'child', parentSpanId: 'root', serviceName: 'mysql', name: 'SELECT drivers', statusCode: 0 }),
      ]);
      const [row] = store.listTraces({});
      expect(row.failing_operation).toBeNull();
      expect(row.failing_service).toBeNull();
    });
  });

});

const buildSpans = (n, traceId) => Array.from({ length: n }, (_, i) => makeSpan({
  traceId, spanId: `${traceId}-${i}`,
}));

describe('recentThroughput', () => {
  let store;
  beforeEach(() => { vi.useFakeTimers(); store = new OtelStore({ dbPath: ':memory:' }); });
  afterEach(() => { store.stopMaintenance(); store.db.close(); vi.useRealTimers(); });

  it('returns zero rate on an empty store', () => {
    const r = store.recentThroughput();
    expect(r.totalSpans).toBe(0);
    expect(r.spansPerSec).toBe(0);
    expect(r.windowMs).toBe(3_600_000);
  });

  it('counts spans whose trace was received in the window', () => {
    store.ingestSpans(buildSpans(3, 't-recent'));
    const r = store.recentThroughput(60 * 60 * 1000);
    expect(r.totalSpans).toBe(3);
    expect(r.spansPerSec).toBeCloseTo(3 / 3600, 5);
  });

  it('excludes traces received outside the window', () => {
    vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000);
    store.ingestSpans(buildSpans(5, 't-old'));
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
    store.ingestSpans(buildSpans(2, 't-new'));
    const r = store.recentThroughput(60 * 60 * 1000);
    expect(r.totalSpans).toBe(2);
  });
});

// Minimal OTLP TracesData fixture builder. Just enough structure to exercise
// the resource-attr extraction path; we don't need full attribute parity with
// real exporter output for these assertions.
const makeOtlpBody = ({ traceId = 't1', spanId = 's1', resourceAttrs = {} } = {}) => ({
  resourceSpans: [{
    resource: {
      attributes: Object.entries(resourceAttrs).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
    },
    scopeSpans: [{
      spans: [{
        traceId,
        spanId,
        name: 'op',
        kind: 1,
        startTimeUnixNano: 1_000_000_000,
        endTimeUnixNano: 1_100_000_000,
        status: { code: 1 },
      }],
    }],
  }],
});

describe('resource-attr ingest extraction', () => {
  it('lifts service.namespace and container.name off resource attrs', () => {
    const [span] = extractSpans(makeOtlpBody({
      resourceAttrs: {
        'service.name': 'cart-api',
        'service.namespace': 'ecommerce-prod',
        'container.name': 'cart-api-7d4f',
      },
    }));
    expect(span.serviceName).toBe('cart-api');
    expect(span.serviceNamespace).toBe('ecommerce-prod');
    expect(span.containerName).toBe('cart-api-7d4f');
  });

  it('falls back to k8s.container.name when container.name is absent', () => {
    const [span] = extractSpans(makeOtlpBody({
      resourceAttrs: {
        'service.name': 'cart-api',
        'k8s.container.name': 'cart-api-pod',
      },
    }));
    expect(span.containerName).toBe('cart-api-pod');
  });

  it('leaves namespace/container as null when not present', () => {
    const [span] = extractSpans(makeOtlpBody({
      resourceAttrs: { 'service.name': 'cart-api' },
    }));
    expect(span.serviceNamespace).toBeNull();
    expect(span.containerName).toBeNull();
  });
});

describe('namespace/container filtering', () => {
  let store;
  beforeEach(() => { vi.useFakeTimers(); store = new OtelStore({ dbPath: ':memory:' }); });
  afterEach(() => { store.stopMaintenance(); store.db.close(); vi.useRealTimers(); });

  const ingestWithAttrs = ({ traceId, serviceName, namespace, container }) => {
    store.ingestSpans([{
      traceId,
      spanId: `${traceId}-root`,
      parentSpanId: '',
      serviceName,
      serviceNamespace: namespace ?? null,
      containerName: container ?? null,
      name: 'op',
      kind: 1,
      startTimeNs: 1_000_000_000,
      endTimeNs: 1_100_000_000,
      durationMs: 100,
      statusCode: 0,
      statusMessage: '',
      attributes: {},
      events: [],
    }]);
  };

  it('listTraces filters by namespace', () => {
    ingestWithAttrs({ traceId: 'ta', serviceName: 'cart-api', namespace: 'prod' });
    ingestWithAttrs({ traceId: 'tb', serviceName: 'cart-api', namespace: 'staging' });
    ingestWithAttrs({ traceId: 'tc', serviceName: 'cart-api' });

    const prod = store.listTraces({ namespace: 'prod' }).map(t => t.trace_id);
    expect(prod).toEqual(['ta']);

    // Unfiltered returns all three.
    expect(store.listTraces({}).map(t => t.trace_id).sort()).toEqual(['ta', 'tb', 'tc']);
  });

  it('listTraces filters by container', () => {
    ingestWithAttrs({ traceId: 'ta', serviceName: 'cart-api', container: 'cart-a' });
    ingestWithAttrs({ traceId: 'tb', serviceName: 'cart-api', container: 'cart-b' });

    const filtered = store.listTraces({ container: 'cart-b' }).map(t => t.trace_id);
    expect(filtered).toEqual(['tb']);
  });

  it('listTraces composes service + namespace as AND', () => {
    ingestWithAttrs({ traceId: 'ta', serviceName: 'cart-api', namespace: 'prod' });
    ingestWithAttrs({ traceId: 'tb', serviceName: 'inventory', namespace: 'prod' });

    const filtered = store.listTraces({ service: 'cart-api', namespace: 'prod' }).map(t => t.trace_id);
    expect(filtered).toEqual(['ta']);
  });

  it('exposes the root span service_namespace on the trace summary', () => {
    // Root span (no parent) carries the namespace the trace "lives" in; a
    // child span in a different namespace must NOT win — the deep-link's
    // var-OTelNamespace has to match the root, the same span we take
    // service_name/root_operation from.
    store.ingestSpans([
      { ...makeSpan({ traceId: 'tns', spanId: 'root', parentSpanId: '', serviceName: 'cart-api' }), serviceNamespace: 'ecommerce-prod' },
      { ...makeSpan({ traceId: 'tns', spanId: 'child', parentSpanId: 'root', serviceName: 'inventory' }), serviceNamespace: 'warehouse' },
    ]);

    expect(store.getTrace('tns').summary.service_namespace).toBe('ecommerce-prod');
    const [row] = store.listTraces({});
    expect(row.service_namespace).toBe('ecommerce-prod');
  });

  it('listFilterValues returns distinct non-null values', () => {
    ingestWithAttrs({ traceId: 'ta', serviceName: 'cart-api', namespace: 'prod', container: 'cart-a' });
    ingestWithAttrs({ traceId: 'tb', serviceName: 'inventory', namespace: 'prod', container: 'inv-a' });
    ingestWithAttrs({ traceId: 'tc', serviceName: 'shipping' /* no namespace, no container */ });

    const { namespaces, containers } = store.listFilterValues();
    expect(namespaces).toEqual(['prod']);
    expect(containers.sort()).toEqual(['cart-a', 'inv-a']);
  });

  it('listOperations attaches a per-operation latency sparkline', () => {
    const base = 1_000_000_000_000; // fixed wall-clock base for received_at
    // Two cart-api|GET /cart traces in the same hour window: a ~100ms one near
    // the start, a ~500ms one near the end. received_at = Date.now() at ingest,
    // so set the fake clock between the two.
    vi.setSystemTime(base + 60_000); // +1 min
    store.ingestSpans([makeSpan({ traceId: 'o1', spanId: 'r1', serviceName: 'cart-api', name: 'GET /cart', startTimeNs: 0, endTimeNs: 100_000_000 })]);
    vi.setSystemTime(base + 59 * 60_000); // +59 min
    store.ingestSpans([makeSpan({ traceId: 'o2', spanId: 'r2', serviceName: 'cart-api', name: 'GET /cart', startTimeNs: 0, endTimeNs: 500_000_000 })]);

    const ops = store.listOperations({ sinceMs: base, untilMs: base + 60 * 60_000 });
    const op = ops.find(o => o.service_name === 'cart-api' && o.root_operation === 'GET /cart');
    expect(op).toBeTruthy();
    expect(op.sparkline).toHaveLength(24);
    // 24 buckets over 1h = 2.5 min each: minute 1 lands in bucket 0, minute 59
    // in bucket 23, and everything between is empty.
    expect(op.sparkline[0]).toBeCloseTo(100, 5);
    expect(op.sparkline[23]).toBeCloseTo(500, 5);
    expect(op.sparkline.slice(1, 23).every(v => v === 0)).toBe(true);
  });
});

describe('latencySparkline', () => {
  it('returns a zero-filled array of the requested length for no samples', () => {
    expect(latencySparkline([], 0, 100, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it('returns zeros when the window is empty or inverted', () => {
    expect(latencySparkline([{ ts: 5, dur: 10 }], 100, 100, 4)).toEqual([0, 0, 0, 0]);
    expect(latencySparkline([{ ts: 5, dur: 10 }], 100, 0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('averages the durations that fall in each bucket', () => {
    // window [0,100), 5 buckets of width 20: ts 0 and 10 share bucket 0
    // (mean(10,30)=20); ts 90 lands in bucket 4 (100).
    expect(
      latencySparkline([{ ts: 0, dur: 10 }, { ts: 10, dur: 30 }, { ts: 90, dur: 100 }], 0, 100, 5),
    ).toEqual([20, 0, 0, 0, 100]);
  });

  it('clamps out-of-window samples to the nearest edge bucket', () => {
    const out = latencySparkline([{ ts: -50, dur: 4 }, { ts: 999, dur: 8 }], 0, 100, 4);
    expect(out[0]).toBe(4); // below the window → first bucket
    expect(out[3]).toBe(8); // above the window → last bucket
  });

  it('treats a missing duration as zero', () => {
    expect(latencySparkline([{ ts: 1 }], 0, 10, 1)).toEqual([0]);
  });
});

describe('auto_vacuum conversion', () => {
  it('converts a pre-existing NONE database to INCREMENTAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otelstore-'));
    const dbPath = path.join(dir, 'legacy.db');
    // Seed a DB in auto_vacuum=NONE with a table so the mode is committed.
    const seed = new Database(dbPath);
    seed.pragma('auto_vacuum = NONE');
    seed.exec('CREATE TABLE seed (id INTEGER)');
    expect(seed.pragma('auto_vacuum', { simple: true })).toBe(0); // NONE
    seed.close();

    const store = new OtelStore({ dbPath });
    try {
      expect(store.db.pragma('auto_vacuum', { simple: true })).toBe(2); // INCREMENTAL
    } finally {
      store.stopMaintenance();
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

