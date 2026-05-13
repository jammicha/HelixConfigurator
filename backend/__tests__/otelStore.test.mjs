import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

// otelStore.js is CommonJS (module.exports). createRequire bridges to it
// from this .mjs test file so we don't have to rewrite the source.
const require = createRequire(import.meta.url);
const { OtelStore } = require('../otelStore');

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

  describe('TRACE_CAP eviction', () => {
    it('keeps newest 500 traces when 600 are ingested, evicting oldest first', () => {
      for (let i = 0; i < 600; i++) {
        // Advance the clock so received_at strictly increases — the eviction
        // query orders by received_at ASC, ties are not guaranteed stable.
        vi.setSystemTime(Date.now() + 1);
        store.ingestSpans([makeSpan({
          traceId: `t${String(i).padStart(4, '0')}`,
          spanId: `s${i}`,
        })]);
      }
      const { n } = store.countTraces.get();
      expect(n).toBe(500);
      expect(store.getTrace('t0000')).toBeNull();
      expect(store.getTrace('t0099')).toBeNull();
      expect(store.getTrace('t0100')).not.toBeNull();
      expect(store.getTrace('t0599')).not.toBeNull();
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
  });
});
