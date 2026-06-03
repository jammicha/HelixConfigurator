# Situations RCA-Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich each `OTEL_TRACE_ANOMALY` event (and the Situation title) so it names its probable cause, links to its trace, and carries a dynamic priority + blast-radius hints — using only data already returned by `otelStore.getTrace()`.

**Architecture:** Add five pure helpers to `backend/routes/situations-payloads.js`, unit-tested in isolation (matching the module's existing "no network, no env" contract). Extend `buildAnomalyEventPayload` to use them when given `spans` — with a no-spans path that is byte-for-byte identical to today, so the 10 existing tests pass untouched. Thinly wire the route to pass the already-fetched spans + tenant id.

**Tech Stack:** Node.js (CommonJS), vitest. Tests run from `backend/` via `npm test` (`vitest run`).

**Spec:** `docs/superpowers/specs/2026-05-29-situations-rca-enrichment-design.md`

---

## File Structure

- **Modify** `backend/routes/situations-payloads.js` — add 5 pure helpers + a private `formatHelixTimestamp`; extend `buildAnomalyEventPayload`, `buildClassDefinition`, `buildCorrelationPolicy`; export the new helpers.
- **Modify** `backend/routes/situations.js` — pass `trace.spans`, the portal base URL, and `tenantId` into `buildAnomalyEventPayload` in `/convert-trace`.
- **Modify** `backend/__tests__/situations-payloads.test.mjs` — add tests for the new helpers and the enriched payload/class/policy.

All test commands run from `backend/`:
```bash
cd /Users/jammicha/dev/HelixConfigurator/backend
```

---

## Task 1: `deriveProbableCause(spans)`

Identify the originating error span and extract a human-readable cause.

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Add the test-helper factories + failing tests**

Add to the top of `backend/__tests__/situations-payloads.test.mjs`, after the existing `require` destructure, add the new names to the import and append the factories + tests at the end of the file:

First, extend the destructured import (it currently lists the original 7 names):
```js
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
  deriveProbableCause, blastRadius, anomalyFactor, priorityForTrace,
  buildHelixTraceUrlFromSummary,
} = require('../routes/situations-payloads');
```

Append at end of file:
```js
// A span shaped exactly like otelStore.getTrace().spans[]: .attributes and
// .events are already-parsed objects/arrays (NOT JSON strings).
function span(o = {}) {
  return {
    spanId: o.spanId || 's1',
    traceId: o.traceId || 't1',
    parentSpanId: o.parentSpanId ?? null,
    serviceName: o.serviceName || 'svc',
    name: o.name || 'op',
    kind: o.kind || 0,
    startTimeNs: o.startTimeNs || 0,
    endTimeNs: o.endTimeNs || 0,
    durationMs: o.durationMs || 1,
    statusCode: o.statusCode || 0,
    statusMessage: o.statusMessage || '',
    attributes: o.attributes || {},
    events: o.events || [],
  };
}
function excEvent(type, message) {
  return { name: 'exception', timeUnixNano: 1, attributes: { 'exception.type': type, 'exception.message': message } };
}

describe('deriveProbableCause', () => {
  it('extracts exception type/message, operation, service, and code location', () => {
    const spans = [
      span({ name: 'POST /checkout', serviceName: 'frontend', startTimeNs: 1 }),
      span({
        name: 'PaymentClient.charge', serviceName: 'payment', startTimeNs: 5, statusCode: 2,
        events: [excEvent('NullPointerException', 'amount was null')],
        attributes: { 'code.filepath': 'PaymentClient.java', 'code.function': 'charge', 'code.lineno': 42 },
      }),
    ];
    const c = deriveProbableCause(spans);
    expect(c.error_type).toBe('NullPointerException');
    expect(c.error_message).toBe('amount was null');
    expect(c.probable_cause_operation).toBe('PaymentClient.charge');
    expect(c.probable_cause_service).toBe('payment');
    expect(c.code_location).toBe('PaymentClient.java:charge:42');
  });

  it('falls back to statusMessage with empty error_type when no exception event', () => {
    const spans = [
      span({ name: 'GET /cart', startTimeNs: 1 }),
      span({ name: 'db.query', serviceName: 'cartdb', startTimeNs: 3, statusCode: 2, statusMessage: 'deadlock detected' }),
    ];
    const c = deriveProbableCause(spans);
    expect(c.error_message).toBe('deadlock detected');
    expect(c.error_type).toBe('');
    expect(c.probable_cause_operation).toBe('db.query');
  });

  it('picks the most downstream error span (latest start) and prefers one with an exception', () => {
    const spans = [
      span({ name: 'A', startTimeNs: 1, statusCode: 2, statusMessage: 'upstream' }),
      span({ name: 'B', startTimeNs: 9, statusCode: 2, events: [excEvent('IOError', 'socket closed')] }),
    ];
    const c = deriveProbableCause(spans);
    expect(c.probable_cause_operation).toBe('B');
    expect(c.error_type).toBe('IOError');
  });

  it('truncates very long error messages to 200 chars', () => {
    const long = 'x'.repeat(500);
    const c = deriveProbableCause([span({ statusCode: 2, events: [excEvent('E', long)] })]);
    expect(c.error_message.length).toBe(200);
  });

  it('returns all-empty for a clean (latency-only) trace', () => {
    const c = deriveProbableCause([span({ name: 'GET /ok' }), span({ name: 'GET /ok2' })]);
    expect(c).toEqual({
      probable_cause_service: '', probable_cause_operation: '',
      error_type: '', error_message: '', code_location: '',
    });
  });

  it('handles empty / non-array input without throwing', () => {
    expect(deriveProbableCause([]).error_type).toBe('');
    expect(deriveProbableCause(undefined).error_type).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `npm test -- situations-payloads`
Expected: FAIL — `deriveProbableCause is not a function` (and the 10 originals still pass).

- [ ] **Step 3: Implement `deriveProbableCause` + export it**

In `backend/routes/situations-payloads.js`, add this function above `module.exports`:
```js
// Identify the originating error span in a trace and extract a human-readable
// cause. Spans are the shape otelStore.getTrace() returns (.events/.attributes
// already parsed). Error span = ERROR status (code 2) OR carries an `exception`
// event. The originating span is the most downstream (latest start); a span with
// an actual exception event wins over one that only reports error status.
function deriveProbableCause(spans) {
  const empty = {
    probable_cause_service: '', probable_cause_operation: '',
    error_type: '', error_message: '', code_location: '',
  };
  if (!Array.isArray(spans) || spans.length === 0) return empty;

  const hasExc = (s) => Array.isArray(s.events) && s.events.some(e => e && e.name === 'exception');
  const errorSpans = spans.filter(s => s && (s.statusCode === 2 || hasExc(s)));
  if (errorSpans.length === 0) return empty;

  const pool = errorSpans.some(hasExc) ? errorSpans.filter(hasExc) : errorSpans;
  const origin = pool.reduce((a, b) => ((b.startTimeNs || 0) >= (a.startTimeNs || 0) ? b : a));

  const exc = (Array.isArray(origin.events) ? origin.events : []).find(e => e && e.name === 'exception');
  const excAttrs = (exc && exc.attributes) || {};
  const attrs = origin.attributes || {};

  const errorType = exc ? (excAttrs['exception.type'] || '') : '';
  const rawMsg = exc ? (excAttrs['exception.message'] || '') : (origin.statusMessage || '');
  const errorMessage = String(rawMsg).slice(0, 200);

  let codeLocation = '';
  if (attrs['code.filepath']) {
    codeLocation = [attrs['code.filepath'], attrs['code.function'], attrs['code.lineno']]
      .filter(v => v !== undefined && v !== null && v !== '')
      .join(':');
  }

  return {
    probable_cause_service: origin.serviceName || '',
    probable_cause_operation: origin.name || '',
    error_type: errorType,
    error_message: errorMessage,
    code_location: codeLocation,
  };
}
```

Then add `deriveProbableCause` to the `module.exports` object (keep all existing exports):
```js
module.exports = {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
  deriveProbableCause,
};
```

- [ ] **Step 4: Run the tests — verify they PASS**

Run: `npm test -- situations-payloads`
Expected: PASS — `deriveProbableCause` tests green; all 10 originals still green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): derive probable cause from trace spans"
```

---

## Task 2: `blastRadius(spans)`

Distinct participating services + count.

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to the test file:
```js
describe('blastRadius', () => {
  it('counts distinct services and joins their names', () => {
    const r = blastRadius([
      span({ serviceName: 'frontend' }),
      span({ serviceName: 'checkout' }),
      span({ serviceName: 'frontend' }),
      span({ serviceName: 'payment' }),
    ]);
    expect(r.component_count).toBe(3);
    expect(r.affected_services).toBe('frontend,checkout,payment');
  });

  it('caps the name list at 5 and summarizes the remainder', () => {
    const r = blastRadius(['a','b','c','d','e','f','g'].map(n => span({ serviceName: n })));
    expect(r.component_count).toBe(7);
    expect(r.affected_services).toBe('a,b,c,d,e +2 more');
  });

  it('returns empty for no spans', () => {
    expect(blastRadius([])).toEqual({ affected_services: '', component_count: 0 });
    expect(blastRadius(undefined)).toEqual({ affected_services: '', component_count: 0 });
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npm test -- situations-payloads`
Expected: FAIL — `blastRadius is not a function`.

- [ ] **Step 3: Implement + export**

Add above `module.exports`:
```js
// Distinct services participating in the trace — the Situation's blast radius.
// Names are capped so the slot/message stays readable; the full count is always
// reported separately.
function blastRadius(spans) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return { affected_services: '', component_count: 0 };
  }
  const distinct = [];
  for (const s of spans) {
    const n = s && s.serviceName;
    if (n && !distinct.includes(n)) distinct.push(n);
  }
  const CAP = 5;
  const shown = distinct.slice(0, CAP);
  const affected = distinct.length > CAP
    ? `${shown.join(',')} +${distinct.length - CAP} more`
    : shown.join(',');
  return { affected_services: affected, component_count: distinct.length };
}
```

Add `blastRadius` to `module.exports`.

- [ ] **Step 4: Run — verify PASS**

Run: `npm test -- situations-payloads`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): compute blast radius from trace spans"
```

---

## Task 3: `anomalyFactor` + `priorityForTrace`

Severity math: how far past p95, and the resulting PRIORITY tier.

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Add failing tests**

Append:
```js
describe('anomalyFactor', () => {
  it('rounds duration / p95 to one decimal', () => {
    expect(anomalyFactor(1864, 200)).toBe(9.3);
  });
  it('returns null when p95 is missing or zero', () => {
    expect(anomalyFactor(1864, 0)).toBeNull();
    expect(anomalyFactor(1864, undefined)).toBeNull();
  });
});

describe('priorityForTrace', () => {
  it('P1 when an error trace is also a big outlier or wide blast', () => {
    expect(priorityForTrace({ hasError: true, anomalyFactor: 5, blastCount: 1 })).toBe('PRIORITY_1');
    expect(priorityForTrace({ hasError: true, anomalyFactor: 1, blastCount: 3 })).toBe('PRIORITY_1');
  });
  it('P2 for a contained error trace', () => {
    expect(priorityForTrace({ hasError: true, anomalyFactor: 1, blastCount: 1 })).toBe('PRIORITY_2');
  });
  it('P3 / P4 / P5 scale with the latency outlier factor', () => {
    expect(priorityForTrace({ hasError: false, anomalyFactor: 5, blastCount: 1 })).toBe('PRIORITY_3');
    expect(priorityForTrace({ hasError: false, anomalyFactor: 2, blastCount: 1 })).toBe('PRIORITY_4');
    expect(priorityForTrace({ hasError: false, anomalyFactor: null, blastCount: 1 })).toBe('PRIORITY_5');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npm test -- situations-payloads`
Expected: FAIL — `anomalyFactor is not a function`.

- [ ] **Step 3: Implement + export**

Add above `module.exports`:
```js
// Duration as a multiple of the operation's p95 baseline (1 decimal); null when
// no baseline is available (manual/baseline sends).
function anomalyFactor(durationMs, p95Ms) {
  if (typeof p95Ms !== 'number' || !(p95Ms > 0)) return null;
  return Math.round((durationMs / p95Ms) * 10) / 10;
}

// Map an anomaly onto a PRIORITY tier so Situations are triage-able instead of
// uniformly CRITICAL. Errors outrank latency; a big outlier or a wide blast
// radius escalates an error to the top tier.
function priorityForTrace({ hasError, anomalyFactor: factor, blastCount }) {
  const f = typeof factor === 'number' ? factor : 0;
  const b = typeof blastCount === 'number' ? blastCount : 0;
  if (hasError && (f >= 4 || b >= 3)) return 'PRIORITY_1';
  if (hasError) return 'PRIORITY_2';
  if (f >= 4) return 'PRIORITY_3';
  if (f >= 2) return 'PRIORITY_4';
  return 'PRIORITY_5';
}
```

Add `anomalyFactor, priorityForTrace` to `module.exports`.

- [ ] **Step 4: Run — verify PASS**

Run: `npm test -- situations-payloads`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): dynamic anomaly factor + priority tiers"
```

---

## Task 4: `buildHelixTraceUrlFromSummary` (+ private `formatHelixTimestamp`)

Port the proven frontend trace deep-link contract (`utils.ts:149`) to the backend.

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Add failing tests**

Append:
```js
describe('buildHelixTraceUrlFromSummary', () => {
  const base = { baseUrl: 'https://tenant.example.com', tenantId: 'TID', source: 'JM_OTEL' };
  const summary = {
    trace_id: '86c9cd9ee99aa88fa04ba19ef5ee4f78',
    service_name: 'frontend',
    service_namespace: 'jaeger-hotrod',
    start_time_ns: 1748466199645000000,
  };

  it('builds the OTelTraceDetails dashboard URL', () => {
    const u = new URL(buildHelixTraceUrlFromSummary({ ...base, summary }));
    expect(u.pathname).toBe('/dashboards/d/OTelTraceDetails/otel-trace-details');
    expect(u.searchParams.get('orgId')).toBe('TID');
    expect(u.searchParams.get('var-OTelService')).toBe('frontend');
  });

  it('uppercases the trace id', () => {
    const u = new URL(buildHelixTraceUrlFromSummary({ ...base, summary }));
    expect(u.searchParams.get('var-TraceId')).toBe('86C9CD9EE99AA88FA04BA19EF5EE4F78');
  });

  it('uses the trace namespace, falling back to source', () => {
    const withNs = new URL(buildHelixTraceUrlFromSummary({ ...base, summary }));
    expect(withNs.searchParams.get('var-OTelNamespace')).toBe('jaeger-hotrod');
    const noNs = new URL(buildHelixTraceUrlFromSummary({ ...base, summary: { ...summary, service_namespace: '' } }));
    expect(noNs.searchParams.get('var-OTelNamespace')).toBe('JM_OTEL');
  });

  it('encodes the timestamp space as %20, never +', () => {
    const url = buildHelixTraceUrlFromSummary({ ...base, summary });
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
  });

  it('returns empty string for missing inputs or the install placeholder', () => {
    expect(buildHelixTraceUrlFromSummary({ ...base, baseUrl: '', summary })).toBe('');
    expect(buildHelixTraceUrlFromSummary({ ...base, tenantId: '', summary })).toBe('');
    expect(buildHelixTraceUrlFromSummary({ ...base, summary: { ...summary, trace_id: '' } })).toBe('');
    expect(buildHelixTraceUrlFromSummary({ ...base, baseUrl: 'https://your-tenant.onbmc.com', summary })).toBe('');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npm test -- situations-payloads`
Expected: FAIL — `buildHelixTraceUrlFromSummary is not a function`.

- [ ] **Step 3: Implement + export**

Add above `module.exports`:
```js
// Port of frontend buildHelixTraceUrl/formatHelixTimestamp
// (frontend/src/components/otel-data/utils.ts) so a backend-emitted event links
// to the exact same OTel trace waterfall the UI's "Open in Helix" uses. Keep in
// sync with that file. Returns '' (not null — slots are strings) when the link
// can't be built or the endpoint is still the install-bundle placeholder.
function formatHelixTimestamp(timeNs) {
  if (!timeNs) return '';
  const d = new Date(Math.floor(timeNs / 1e6));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date} ${time}.${pad(d.getUTCMilliseconds(), 3)}000000`;
}

function buildHelixTraceUrlFromSummary({ baseUrl, tenantId, source, summary }) {
  if (!baseUrl || !tenantId || !summary || !summary.trace_id) return '';
  if (/\/\/your-tenant\.onbmc\.com\b/i.test(baseUrl)) return '';
  const params = new URLSearchParams({
    orgId: tenantId,
    'var-BusinessService': source || '',
    'var-OTelNamespace': summary.service_namespace || source || '',
    'var-OTelService': summary.service_name || '',
    'var-TraceTimestamp': formatHelixTimestamp(summary.start_time_ns),
    'var-TraceId': String(summary.trace_id).toUpperCase(),
  });
  const qs = params.toString().replace(/\+/g, '%20');
  return `${String(baseUrl).replace(/\/+$/, '')}/dashboards/d/OTelTraceDetails/otel-trace-details?${qs}`;
}
```

Add `buildHelixTraceUrlFromSummary` to `module.exports`.

- [ ] **Step 4: Run — verify PASS**

Run: `npm test -- situations-payloads`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): port Helix trace deep-link to backend"
```

---

## Task 5: Enrich `buildAnomalyEventPayload`

Use the helpers when `spans` is supplied; keep the no-spans output byte-identical.

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Add failing tests**

Append:
```js
describe('buildAnomalyEventPayload (enriched)', () => {
  const errSummary = {
    trace_id: 'abc123', service_name: 'frontend', service_namespace: 'shop',
    root_operation: 'POST /checkout', duration_ms: 1864, span_count: 12, has_error: 1,
    start_time_ns: 1748466199645000000,
  };
  const errSpans = [
    span({ name: 'POST /checkout', serviceName: 'frontend', startTimeNs: 1 }),
    span({
      name: 'PaymentClient.charge', serviceName: 'payment', startTimeNs: 5, statusCode: 2,
      events: [excEvent('NullPointerException', 'amount was null')],
      attributes: { 'code.filepath': 'Pay.java', 'code.function': 'charge', 'code.lineno': 42 },
    }),
  ];
  const linkArgs = { baseUrl: 'https://tenant.example.com', tenantId: 'TID' };

  it('names the probable cause in msg and fills cause/blast/priority slots', () => {
    const [e] = buildAnomalyEventPayload({ summary: errSummary, p95Ms: 200, xSource: 'JM_OTEL', spans: errSpans, ...linkArgs });
    expect(e.msg).toContain('NullPointerException');
    expect(e.msg).toContain('payment/PaymentClient.charge');
    expect(e.class_slots.error_type).toBe('NullPointerException');
    expect(e.class_slots.probable_cause_operation).toBe('PaymentClient.charge');
    expect(e.class_slots.code_location).toBe('Pay.java:charge:42');
    expect(e.class_slots.anomaly_factor).toBe('9.3');
    expect(e.class_slots.component_count).toBe('2');
    expect(e.class_slots.priority).toBe('PRIORITY_1');
    expect(e.priority).toBe('PRIORITY_1');
  });

  it('puts the trace deep-link in a slot and an "Open trace:" details line', () => {
    const [e] = buildAnomalyEventPayload({ summary: errSummary, p95Ms: 200, xSource: 'JM_OTEL', spans: errSpans, ...linkArgs });
    expect(e.class_slots.trace_url).toContain('/dashboards/d/OTelTraceDetails/');
    expect(e.details).toContain('Open trace: https://tenant.example.com/dashboards/d/OTelTraceDetails/');
  });

  it('a latency-only trace gets anomaly_factor + MAJOR but no error_type', () => {
    const slow = { ...errSummary, has_error: 0, duration_ms: 900 };
    const slowSpans = [span({ serviceName: 'frontend' }), span({ serviceName: 'cart' })];
    const [e] = buildAnomalyEventPayload({ summary: slow, p95Ms: 200, xSource: 'JM_OTEL', spans: slowSpans, ...linkArgs });
    expect(e.severity).toBe('MAJOR');
    expect(e.class_slots.anomaly_factor).toBe('4.5');
    expect(e.class_slots).not.toHaveProperty('error_type');
  });

  it('without spans, output is unchanged from the legacy shape', () => {
    const [legacy] = buildAnomalyEventPayload({ summary: errSummary, p95Ms: 200, xSource: 'JM_OTEL' });
    expect(legacy.msg).toBe('OTel trace errored: frontend/POST /checkout took 1864ms');
    expect(legacy.class_slots).not.toHaveProperty('trace_url');
    expect(legacy.class_slots).not.toHaveProperty('error_type');
    expect(legacy).not.toHaveProperty('priority');
    expect(legacy.details).not.toContain('Open trace:');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npm test -- situations-payloads`
Expected: FAIL — enriched assertions fail (slots/msg not present); the legacy-shape test PASSES already.

- [ ] **Step 3: Replace `buildAnomalyEventPayload` with the enriched version**

Replace the entire existing `buildAnomalyEventPayload` function with:
```js
function buildAnomalyEventPayload({ summary, p95Ms, businessServiceKey, xSource, spans, baseUrl, tenantId }) {
  const hasError = !!summary.has_error;
  const isOutlier = typeof p95Ms === 'number' && p95Ms > 0 && summary.duration_ms > p95Ms * 2;
  const severity = hasError ? 'CRITICAL' : isOutlier ? 'MAJOR' : 'MINOR';
  const flavor = hasError ? 'errored' : isOutlier ? `outlier (>2× p95 ${Math.round(p95Ms)}ms)` : 'manual send';

  // Enrichment is opt-in: only when the caller supplies the trace's spans. With
  // no spans, every value below is null/'' and the output collapses to exactly
  // the original event shape (the legacy tests pin this).
  const hasSpans = Array.isArray(spans) && spans.length > 0;
  const cause = hasSpans ? deriveProbableCause(spans) : null;
  const blast = hasSpans ? blastRadius(spans) : null;
  const factor = hasSpans ? anomalyFactor(summary.duration_ms, p95Ms) : null;
  const priority = hasSpans
    ? priorityForTrace({ hasError, anomalyFactor: factor, blastCount: blast.component_count })
    : null;
  const traceUrl = hasSpans
    ? buildHelixTraceUrlFromSummary({ baseUrl, tenantId, source: (xSource || '').trim(), summary })
    : '';

  const msg = (hasSpans && cause && cause.error_type)
    ? `OTel anomaly: ${cause.probable_cause_service}/${cause.probable_cause_operation} — ${cause.error_type}`
      + (factor ? ` (${factor}× p95)` : '')
      + (blast.component_count > 1 ? `, ${blast.component_count} services affected` : '')
    : `OTel trace ${flavor}: ${summary.service_name}/${summary.root_operation} took ${Math.round(summary.duration_ms)}ms`;

  const detailLines = [
    `Trace ${summary.trace_id} on service ${summary.service_name}.`,
    `Root operation: ${summary.root_operation}. Duration: ${Math.round(summary.duration_ms)}ms across ${summary.span_count} span(s).`,
    hasError ? 'Trace contains at least one error span.' : '',
    isOutlier ? `Operation p95 in window: ${Math.round(p95Ms)}ms.` : '',
  ];
  if (hasSpans && cause && (cause.error_type || cause.error_message)) {
    detailLines.push(
      `Probable cause: ${cause.error_type || 'error'} in ${cause.probable_cause_service}/${cause.probable_cause_operation}`
      + `${cause.error_message ? ` — ${cause.error_message}` : ''}.`);
    if (cause.code_location) detailLines.push(`Code: ${cause.code_location}.`);
  }
  if (hasSpans && blast && blast.affected_services) detailLines.push(`Affected services: ${blast.affected_services}.`);
  if (hasSpans && traceUrl) detailLines.push(`Open trace: ${traceUrl}`);
  const details = detailLines.filter(Boolean).join('\n');

  const enrichedSlots = {};
  if (hasSpans) {
    if (cause.probable_cause_service) enrichedSlots.probable_cause_service = cause.probable_cause_service;
    if (cause.probable_cause_operation) enrichedSlots.probable_cause_operation = cause.probable_cause_operation;
    if (cause.error_type) enrichedSlots.error_type = cause.error_type;
    if (cause.error_message) enrichedSlots.error_message = cause.error_message;
    if (cause.code_location) enrichedSlots.code_location = cause.code_location;
    if (factor != null) enrichedSlots.anomaly_factor = String(factor);
    if (blast.affected_services) enrichedSlots.affected_services = blast.affected_services;
    if (blast.component_count) enrichedSlots.component_count = String(blast.component_count);
    if (traceUrl) enrichedSlots.trace_url = traceUrl;
    if (priority) enrichedSlots.priority = priority;
  }

  return [{
    class: OTEL_TRACE_ANOMALY_CLASS,
    severity,
    ...(priority ? { priority } : {}),
    status: 'OPEN',
    category: 'APPLICATION',
    msg,
    source_identifier: `helix-otel-trace:${summary.trace_id}`,
    source_attributes: { source_hostname: summary.service_name },
    details,
    class_slots: {
      helix_trace_id: summary.trace_id,
      service_name: summary.service_name || '',
      service_namespace: summary.service_namespace || '',
      root_operation: summary.root_operation,
      duration_ms: String(Math.round(summary.duration_ms)),
      span_count: String(summary.span_count),
      has_error: hasError ? '1' : '0',
      ...(isOutlier ? { p95_ms: String(Math.round(p95Ms)) } : {}),
      ...(businessServiceKey ? { service_id: businessServiceKey, business_service_key: businessServiceKey } : {}),
      x_source: (xSource || '').trim(),
      ...enrichedSlots,
    },
  }];
}
```

- [ ] **Step 4: Run — verify PASS (including all 10 originals)**

Run: `npm test -- situations-payloads`
Expected: PASS — enriched + legacy + all originals green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): enrich anomaly event with cause, link, priority"
```

---

## Task 6: Register new slots in `buildClassDefinition`

So the tenant's event class can store the enriched slots.

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Add failing test**

Append:
```js
describe('buildClassDefinition (enriched slots)', () => {
  it('declares the RCA-enrichment slots as STRING attributes', () => {
    const names = buildClassDefinition().attributes.map(a => a.name);
    for (const s of ['probable_cause_service','probable_cause_operation','error_type','error_message',
      'code_location','anomaly_factor','affected_services','component_count','trace_url','priority']) {
      expect(names).toContain(s);
    }
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npm test -- situations-payloads`
Expected: FAIL — names do not contain `probable_cause_service`.

- [ ] **Step 3: Add the slots**

In `buildClassDefinition`, inside the `attributes` array, after the `x_source` entry add:
```js
      { name: 'probable_cause_service', dataType: 'STRING', enum: false },
      { name: 'probable_cause_operation', dataType: 'STRING', enum: false },
      { name: 'error_type', dataType: 'STRING', enum: false },
      { name: 'error_message', dataType: 'STRING', enum: false },
      { name: 'code_location', dataType: 'STRING', enum: false },
      { name: 'anomaly_factor', dataType: 'STRING', enum: false },
      { name: 'affected_services', dataType: 'STRING', enum: false },
      { name: 'component_count', dataType: 'STRING', enum: false },
      { name: 'trace_url', dataType: 'STRING', enum: false },
      { name: 'priority', dataType: 'STRING', enum: false },
```

- [ ] **Step 4: Run — verify PASS**

Run: `npm test -- situations-payloads`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): register RCA-enrichment event-class slots"
```

---

## Task 7: Name the cause in the correlation-policy Situation title

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Add failing test (and pin the untouched quirks)**

Append:
```js
describe('buildCorrelationPolicy (enriched title)', () => {
  it('interpolates the cause into the aggregated Situation message', () => {
    const m = buildCorrelationPolicy().configurations[0].definition.children[0].newEvent.msg;
    expect(m).toContain('%error_type%');
    expect(m).toContain('%probable_cause_operation%');
  });
  it('still selects with NO parens and keeps empty-string brackets', () => {
    const p = buildCorrelationPolicy();
    expect(p.selectorCriteriaList[0]).toBe("class equals 'OTEL_TRACE_ANOMALY'");
    expect(p.selectorCriteriaList[0]).not.toContain('(');
    for (const c of p.configurations[0].definition.children[0].conditions) {
      expect(c.conditionBracket).toBe('');
      expect(c.endBracket).toBe('');
    }
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npm test -- situations-payloads`
Expected: FAIL — msg does not contain `%error_type%` (the bracket assertions already pass).

- [ ] **Step 3: Update only the `newEvent.msg` string**

In `buildCorrelationPolicy`, replace the `newEvent.msg` value (leave every other field, the selector, and the conditions exactly as-is) with:
```js
            msg: 'OTel anomaly on %service_name% / %service_namespace%: %error_type% in %probable_cause_operation% (%anomaly_factor%× p95). Latest trace: %helix_trace_id% — investigate correlated traces.',
```

- [ ] **Step 4: Run — verify PASS**

Run: `npm test -- situations-payloads`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): name probable cause in correlation Situation title"
```

---

## Task 8: Wire the route to pass spans + tenant + portal base

The builder is enriched but `/convert-trace` still calls it without spans. Pass them.

**Files:**
- Modify: `backend/routes/situations.js`

- [ ] **Step 1: Confirm the import already includes `splitApiKey`**

`backend/routes/situations.js` already imports `splitApiKey` (used by `getHelixBearerToken`). No import change needed. Verify:

Run: `grep -n "splitApiKey" backend/routes/situations.js`
Expected: it appears in the destructured `require('./situations-payloads')`.

- [ ] **Step 2: Pass the new args into `buildAnomalyEventPayload`**

In `/api/situations/convert-trace`, replace the existing builder call:
```js
    const summary = trace.summary;
    const payload = buildAnomalyEventPayload({
      summary,
      p95Ms,
      businessServiceKey: (process.env.BUSINESS_SERVICE_KEY || '').trim(),
      xSource: process.env.X_SOURCE,
    });
```
with:
```js
    const summary = trace.summary;
    // The trace deep-link points at the portal dashboard, which lives at the
    // HELIX_ENDPOINT origin (the events base URL may be a different host/path).
    // tenantId is the first segment of the API key (TenantID::Access::Secret).
    const tenantId = (splitApiKey(apiKey) || {}).tenantId || '';
    const portalBaseUrl = (process.env.HELIX_ENDPOINT || '').trim();
    const payload = buildAnomalyEventPayload({
      summary,
      p95Ms,
      businessServiceKey: (process.env.BUSINESS_SERVICE_KEY || '').trim(),
      xSource: process.env.X_SOURCE,
      spans: trace.spans,
      baseUrl: portalBaseUrl,
      tenantId,
    });
```

- [ ] **Step 3: Verify the file still parses**

Run: `node -e "require('./backend/routes/situations.js'); console.log('situations.js OK')"`
Expected: `situations.js OK` (from the repo root). If run from `backend/`, use `require('./routes/situations.js')`.

- [ ] **Step 4: Smoke-test the enriched payload end-to-end (no network)**

Run from `backend/`:
```bash
node -e "
const { buildAnomalyEventPayload } = require('./routes/situations-payloads');
const summary = { trace_id:'abc', service_name:'frontend', service_namespace:'shop', root_operation:'POST /checkout', duration_ms:1864, span_count:12, has_error:1, start_time_ns:1748466199645000000 };
const spans = [
  { serviceName:'frontend', name:'POST /checkout', startTimeNs:1, statusCode:0, attributes:{}, events:[] },
  { serviceName:'payment', name:'PaymentClient.charge', startTimeNs:5, statusCode:2, attributes:{'code.filepath':'Pay.java','code.function':'charge','code.lineno':42}, events:[{name:'exception',attributes:{'exception.type':'NullPointerException','exception.message':'amount was null'}}] },
];
const [e] = buildAnomalyEventPayload({ summary, p95Ms:200, xSource:'JM_OTEL', spans, baseUrl:'https://tenant.example.com', tenantId:'TID' });
console.log('MSG:', e.msg);
console.log('PRIORITY:', e.priority);
console.log('TRACE_URL:', e.class_slots.trace_url);
console.log('DETAILS:\n' + e.details);
"
```
Expected: `MSG:` names `NullPointerException` and `payment/PaymentClient.charge`; `PRIORITY: PRIORITY_1`; `TRACE_URL:` an `/dashboards/d/OTelTraceDetails/` link with `%20`; `DETAILS:` includes a "Probable cause:", "Code: Pay.java:charge:42", and "Open trace:" line.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations.js
git commit -m "feat(situations): pass trace spans + tenant into enriched event builder"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the entire backend test suite**

Run from `backend/`: `npm test`
Expected: all test files pass — the 10 original `situations-payloads` tests plus the new ones, and every other suite (`otelStore`, `detect-collectors`, etc.) unchanged/green.

- [ ] **Step 2: Confirm the working tree is intentional**

Run: `git status` and `git --no-pager log --oneline -8`
Expected: only `backend/routes/situations-payloads.js`, `backend/routes/situations.js`, and `backend/__tests__/situations-payloads.test.mjs` changed across the task commits; `docs/` remains untracked (repo convention).

---

## Self-Review (completed during planning)

**Spec coverage:** deriveProbableCause → T1; blastRadius → T2; anomalyFactor/priorityForTrace → T3; trace deep-link → T4; enriched payload (msg/details/slots/priority + byte-identical no-spans path) → T5; class slots → T6; correlation title + untouched quirks → T7; route wiring (spans/baseUrl/tenantId, portal-origin URL) → T8; full suite → T9. All spec sections mapped.

**Placeholder scan:** none — every code step contains complete code; every run step has an exact command + expected output.

**Type/name consistency:** helper names, the `{ hasError, anomalyFactor, blastCount }` arg shape, slot names, and the `{ baseUrl, tenantId, source, summary }` signature are identical across the tasks that define and consume them. Builder opts `{ summary, p95Ms, businessServiceKey, xSource, spans, baseUrl, tenantId }` match the route call in T8.

**Note vs spec:** `blastRadius` truncation uses a `"+N more"` summary (preserves the count) rather than the spec's `…` sketch — a cosmetic refinement; the slice scope is unchanged.
