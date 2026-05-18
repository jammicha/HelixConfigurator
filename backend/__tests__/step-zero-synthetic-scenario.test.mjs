import { describe, it, expect } from 'vitest';
import { generateTrace } from '../routes/step-zero/synthetic-scenario.js';

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
});
