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
    // Collect the latency of EVERY cache.hit=false cart-api span so we can
    // assert on the distribution, not a single span. cart-api cache-miss latency
    // is a log-normal draw (median ~40ms, sigma ~0.4) whose left tail dips to
    // ~11ms a few percent of the time — a single-span ">15ms" check flakes there.
    const cacheMissDurations = [];
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const cartSpans = spansForService(t, 'cart-api');
      if (cartSpans.some(s => durationMs(s) > 25)) slow++;
      for (const s of cartSpans) {
        const attr = (s.attributes || []).find(a => a.key === 'cache.hit');
        if (attr && attr.value.boolValue === false) cacheMissDurations.push(durationMs(s));
      }
    }
    // 5% over 2000 ~ 100. Note: N+1 pattern can also inflate cart-api duration
    // because cart covers all sequential inv-db calls (5-10 * 5ms = 25-50ms),
    // so this count will include some N+1 overlap. We just want a roughly
    // increased count over baseline.
    expect(slow).toBeGreaterThan(70);
    expect(slow).toBeLessThan(250); // generous upper to account for N+1 overlap

    // Cache-miss spans should actually appear (~5% of 2000 ≈ 100) and carry the
    // elevated ~40ms median vs the ~8ms baseline. Asserting the MEDIAN of the
    // whole set is robust to the log-normal tail: with ~100 samples the median
    // sits near 40ms and effectively never falls below 25ms (cold-start / N+1
    // only push durations up, never down).
    expect(cacheMissDurations.length).toBeGreaterThan(30);
    const median = (arr) => {
      const a = [...arr].sort((x, y) => x - y);
      const mid = Math.floor(a.length / 2);
      return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    };
    expect(median(cacheMissDurations)).toBeGreaterThan(25);
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
    // 4% over 2000 → mean 80, binomial σ ≈ 8.8. The old floor of 55 was only
    // ~2.9σ — a ~0.2%-per-run flake that fired once CI started running this
    // suite 3× per release (failed the v1.2.4 image publish on a draw of 53).
    // ±4σ bounds: ~1-in-30k per run.
    expect(withWait).toBeGreaterThan(44);
    expect(withWait).toBeLessThan(116);
  });

  it('notification email-render slow fires on ~1.4% of traces (sample of 2000)', () => {
    let slow = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const notifySpans = spansForService(t, 'notification-svc');
      if (notifySpans.some(s => durationMs(s) > 60)) slow++;
    }
    // 2% * 70% (notification present) over 2000 → mean 28, binomial σ ≈ 5.3.
    // The old floor of 15 was only ~2.5σ (~0.6%-per-run flake — worse than the
    // pool-wait bound that actually fired in CI). ±4σ: ~1-in-30k per run.
    expect(slow).toBeGreaterThan(6);
    expect(slow).toBeLessThan(50);
  });

  it('retry storm fires on ~2% of traces with 3 sequential stripe-mock spans (sample of 5000)', () => {
    let retries = 0;
    let sample;
    for (let i = 0; i < 5000; i++) {
      const t = generateTrace();
      const stripeSpans = spansForService(t, 'stripe-mock');
      if (stripeSpans.length > 1) {
        retries++;
        if (!sample) sample = stripeSpans;
      }
    }
    // 2% over 5000 ~ 100. σ ≈ √(5000·0.02·0.98) ≈ 9.9. Bounds at -4σ / +5σ
    // catch a regression of >40% in either direction while keeping the
    // false-positive rate well below one-in-a-million. (Matches the cold-start
    // test below; the old n=2000 `> 25` lower bound sat at ~2.4σ and flaked.)
    expect(retries).toBeGreaterThan(60);
    expect(retries).toBeLessThan(150);
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

describe('inventory-db error RCA enrichment', () => {
  const flat = (arr) => Object.fromEntries((arr || []).map(a => [a.key, a.value.stringValue ?? a.value.intValue]));
  it('errored inventory-db spans carry a psycopg2 exception event + code.* attrs (sample 2000)', () => {
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const invErr = spansForService(t, 'inventory-db').find(s => s.status && s.status.code === 2);
      if (!invErr) continue;
      checked++;
      const exc = (invErr.events || []).find(e => e.name === 'exception');
      expect(exc, 'inventory error span should have an exception event').toBeTruthy();
      expect(flat(exc.attributes)['exception.type']).toBe('psycopg2.OperationalError');
      const sa = flat(invErr.attributes);
      expect(sa['code.filepath']).toBe('services/inventory/repositories/stock_repository.py');
      expect(sa['code.function']).toBe('get_stock');
      expect(String(sa['code.lineno'])).toBe('142');
    }
    expect(checked).toBeGreaterThan(20); // ~3% of 2000 ≈ 60
  });
});

describe('stripe retry-storm error RCA enrichment', () => {
  const flat = (arr) => Object.fromEntries((arr || []).map(a => [a.key, a.value.stringValue ?? a.value.intValue]));
  it('failed stripe attempts carry requests exception events + code.* (sample 2000)', () => {
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const t = generateTrace();
      const failed = spansForService(t, 'stripe-mock').filter(s => s.status && s.status.code === 2);
      if (failed.length === 0) continue; // only the retry storm errors stripe spans
      checked++;
      for (const f of failed) {
        const exc = (f.events || []).find(e => e.name === 'exception');
        expect(exc, 'failed stripe attempt should have an exception event').toBeTruthy();
        expect(flat(exc.attributes)['exception.type']).toMatch(/^requests\.exceptions\./);
        expect(flat(f.attributes)['code.filepath']).toBe('services/payment/clients/stripe_client.py');
      }
    }
    expect(checked).toBeGreaterThan(5); // ~2% of 2000 ≈ 40
  });
});

describe('generateTrace process.* resource metrics (Resources panel)', () => {
  const svcOf = (rm) => rm.resource.attributes.find((a) => a.key === 'service.name')?.value?.stringValue;
  const nsOf = (rm) => rm.resource.attributes.find((a) => a.key === 'service.namespace')?.value?.stringValue;
  const metricNames = (rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics).map((m) => m.name);

  it('emits process.cpu.utilization (0..1) + process.memory.usage (bytes) for root service checkout-web', () => {
    const t = generateTrace();
    const cw = t.metrics.resourceMetrics.find(
      (rm) => svcOf(rm) === 'checkout-web' && metricNames(rm).includes('process.cpu.utilization'),
    );
    expect(cw, 'checkout-web should carry a process.* resource').toBeTruthy();
    expect(nsOf(cw)).toBe('Helix-Configurator-Demo'); // the join namespace

    const byName = Object.fromEntries(cw.scopeMetrics.flatMap((sm) => sm.metrics).map((m) => [m.name, m]));
    const cpuDp = byName['process.cpu.utilization'].gauge.dataPoints[0];
    const cpu = cpuDp.asDouble ?? Number(cpuDp.asInt);
    expect(cpu).toBeGreaterThanOrEqual(0);
    expect(cpu).toBeLessThanOrEqual(1);

    const memDp = byName['process.memory.usage'].gauge.dataPoints[0];
    expect(memDp.asDouble ?? Number(memDp.asInt)).toBeGreaterThan(0);

    // Timestamped ~now so it lands in the trace's ±90s window / live view.
    const tsMs = Number(BigInt(cpuDp.timeUnixNano) / 1_000_000n);
    expect(Math.abs(tsMs - Date.now())).toBeLessThan(60_000);
  });

  it('round-trips through extractMetricPoints to a checkout-web series (real consumer + join key)', async () => {
    const otel = (await import('../otelStore.js')).default;
    const points = otel.extractMetricPoints(generateTrace().metrics);
    const key = otel.metricResourceKey('Helix-Configurator-Demo', 'checkout-web');
    const cw = points.filter((p) => p.resourceKey === key);
    expect(cw.some((p) => p.metricName === 'process.cpu.utilization')).toBe(true);
    expect(cw.some((p) => p.metricName === 'process.memory.usage')).toBe(true);
  });
});

describe('generateTrace span + resource attribute enrichment', () => {
  const readVal = (v = {}) => {
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.intValue !== undefined) return Number(v.intValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.boolValue !== undefined) return v.boolValue;
    return undefined;
  };
  const flatAttrs = (arr) => Object.fromEntries((arr || []).map((a) => [a.key, readVal(a.value)]));
  const allSpans = (t) => t.traces.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
  const resourceFor = (t, svc) => t.traces.resourceSpans.find((r) => serviceNameOf(r) === svc);

  it('every span carries at least one attribute — no bare spans on the happy path', () => {
    // The original complaint: healthy-trace HTTP spans rendered no Attributes
    // section because their attribute array was empty. Guard against regressing.
    sample(40, () => {
      for (const s of allSpans(generateTrace())) {
        expect((s.attributes || []).length, `${s.name} must not be attribute-less`).toBeGreaterThan(0);
      }
    });
  });

  it('checkout-web POST /checkout carries HTTP server semconv attributes', () => {
    const a = flatAttrs(spansForService(generateTrace(), 'checkout-web')[0].attributes);
    expect(a['http.request.method']).toBe('POST');
    expect(a['http.route']).toBe('/checkout');
    expect(a['url.path']).toBe('/checkout');
    expect(typeof a['http.response.status_code']).toBe('number');
    expect(a['server.address']).toBeTruthy();
  });

  it('cart-api GET /cart/items carries HTTP method GET', () => {
    const a = flatAttrs(spansForService(generateTrace(), 'cart-api')[0].attributes);
    expect(a['http.request.method']).toBe('GET');
    expect(a['http.route']).toBe('/cart/items');
    expect(typeof a['http.response.status_code']).toBe('number');
  });

  it('notification-svc carries messaging semconv attributes', () => {
    let found = null;
    for (let i = 0; i < 60 && !found; i++) {
      const ns = spansForService(generateTrace(), 'notification-svc');
      if (ns.length) found = ns[0];
    }
    expect(found, 'notification-svc should appear within 60 samples').toBeTruthy();
    const a = flatAttrs(found.attributes);
    expect(a['messaging.system']).toBeTruthy();
    expect(a['messaging.operation']).toBeTruthy();
  });

  it('inventory-db keeps its db.* semconv attributes after enrichment', () => {
    const inv = spansForService(generateTrace(), 'inventory-db')[0];
    const a = flatAttrs(inv.attributes);
    expect(a['db.system']).toBe('postgresql');
    expect(a['db.statement']).toMatch(/^SELECT/);
  });

  it('every resource carries a full OTel resource attribute set', () => {
    const t = generateTrace();
    const a = flatAttrs(resourceFor(t, 'checkout-web').resource.attributes);
    expect(a['service.name']).toBe('checkout-web');
    expect(a['service.namespace']).toBe('Helix-Configurator-Demo'); // unchanged join key
    expect(a['service.version']).toBeTruthy();
    expect(a['service.instance.id']).toBeTruthy();
    expect(a['telemetry.sdk.name']).toBe('opentelemetry');
    expect(a['telemetry.sdk.language']).toBeTruthy();
    expect(a['process.runtime.name']).toBeTruthy();
    expect(a['host.name']).toBeTruthy();
    expect(a['os.type']).toBe('linux');
    expect(a['k8s.pod.name']).toBeTruthy();
  });

  it('service.instance.id is stable for a service across traces (one process = one instance)', () => {
    const id1 = flatAttrs(resourceFor(generateTrace(), 'cart-api').resource.attributes)['service.instance.id'];
    const id2 = flatAttrs(resourceFor(generateTrace(), 'cart-api').resource.attributes)['service.instance.id'];
    expect(id1).toBeTruthy();
    expect(id1).toBe(id2);
  });

  it('different services get different telemetry.sdk.language (multi-language fleet)', () => {
    const t = generateTrace();
    const langOf = (svc) => flatAttrs(resourceFor(t, svc).resource.attributes)['telemetry.sdk.language'];
    const langs = new Set(['checkout-web', 'cart-api', 'payment-service'].map(langOf));
    expect(langs.size).toBeGreaterThan(1);
  });
});
