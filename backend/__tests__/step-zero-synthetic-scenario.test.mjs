import { describe, it, expect } from 'vitest';
import { generateTrace, buildSpan, buildExceptionEvent } from '../routes/step-zero/synthetic-scenario.js';

const sample = (n, fn) => Array.from({ length: n }, fn);

const serviceNameOf = (rs) => {
  const a = rs.resource.attributes.find(a => a.key === 'service.name');
  return a && a.value.stringValue;
};

const spansForService = (trace, serviceName) => {
  const out = [];
  for (const rs of trace.traces.resourceSpans) {
    if (serviceNameOf(rs) !== serviceName) continue;
    for (const ss of rs.scopeSpans) {
      for (const s of ss.spans) out.push(s);
    }
  }
  return out;
};

const durationMs = (s) =>
  Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1_000_000;

describe('generateTrace', () => {
  it('returns an object with traces, logs, and metrics OTLP payloads', () => {
    const t = generateTrace();
    expect(t).toHaveProperty('traces');
    expect(t).toHaveProperty('logs');
    expect(t).toHaveProperty('metrics');
    expect(t.traces).toHaveProperty('resourceSpans');
    expect(t.logs).toHaveProperty('resourceLogs');
    expect(t.metrics).toHaveProperty('resourceMetrics');
  });

  it('produces spans for the five core services', () => {
    // Sample many to allow optional services (notification-svc, inventory-db) to appear.
    const services = new Set();
    sample(50, () => {
      for (const rs of generateTrace().traces.resourceSpans) {
        services.add(serviceNameOf(rs));
      }
    });
    expect(services.has('checkout-web')).toBe(true);
    expect(services.has('cart-api')).toBe(true);
    expect(services.has('inventory-db')).toBe(true);
    expect(services.has('payment-service')).toBe(true);
    expect(services.has('stripe-mock')).toBe(true);
    expect(services.has('notification-svc')).toBe(true);
  });

  it('all spans in a trace share the same traceId', () => {
    const t = generateTrace();
    const traceIds = new Set();
    for (const rs of t.traces.resourceSpans) {
      for (const ss of rs.scopeSpans) {
        for (const s of ss.spans) traceIds.add(s.traceId);
      }
    }
    expect(traceIds.size).toBe(1);
  });

  it('stripe-mock latency tail fires on ~8% of traces (sample of 2000)', () => {
    let tail = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const stripeSpans = spansForService(t, 'stripe-mock');
      if (stripeSpans.some(s => durationMs(s) > 150)) tail++;
    }
    // 8% over 2000 ~ 160. Allow generous statistical bounds.
    expect(tail).toBeGreaterThan(100);
    expect(tail).toBeLessThan(220);
  });

  it('inventory error cascade fires on ~3% of traces with full propagation (sample of 2000)', () => {
    let errored = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const invSpans = spansForService(t, 'inventory-db');
      const invErr = invSpans.find(s => s.status && s.status.code === 2);
      if (!invErr) continue;
      errored++;
      // Cascade: cart-api and checkout-web must also be errored on the same trace.
      const cartSpans = spansForService(t, 'cart-api');
      const checkoutSpans = spansForService(t, 'checkout-web');
      expect(cartSpans.some(s => s.status && s.status.code === 2)).toBe(true);
      expect(checkoutSpans.some(s => s.status && s.status.code === 2)).toBe(true);
    }
    // 3% over 2000 ~ 60. Allow generous statistical bounds.
    expect(errored).toBeGreaterThan(30);
    expect(errored).toBeLessThan(100);
  });

  it('N+1 pattern fires on ~5% of traces with 5-10 sibling inventory-db spans (sample of 2000)', () => {
    let n1 = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const invSpans = spansForService(t, 'inventory-db');
      if (invSpans.length > 2) {
        n1++;
        expect(invSpans.length).toBeGreaterThanOrEqual(5);
        expect(invSpans.length).toBeLessThanOrEqual(10);
      }
    }
    // 5% over 2000 ~ 100. Allow generous statistical bounds.
    expect(n1).toBeGreaterThan(60);
    expect(n1).toBeLessThan(140);
  });

  it('logs are correlated to the trace (share traceId)', () => {
    const t = generateTrace();
    const spanTraceId = t.traces.resourceSpans[0].scopeSpans[0].spans[0].traceId;
    for (const rl of t.logs.resourceLogs) {
      for (const sl of rl.scopeLogs) {
        for (const lr of sl.logRecords) {
          expect(lr.traceId).toBe(spanTraceId);
        }
      }
    }
  });

  it('cart-api cache-miss tail fires on ~5% of traces (sample of 2000)', () => {
    let slow = 0;
    let sample;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const cartSpans = spansForService(t, 'cart-api');
      if (cartSpans.some(s => durationMs(s) > 25)) {
        slow++;
        if (!sample) sample = t;
      }
    }
    // 5% over 2000 ~ 100. Note: N+1 pattern can also inflate cart-api duration
    // because cart covers all sequential inv-db calls (5-10 * 5ms = 25-50ms),
    // so this count will include some N+1 overlap. We just want a roughly
    // increased count over baseline.
    expect(slow).toBeGreaterThan(70);
    expect(slow).toBeLessThan(250); // generous upper to account for N+1 overlap
    // Spot-check: find a trace where cart-api > 25ms AND has cache.hit=false.
    let foundCacheMiss = false;
    for (let i = 0; i < 500 && !foundCacheMiss; i++) {
      const t = generateTrace();
      const cartSpans = spansForService(t, 'cart-api');
      for (const s of cartSpans) {
        const attr = (s.attributes || []).find(a => a.key === 'cache.hit');
        if (attr && attr.value.boolValue === false) {
          expect(durationMs(s)).toBeGreaterThan(15); // ~40ms median, allow wide
          foundCacheMiss = true;
          break;
        }
      }
    }
    expect(foundCacheMiss).toBe(true);
  });

  it('inventory-db pool wait fires on ~4% of traces with attribute on every inv span (sample of 2000)', () => {
    let withWait = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const invSpans = spansForService(t, 'inventory-db');
      const anyHas = invSpans.some(s =>
        (s.attributes || []).some(a => a.key === 'db.pool.wait_ms'),
      );
      if (!anyHas) continue;
      withWait++;
      // When the pattern fires, ALL inv-db spans should have the attribute
      // (handles N+1 interaction).
      for (const s of invSpans) {
        const attr = (s.attributes || []).find(a => a.key === 'db.pool.wait_ms');
        expect(attr).toBeDefined();
        expect(attr.value.intValue).toBe(10);
      }
    }
    // 4% over 2000 ~ 80. Generous bounds.
    expect(withWait).toBeGreaterThan(55);
    expect(withWait).toBeLessThan(130);
  });

  it('notification email-render slow fires on ~1.4% of traces (sample of 2000)', () => {
    let slow = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const notifySpans = spansForService(t, 'notification-svc');
      if (notifySpans.some(s => durationMs(s) > 60)) slow++;
    }
    // 2% * 70% (notification present) over 2000 ~ 28. Generous bounds.
    expect(slow).toBeGreaterThan(15);
    expect(slow).toBeLessThan(60);
  });

  it('retry storm fires on ~2% of traces with 3 sequential stripe-mock spans (sample of 2000)', () => {
    let retries = 0;
    let sample;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const stripeSpans = spansForService(t, 'stripe-mock');
      if (stripeSpans.length > 1) {
        retries++;
        if (!sample) sample = stripeSpans;
      }
    }
    // 2% over 2000 ~ 40. Generous bounds.
    expect(retries).toBeGreaterThan(25);
    expect(retries).toBeLessThan(75);
    // Spot-check shape on a captured sample: 3 spans, first two errored, last
    // succeeds (UNSET, per OTel idiom — Helix's default Status Filter is
    // STATUS_CODE_UNSET, so the successful retry must not be marked OK).
    expect(sample).toBeDefined();
    expect(sample.length).toBe(3);
    expect(sample[0].status.code).toBe(2);
    expect(sample[1].status.code).toBe(2);
    expect(sample[2].status.code).toBe(0);
    // retry.attempt attributes
    for (let i = 0; i < 3; i++) {
      const attr = (sample[i].attributes || []).find(a => a.key === 'retry.attempt');
      expect(attr).toBeDefined();
      expect(attr.value.intValue).toBe(i + 1);
    }
  });

  it('cold-start spike fires on ~2% of traces (sample of 5000)', () => {
    // Larger sample shrinks variance so the bounds stay tight (within ~50%
    // of expected) without being statistically flaky. At n=2000 with
    // p=0.02, σ ≈ 6.3 and the previous `> 25` lower bound sat at ~2.4σ
    // below mean — about a 1.6% false-positive rate per run, which made
    // the test flake when run repeatedly in CI.
    let cold = 0;
    for (let i = 0; i < 5000; i++) {
      const t = generateTrace();
      let found = false;
      for (const rs of t.traces.resourceSpans) {
        const svc = serviceNameOf(rs);
        // Cold-start only targets these four services (skips stripe-mock + inventory-db).
        if (!['checkout-web', 'cart-api', 'payment-service', 'notification-svc'].includes(svc)) continue;
        for (const ss of rs.scopeSpans) {
          for (const s of ss.spans) {
            const attr = (s.attributes || []).find(a => a.key === 'startup.cold');
            if (attr && attr.value.boolValue === true) found = true;
          }
        }
      }
      if (found) cold++;
    }
    // 2% over 5000 ~ 100. σ ≈ √(5000·0.02·0.98) ≈ 9.9.
    // Bounds at -4σ / +5σ catch a regression of >40% in either direction
    // (i.e. rate dropping below 1.2% or climbing above 3%), while pushing
    // false-positive rate well below one-in-a-million.
    expect(cold).toBeGreaterThan(60);
    expect(cold).toBeLessThan(150);
  });

  it('cold-start spike makes the root span well above the outlier threshold', () => {
    // Verifies the diagnostic STORY: a cold-start trace's root duration
    // should be far above 2× the operation's median, so /otel-data's
    // outlier badge (>2× p95) reliably flags it.
    let coldStartTrace = null;
    for (let i = 0; i < 500 && !coldStartTrace; i++) {
      const t = generateTrace();
      for (const rs of t.traces.resourceSpans) {
        for (const ss of rs.scopeSpans) {
          for (const s of ss.spans) {
            const attr = (s.attributes || []).find(a => a.key === 'startup.cold');
            if (attr && attr.value.boolValue === true) {
              coldStartTrace = t;
              break;
            }
          }
        }
      }
    }
    if (!coldStartTrace) {
      throw new Error('Expected at least one cold-start in 500 samples but found none');
    }
    // Find the root span (no parentSpanId) — should be well above 1500ms.
    let rootDurationMs = 0;
    for (const rs of coldStartTrace.traces.resourceSpans) {
      for (const ss of rs.scopeSpans) {
        for (const s of ss.spans) {
          if (!s.parentSpanId) {
            rootDurationMs = Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1_000_000;
          }
        }
      }
    }
    // Cold-start magnitude is 2500-4000ms. Baseline root is ~110ms.
    // Even at the bottom of the cold-start range, root duration is well
    // above the typical "2× p95" outlier threshold (~500-600ms).
    expect(rootDurationMs).toBeGreaterThan(2000);
  });

  it('inventory-db spans carry OTel DB semantic-convention attributes', () => {
    // The /otel-data viewer's DB detection (and built-in N+1 detector)
    // look at db.system / db.operation / db.name — not at the span name
    // or service name. Without these attributes, inventory queries don't
    // get recognized as DB calls in the trace detail or N+1 callouts.
    const t = generateTrace();
    let inventorySpans = [];
    for (const rs of t.traces.resourceSpans) {
      const svc = serviceNameOf(rs);
      if (svc !== 'inventory-db') continue;
      for (const ss of rs.scopeSpans) {
        for (const s of ss.spans) inventorySpans.push(s);
      }
    }
    expect(inventorySpans.length).toBeGreaterThan(0);
    for (const span of inventorySpans) {
      // span.kind should be CLIENT (3) for DB calls per OTel conventions.
      expect(span.kind).toBe(3);
      const attrMap = Object.fromEntries(
        (span.attributes || []).map(a => [a.key, a.value])
      );
      expect(attrMap['db.system']?.stringValue).toBe('postgresql');
      expect(attrMap['db.name']?.stringValue).toBe('inventory');
      expect(attrMap['db.operation']?.stringValue).toBe('SELECT');
      expect(attrMap['db.sql.table']?.stringValue).toBe('stock');
      expect(typeof attrMap['db.statement']?.stringValue).toBe('string');
      expect(attrMap['db.statement'].stringValue).toMatch(/^SELECT /);
    }
  });
});

describe('buildExceptionEvent', () => {
  it('builds an OTLP exception event with type/message/stacktrace', () => {
    const ev = buildExceptionEvent({ type: 'psycopg2.OperationalError', message: 'boom', stacktrace: 'Traceback…', timeMs: 5 });
    expect(ev.name).toBe('exception');
    expect(typeof ev.timeUnixNano).toBe('string');
    const a = Object.fromEntries(ev.attributes.map(x => [x.key, x.value.stringValue]));
    expect(a['exception.type']).toBe('psycopg2.OperationalError');
    expect(a['exception.message']).toBe('boom');
    expect(a['exception.stacktrace']).toBe('Traceback…');
  });
  it('omits the stacktrace attribute when none is given', () => {
    const ev = buildExceptionEvent({ type: 'X', message: 'm', timeMs: 1 });
    expect(ev.attributes.find(x => x.key === 'exception.stacktrace')).toBeUndefined();
  });
});

describe('buildSpan events seam', () => {
  it('attaches events when provided', () => {
    const ev = buildExceptionEvent({ type: 'X', message: 'm', timeMs: 1 });
    const span = buildSpan({ traceId: 't', spanId: 's1', name: 'n', startMs: 0, durationMs: 1, events: [ev] });
    expect(span.events).toEqual([ev]);
  });
  it('omits events when none provided', () => {
    const span = buildSpan({ traceId: 't', spanId: 's1', name: 'n', startMs: 0, durationMs: 1 });
    expect(span).not.toHaveProperty('events');
  });
});
