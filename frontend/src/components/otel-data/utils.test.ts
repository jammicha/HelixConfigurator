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
} from './utils';

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
