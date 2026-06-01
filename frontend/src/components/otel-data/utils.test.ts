import { describe, it, expect } from 'vitest';
import type { HelixEnv, SpanDetail, TraceSummary } from './types';
import {
  formatHelixTimestamp,
  buildHelixTraceUrl,
  buildHelixBusinessServiceUrl,
  hasRealHelixEndpoint,
  extractServiceKey,
  normalizeSeverity,
  detectNPlusOne,
  serviceTraceView,
  buildOperationP95Map,
  failingOperationView,
  bottleneckOperationView,
  spanMatchesQuery,
  countMatchingSpans,
  hasActiveOtelFilters,
  collapsibleSpanIds,
  nextFocusIndex,
  filterOperations,
  isErrorSpan,
  withAncestors,
} from './utils';
import type { OperationStat } from './types';

// This suite runs under TZ=America/Chicago (see the "test" script in
// package.json) on purpose: formatHelixTimestamp must emit UTC, and a
// regression to local-time getters only surfaces under a non-UTC zone — under
// UTC, local == UTC and the bug slips through. 21:03 UTC is 16:03 CDT.

// The real (UTC) instant of the trace whose "View in Helix" link was broken
// when the formatter used browser-local time.
const NS = Date.parse('2026-05-28T21:03:19.645Z') * 1e6;

const realEnv: HelixEnv = {
  endpoint: 'https://demotenant-neodev4.demos.neo.onbmc.com',
  tenantId: '261739315',
  source: 'JM_OTEL',
  businessServiceKey: 'svc-abc123',
};

describe('failingOperationView', () => {
  const errored = (overrides: Partial<TraceSummary> = {}): TraceSummary => ({
    trace_id: 't1', service_name: 'mysql', root_operation: 'Request Ride',
    start_time_ns: 0, end_time_ns: 0, duration_ms: 0, span_count: 4,
    has_error: 1, received_at: 0,
    failing_operation: 'SELECT drivers', failing_service: 'mysql',
    ...overrides,
  });

  it('returns the failing operation and service in the unfiltered error view', () => {
    expect(failingOperationView(errored(), '')).toEqual({ operation: 'SELECT drivers', service: 'mysql' });
  });

  it('returns null under an active service filter', () => {
    expect(failingOperationView(errored(), 'mysql')).toBeNull();
  });

  it('returns null when the trace has no error', () => {
    expect(failingOperationView(errored({ has_error: 0 }), '')).toBeNull();
  });

  it('returns null when there is no failing operation', () => {
    expect(failingOperationView(errored({ failing_operation: null }), '')).toBeNull();
  });

  it('returns null when the failing operation equals the root operation', () => {
    expect(failingOperationView(errored({ failing_operation: 'Request Ride' }), '')).toBeNull();
  });

  it('returns a null service when failing_service is absent', () => {
    expect(failingOperationView(errored({ failing_service: null }), '')).toEqual({ operation: 'SELECT drivers', service: null });
  });
});

describe('bottleneckOperationView', () => {
  const trace = (overrides: Partial<TraceSummary> = {}): TraceSummary => ({
    trace_id: 't1', service_name: 'frontend', root_operation: 'Request Ride',
    start_time_ns: 0, end_time_ns: 0, duration_ms: 1000, span_count: 4,
    has_error: 0, received_at: 0,
    slowest_child_operation: 'Calculate Trip ETA', slowest_child_service: 'route',
    slowest_child_duration_ms: 800,
    ...overrides,
  });

  const THRESHOLD = 500;

  it('returns the slowest child operation in the unfiltered slow trace view', () => {
    expect(bottleneckOperationView(trace(), '', THRESHOLD)).toEqual({
      operation: 'Calculate Trip ETA',
      service: 'route',
      durationMs: 800,
    });
  });

  it('returns null under an active service filter', () => {
    expect(bottleneckOperationView(trace(), 'frontend', THRESHOLD)).toBeNull();
  });

  it('returns null when the trace has an error', () => {
    expect(bottleneckOperationView(trace({ has_error: 1 }), '', THRESHOLD)).toBeNull();
  });

  it('returns null when the trace duration is at or below the threshold', () => {
    expect(bottleneckOperationView(trace({ duration_ms: 400 }), '', THRESHOLD)).toBeNull();
  });

  it('returns null when there is no slowest child operation', () => {
    expect(bottleneckOperationView(trace({ slowest_child_operation: null }), '', THRESHOLD)).toBeNull();
  });

  it('returns null when the slowest child operation equals the root operation', () => {
    expect(bottleneckOperationView(trace({ slowest_child_operation: 'Request Ride' }), '', THRESHOLD)).toBeNull();
  });

  it('returns a null service when slowest_child_service is absent', () => {
    expect(bottleneckOperationView(trace({ slowest_child_service: null }), '', THRESHOLD)).toEqual({
      operation: 'Calculate Trip ETA',
      service: null,
      durationMs: 800,
    });
  });
});

describe('formatHelixTimestamp', () => {
  it('formats in UTC regardless of host timezone', () => {
    // Under the suite's America/Chicago TZ, local-time getters would yield
    // 16:03:19 — this asserting 21:03:19 is what guards the regression.
    expect(formatHelixTimestamp(NS)).toBe('2026-05-28 21:03:19.645000000');
  });

  it('zero-pads single-digit fields and sub-100ms milliseconds', () => {
    const ns = Date.parse('2026-01-02T03:04:05.007Z') * 1e6;
    expect(formatHelixTimestamp(ns)).toBe('2026-01-02 03:04:05.007000000');
  });

  it('returns empty string for missing timestamps', () => {
    expect(formatHelixTimestamp(0)).toBe('');
    expect(formatHelixTimestamp(null)).toBe('');
    expect(formatHelixTimestamp(undefined)).toBe('');
  });
});

describe('buildHelixTraceUrl', () => {
  const args = {
    traceId: '86c9cd9ee99aa88fa04ba19ef5ee4f78',
    serviceName: 'traffic-generator',
    timeNs: NS,
  };

  it('returns null for the install-bundle placeholder endpoint', () => {
    expect(
      buildHelixTraceUrl({ ...realEnv, endpoint: 'https://your-tenant.onbmc.com' }, args),
    ).toBeNull();
  });

  it('returns null when env, tenantId, or traceId is missing', () => {
    expect(buildHelixTraceUrl(null, args)).toBeNull();
    expect(buildHelixTraceUrl({ ...realEnv, tenantId: '' }, args)).toBeNull();
    expect(buildHelixTraceUrl(realEnv, { ...args, traceId: '' })).toBeNull();
  });

  it('uses the passed namespace for var-OTelNamespace', () => {
    const url = buildHelixTraceUrl(realEnv, { ...args, namespace: 'jaeger-hotrod' })!;
    expect(new URL(url).searchParams.get('var-OTelNamespace')).toBe('jaeger-hotrod');
  });

  it('falls back to env.source when namespace is absent or empty', () => {
    const noNs = buildHelixTraceUrl(realEnv, args)!;
    expect(new URL(noNs).searchParams.get('var-OTelNamespace')).toBe('JM_OTEL');
    const emptyNs = buildHelixTraceUrl(realEnv, { ...args, namespace: '' })!;
    expect(new URL(emptyNs).searchParams.get('var-OTelNamespace')).toBe('JM_OTEL');
  });

  it('encodes the timestamp space as %20, never +', () => {
    const url = buildHelixTraceUrl(realEnv, { ...args, namespace: 'jaeger-hotrod' })!;
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
    // Decoded value round-trips to the UTC wall-clock Helix matches on.
    expect(new URL(url).searchParams.get('var-TraceTimestamp')).toBe(
      '2026-05-28 21:03:19.645000000',
    );
  });

  it('uppercases the trace id', () => {
    const url = buildHelixTraceUrl(realEnv, args)!;
    expect(new URL(url).searchParams.get('var-TraceId')).toBe(
      '86C9CD9EE99AA88FA04BA19EF5EE4F78',
    );
  });
});

describe('hasRealHelixEndpoint', () => {
  it('rejects null/empty and the placeholder, accepts a real endpoint', () => {
    expect(hasRealHelixEndpoint(null)).toBe(false);
    expect(hasRealHelixEndpoint({ ...realEnv, endpoint: '' })).toBe(false);
    expect(hasRealHelixEndpoint({ ...realEnv, endpoint: 'https://your-tenant.onbmc.com' })).toBe(false);
    expect(hasRealHelixEndpoint(realEnv)).toBe(true);
  });
});

describe('buildHelixBusinessServiceUrl', () => {
  it('returns null for the placeholder endpoint or a missing key', () => {
    expect(
      buildHelixBusinessServiceUrl({ ...realEnv, endpoint: 'https://your-tenant.onbmc.com' }),
    ).toBeNull();
    expect(buildHelixBusinessServiceUrl({ ...realEnv, businessServiceKey: '' })).toBeNull();
  });

  it('builds the AIOps entity URL from the configured key', () => {
    expect(buildHelixBusinessServiceUrl(realEnv)).toBe(
      'https://demotenant-neodev4.demos.neo.onbmc.com/aiops/#/entities/service/svc-abc123?type=key',
    );
  });
});

describe('extractServiceKey', () => {
  it('returns a bare key unchanged', () => {
    expect(extractServiceKey('svc-abc123')).toBe('svc-abc123');
  });

  it('pulls the key out of a full AIOps URL fragment', () => {
    expect(
      extractServiceKey('https://x.onbmc.com/aiops/#/entities/service/KEY42?type=key'),
    ).toBe('KEY42');
  });

  it('strips a trailing query/fragment from a bare key', () => {
    expect(extractServiceKey('KEY42?type=key')).toBe('KEY42');
  });

  it('returns empty string for empty/nullish input', () => {
    expect(extractServiceKey('')).toBe('');
    expect(extractServiceKey(null)).toBe('');
    expect(extractServiceKey(undefined)).toBe('');
  });
});

describe('normalizeSeverity', () => {
  it('buckets variants into canonical levels', () => {
    expect(normalizeSeverity('Info')).toBe('INFO');
    expect(normalizeSeverity('error_2')).toBe('ERROR');
    expect(normalizeSeverity('CRITICAL')).toBe('FATAL');
    expect(normalizeSeverity('warning')).toBe('WARN');
    expect(normalizeSeverity('Debug')).toBe('DEBUG');
  });

  it('falls back to em dash for empty and upper-cases the unknown', () => {
    expect(normalizeSeverity('')).toBe('—');
    expect(normalizeSeverity('notice')).toBe('NOTICE');
  });
});

describe('detectNPlusOne', () => {
  const span = (op?: string, dbName?: string): SpanDetail =>
    ({
      attributes: {
        ...(op ? { 'db.operation': op } : {}),
        ...(dbName ? { 'db.name': dbName } : {}),
      },
    }) as unknown as SpanDetail;

  it('flags 5+ spans sharing db.operation + db.name', () => {
    const spans = Array.from({ length: 6 }, () => span('SELECT', 'orders'));
    expect(detectNPlusOne(spans)).toEqual({ operation: 'SELECT', dbName: 'orders', count: 6 });
  });

  it('returns null below the 5-span threshold', () => {
    const spans = Array.from({ length: 4 }, () => span('SELECT', 'orders'));
    expect(detectNPlusOne(spans)).toBeNull();
  });

  it('returns the worst bucket when several qualify', () => {
    const spans = [
      ...Array.from({ length: 5 }, () => span('SELECT', 'orders')),
      ...Array.from({ length: 8 }, () => span('UPDATE', 'inventory')),
    ];
    expect(detectNPlusOne(spans)).toEqual({ operation: 'UPDATE', dbName: 'inventory', count: 8 });
  });

  it('ignores spans without a db.operation', () => {
    const spans = Array.from({ length: 6 }, () => span(undefined, 'orders'));
    expect(detectNPlusOne(spans)).toBeNull();
  });
});

describe('filterOperations', () => {
  const op = (service_name: string, root_operation: string): OperationStat =>
    ({ service_name, root_operation } as OperationStat);
  const ops = [
    op('cart-api', 'GET /cart/items'),
    op('checkout-api', 'POST /checkout'),
    op('mysql', 'SELECT carts'),
  ];

  it('returns the list unchanged for a blank or whitespace query', () => {
    expect(filterOperations(ops, '')).toBe(ops);
    expect(filterOperations(ops, '   ')).toBe(ops);
  });

  it('matches the service name or the operation, case-insensitively', () => {
    expect(filterOperations(ops, 'CART').map(o => o.service_name)).toEqual(['cart-api', 'mysql']);
    expect(filterOperations(ops, 'checkout').map(o => o.service_name)).toEqual(['checkout-api']);
    expect(filterOperations(ops, 'select').map(o => o.service_name)).toEqual(['mysql']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterOperations(ops, 'redis')).toEqual([]);
  });
});

describe('isErrorSpan', () => {
  const base = { spanId: 's', statusCode: 0, events: [] as any[] };
  it('flags spans with OTel StatusCode=2 (ERROR)', () => {
    expect(isErrorSpan({ ...base, statusCode: 2 } as unknown as SpanDetail)).toBe(true);
  });
  it('flags spans carrying an exception event regardless of status', () => {
    expect(isErrorSpan({ ...base, events: [{ name: 'exception' }] } as unknown as SpanDetail)).toBe(true);
  });
  it('does not flag ok spans', () => {
    expect(isErrorSpan({ ...base, statusCode: 1, events: [{ name: 'enqueue' }] } as unknown as SpanDetail)).toBe(false);
  });
});

describe('withAncestors', () => {
  const sp = (spanId: string, parentSpanId: string | null): SpanDetail =>
    ({ spanId, parentSpanId, attributes: {}, events: [] }) as unknown as SpanDetail;

  it('keeps each match plus its full ancestor chain to the root', () => {
    // root → a → b, root → c. Error at b → keep b, a, root (not c).
    const spans = [sp('root', null), sp('a', 'root'), sp('b', 'a'), sp('c', 'root')];
    expect(withAncestors(spans, new Set(['b']))).toEqual(new Set(['b', 'a', 'root']));
  });

  it('merges overlapping ancestor paths without duplication', () => {
    const spans = [sp('root', null), sp('a', 'root'), sp('b', 'a'), sp('d', 'a')];
    expect(withAncestors(spans, new Set(['b', 'd']))).toEqual(new Set(['b', 'd', 'a', 'root']));
  });

  it('returns an empty set when there are no matches', () => {
    const spans = [sp('root', null), sp('a', 'root')];
    expect(withAncestors(spans, new Set())).toEqual(new Set());
  });
});

describe('collapsibleSpanIds', () => {
  const sp = (spanId: string, parentSpanId: string | null): SpanDetail =>
    ({ spanId, parentSpanId, attributes: {}, events: [] }) as unknown as SpanDetail;

  it('returns only the span ids that have at least one child', () => {
    // root → a → b, and root → c (leaf). Collapsible = root and a.
    const spans = [sp('root', null), sp('a', 'root'), sp('b', 'a'), sp('c', 'root')];
    expect(collapsibleSpanIds(spans)).toEqual(new Set(['root', 'a']));
  });

  it('excludes parent ids that are not spans in the trace (orphaned subtree)', () => {
    // "ghost" is referenced as a parent but never present as a span.
    const spans = [sp('x', 'ghost'), sp('y', 'x')];
    expect(collapsibleSpanIds(spans)).toEqual(new Set(['x']));
  });

  it('returns an empty set for a flat, single-span, or empty trace', () => {
    expect(collapsibleSpanIds([])).toEqual(new Set());
    expect(collapsibleSpanIds([sp('only', null)])).toEqual(new Set());
  });
});

describe('nextFocusIndex', () => {
  it('selects the first row going down and the last going up from nothing focused', () => {
    expect(nextFocusIndex(-1, 1, 5)).toBe(0);
    expect(nextFocusIndex(-1, -1, 5)).toBe(4);
  });

  it('steps within bounds and clamps at both ends without wrapping', () => {
    expect(nextFocusIndex(2, 1, 5)).toBe(3);
    expect(nextFocusIndex(2, -1, 5)).toBe(1);
    expect(nextFocusIndex(4, 1, 5)).toBe(4); // clamp at bottom
    expect(nextFocusIndex(0, -1, 5)).toBe(0); // clamp at top
  });

  it('returns -1 for an empty list', () => {
    expect(nextFocusIndex(-1, 1, 0)).toBe(-1);
    expect(nextFocusIndex(3, 1, 0)).toBe(-1);
  });
});

describe('spanMatchesQuery / countMatchingSpans', () => {
  const mkSpan = (over: Partial<SpanDetail> = {}): SpanDetail =>
    ({
      spanId: 's', traceId: 't', parentSpanId: null,
      serviceName: 'cart-api', name: 'GET /cart/items', kind: 3,
      startTimeNs: 0, endTimeNs: 0, durationMs: 0, statusCode: 0, statusMessage: '',
      attributes: { 'http.method': 'GET', 'http.status_code': 200 }, events: [],
      ...over,
    }) as SpanDetail;

  it('matches on span name, service, and attribute value, case-insensitively', () => {
    expect(spanMatchesQuery(mkSpan(), 'cart-api')).toBe(true);   // service
    expect(spanMatchesQuery(mkSpan(), '/CART/items')).toBe(true); // name (mixed case)
    expect(spanMatchesQuery(mkSpan(), '200')).toBe(true);         // attribute value
    expect(spanMatchesQuery(mkSpan(), 'get')).toBe(true);         // attribute value, lowercased
  });

  it('does not match unrelated text and treats an empty query as inactive', () => {
    expect(spanMatchesQuery(mkSpan(), 'payment')).toBe(false);
    expect(spanMatchesQuery(mkSpan(), '')).toBe(false);
  });

  it('counts only matching spans, zero for an empty query', () => {
    const spans = [
      mkSpan({ name: 'GET /cart/items' }),
      mkSpan({ name: 'POST /checkout', serviceName: 'checkout-api', attributes: {} }),
      mkSpan({ name: 'SELECT items', serviceName: 'mysql', attributes: { 'db.system': 'mysql' } }),
    ];
    expect(countMatchingSpans(spans, 'cart')).toBe(1);
    expect(countMatchingSpans(spans, 'api')).toBe(2); // cart-api + checkout-api
    expect(countMatchingSpans(spans, 'redis')).toBe(0);
    expect(countMatchingSpans(spans, '')).toBe(0);
  });
});

describe('hasActiveOtelFilters', () => {
  it('is false when nothing is engaged (and ignores blank search / zero min-duration)', () => {
    expect(hasActiveOtelFilters({})).toBe(false);
    expect(hasActiveOtelFilters({ service: '', namespace: '', status: '', minMs: 0, search: '   ' })).toBe(false);
    expect(hasActiveOtelFilters({ customRange: false })).toBe(false);
  });

  it('is true when any individual filter is engaged', () => {
    expect(hasActiveOtelFilters({ service: 'cart-api' })).toBe(true);
    expect(hasActiveOtelFilters({ namespace: 'shop' })).toBe(true);
    expect(hasActiveOtelFilters({ container: 'cart-7f9' })).toBe(true);
    expect(hasActiveOtelFilters({ status: 'error' })).toBe(true);
    expect(hasActiveOtelFilters({ minMs: 250 })).toBe(true);
    expect(hasActiveOtelFilters({ search: 'checkout' })).toBe(true);
    expect(hasActiveOtelFilters({ customRange: true })).toBe(true);
  });
});

describe('serviceTraceView', () => {
  // Root = the traffic generator's POST /checkout, 50ms, no error. The svc_*
  // fields model cart-api's entry span within that trace, which the Traces
  // table renders when cart-api is the active Service filter.
  const mkTrace = (over: Partial<TraceSummary> = {}): TraceSummary => ({
    trace_id: 't1',
    service_name: 'traffic-generator',
    root_operation: 'POST /checkout',
    start_time_ns: 1000,
    end_time_ns: 51_000,
    duration_ms: 50,
    span_count: 6,
    has_error: 0,
    received_at: 0,
    ...over,
  });

  const SLOW = 500;

  describe('with no service filter (trace-level verdict)', () => {
    it('classifies error from the trace-wide has_error flag', () => {
      expect(serviceTraceView(mkTrace({ has_error: 1 }), '', SLOW).status).toBe('error');
    });

    it('classifies slow when the trace duration exceeds the threshold', () => {
      expect(serviceTraceView(mkTrace({ duration_ms: 600 }), '', SLOW).status).toBe('slow');
    });

    it('surfaces the trace root service/operation/duration and is ok otherwise', () => {
      const v = serviceTraceView(mkTrace(), '', SLOW);
      expect(v).toMatchObject({
        service: 'traffic-generator',
        operation: 'POST /checkout',
        durationMs: 50,
        startNs: 1000,
        status: 'ok',
      });
    });
  });

  describe('with a service filter (selected service entry-span verdict)', () => {
    it('does NOT report error when only a downstream span failed', () => {
      // The regression: trace-wide has_error=1 (a payment/db span threw) but
      // cart-api's own entry span succeeded — the row shows OK, so the Error
      // filter must agree and exclude it.
      const t = mkTrace({
        has_error: 1,
        error_count: 3,
        svc_status_code: 0,
        svc_operation: 'GET /cart/items',
        svc_duration_ms: 20,
        svc_start_ns: 5000,
      });
      expect(serviceTraceView(t, 'cart-api', SLOW).status).toBe('ok');
    });

    it('reports error when the selected service own span failed', () => {
      const t = mkTrace({ has_error: 1, svc_status_code: 2, svc_duration_ms: 20 });
      expect(serviceTraceView(t, 'cart-api', SLOW).status).toBe('error');
    });

    it('classifies slow from the service span duration, not the trace duration', () => {
      // Trace is fast (50ms) but cart-api's span is slow (800ms).
      const slowSvc = mkTrace({ duration_ms: 50, svc_status_code: 0, svc_duration_ms: 800 });
      expect(serviceTraceView(slowSvc, 'cart-api', SLOW).status).toBe('slow');
      // Inverse: trace is slow (900ms) but cart-api's span is fast (20ms) → ok.
      const fastSvc = mkTrace({ duration_ms: 900, svc_status_code: 0, svc_duration_ms: 20 });
      expect(serviceTraceView(fastSvc, 'cart-api', SLOW).status).toBe('ok');
    });

    it('surfaces the selected service entry-span fields', () => {
      const t = mkTrace({
        svc_status_code: 0,
        svc_operation: 'GET /cart/items',
        svc_duration_ms: 120,
        svc_start_ns: 7777,
      });
      expect(serviceTraceView(t, 'cart-api', SLOW)).toMatchObject({
        service: 'cart-api',
        operation: 'GET /cart/items',
        durationMs: 120,
        startNs: 7777,
      });
    });

    it('falls back to root fields when the service entry span is absent (LEFT JOIN miss)', () => {
      // svc_* all undefined — backend found no entry span for the service.
      const v = serviceTraceView(mkTrace({ duration_ms: 600 }), 'cart-api', SLOW);
      expect(v).toMatchObject({
        operation: 'POST /checkout',
        durationMs: 600,
        startNs: 1000,
        status: 'slow', // null svc_status_code → 0 → not error; falls to duration check
      });
    });
  });
});

describe('buildOperationP95Map', () => {
  // Trace-root rollup (/api/operations) and the per-service span-latency rollup
  // (/api/operations/latencies). cart-api never appears in the root rollup —
  // it's never a trace root — which is exactly why the service-filtered Outlier
  // path needs the span rollup.
  const rootOps = [
    { service_name: 'traffic-generator', root_operation: 'POST /checkout', p95_ms: 900 },
  ];
  const serviceOps = [
    { service_name: 'cart-api', operation: 'GET /cart/items', p95_ms: 120 },
    { service_name: 'traffic-generator', operation: 'POST /checkout', p95_ms: 880 },
  ];

  it('keys off the per-service span rollup when a service is selected', () => {
    const m = buildOperationP95Map(rootOps, serviceOps, 'cart-api');
    // The participating-service operation now has a baseline (the bug fix)...
    expect(m.get('cart-api|GET /cart/items')).toBe(120);
    // ...and root operations are still resolvable for the trace-detail drawer.
    expect(m.get('traffic-generator|POST /checkout')).toBe(880);
  });

  it('keys off the trace-root rollup when no service is selected', () => {
    const m = buildOperationP95Map(rootOps, serviceOps, '');
    expect(m.get('traffic-generator|POST /checkout')).toBe(900);
    // cart-api has no trace-root entry — unfiltered rows are judged by root.
    expect(m.has('cart-api|GET /cart/items')).toBe(false);
  });

  it('returns an empty map for empty inputs', () => {
    expect(buildOperationP95Map([], [], 'cart-api').size).toBe(0);
    expect(buildOperationP95Map([], [], '').size).toBe(0);
  });
});
