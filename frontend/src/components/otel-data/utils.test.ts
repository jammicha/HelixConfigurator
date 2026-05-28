import { describe, it, expect } from 'vitest';
import type { HelixEnv, SpanDetail } from './types';
import {
  formatHelixTimestamp,
  buildHelixTraceUrl,
  buildHelixBusinessServiceUrl,
  hasRealHelixEndpoint,
  extractServiceKey,
  normalizeSeverity,
  detectNPlusOne,
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
