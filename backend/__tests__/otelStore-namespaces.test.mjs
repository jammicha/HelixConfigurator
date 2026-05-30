import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OtelStore } = require('../otelStore');

describe('OtelStore.listNamespaces', () => {
  let store;
  beforeEach(() => { vi.useFakeTimers(); store = new OtelStore({ dbPath: ':memory:' }); });
  afterEach(() => { store.stopMaintenance(); store.db.close(); vi.useRealTimers(); });

  // Seed traces directly — all columns are nullable except the trace_id PK.
  const seed = (trace_id, service_namespace, received_at) =>
    store.db.prepare(
      `INSERT INTO traces (trace_id, service_name, service_namespace, root_operation,
         start_time_ns, end_time_ns, duration_ms, span_count, has_error, received_at)
       VALUES (?, 'svc', ?, 'op', 1, 2, 1, 1, 0, ?)`,
    ).run(trace_id, service_namespace, received_at);

  it('returns distinct namespaces with trace counts, newest-seen first', () => {
    seed('t1', 'checkout', 100);
    seed('t2', 'payments', 300);
    seed('t3', 'checkout', 200);
    expect(store.listNamespaces()).toEqual([
      { namespace: 'payments', traceCount: 1, lastSeen: 300 },
      { namespace: 'checkout', traceCount: 2, lastSeen: 200 },
    ]);
  });
  it('reports null namespace for un-namespaced traces (caller maps to X_SOURCE)', () => {
    seed('t9', null, 50);
    expect(store.listNamespaces()).toEqual([{ namespace: null, traceCount: 1, lastSeen: 50 }]);
  });
  it('returns [] for an empty store', () => {
    expect(store.listNamespaces()).toEqual([]);
  });
});
