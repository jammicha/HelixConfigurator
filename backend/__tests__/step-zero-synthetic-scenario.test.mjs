import { describe, it, expect } from 'vitest';
import { generateTrace } from '../routes/step-zero/synthetic-scenario.js';

const sample = (n, fn) => Array.from({ length: n }, fn);

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
        const nameAttr = rs.resource.attributes.find(a => a.key === 'service.name');
        services.add(nameAttr.value.stringValue);
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

  it('injects payment failure on ~5% of traces (sample of 2000)', () => {
    let failed = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      // status.code === 2 is OTLP ERROR
      const hasError = t.traces.resourceSpans.some(rs =>
        rs.scopeSpans.some(ss => ss.spans.some(s => s.status && s.status.code === 2))
      );
      if (hasError) failed++;
    }
    // 5% ± 2% over 2000 samples is well within statistical bounds.
    expect(failed).toBeGreaterThan(60);
    expect(failed).toBeLessThan(140);
  });

  it('inventory contention spikes ~2% of inventory-db spans (sample of 2000)', () => {
    let slow = 0;
    let inventorySpans = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      for (const rs of t.traces.resourceSpans) {
        const nameAttr = rs.resource.attributes.find(a => a.key === 'service.name');
        if (nameAttr.value.stringValue !== 'inventory-db') continue;
        for (const ss of rs.scopeSpans) {
          for (const s of ss.spans) {
            inventorySpans++;
            const durMs = Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1_000_000;
            if (durMs > 50) slow++;
          }
        }
      }
    }
    // Among inventory-db spans, 2% ± 1.5% should be slow (>50ms).
    const ratio = slow / inventorySpans;
    expect(ratio).toBeGreaterThan(0.005);
    expect(ratio).toBeLessThan(0.05);
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
