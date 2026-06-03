# Synthetic error-span RCA enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the synthetic demo's originating error spans emit an OTel `exception` event + `code.*` attributes so errored Situations populate `error_type` and `code_location` (file:method:line).

**Architecture:** Producer-only change in `backend/routes/step-zero/synthetic-scenario.js`. Add an `events` seam to `buildSpan` and a `buildExceptionEvent` helper, then attach an exception event + `code.*` attrs to the inventory-db error span (Pattern B) and the failed stripe attempts (Pattern G). The consumer chain (`otelStore` → `deriveProbableCause`) already handles these.

**Tech Stack:** Node (CommonJS), vitest. Spec: `docs/superpowers/specs/2026-05-30-synthetic-error-span-rca-enrichment-design.md`.

---

## File Structure

- **Modify** `backend/routes/step-zero/synthetic-scenario.js` — `buildSpan` gains an `events` param; new `buildExceptionEvent` helper + two module-level constants (inventory traceback, stripe code attrs/traceback); inventory + stripe error spans attach exception events and `code.*`; export the two helpers for unit testing.
- **Modify** `backend/__tests__/step-zero-synthetic-scenario.test.mjs` — import the two helpers; add unit tests for them and two ~2000-sample integration tests.

---

## Task 1: `buildSpan` events seam + `buildExceptionEvent` helper

**Files:**
- Modify: `backend/routes/step-zero/synthetic-scenario.js`
- Test: `backend/__tests__/step-zero-synthetic-scenario.test.mjs`

- [ ] **Step 1: Write failing tests**

In `backend/__tests__/step-zero-synthetic-scenario.test.mjs`, change the import on line 2 from:

```js
import { generateTrace } from '../routes/step-zero/synthetic-scenario.js';
```

to:

```js
import { generateTrace, buildSpan, buildExceptionEvent } from '../routes/step-zero/synthetic-scenario.js';
```

Then append (after the existing `describe('generateTrace', …)` block's closing `});`):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run __tests__/step-zero-synthetic-scenario.test.mjs`
Expected: FAIL — `buildExceptionEvent is not a function` / `buildSpan is not a function` (not exported yet).

- [ ] **Step 3: Implement the seam + helper**

In `backend/routes/step-zero/synthetic-scenario.js`, add the `events` param to `buildSpan`. Change its signature line and add the attach line next to the existing `attributes` attach:

```js
const buildSpan = ({ traceId, spanId, parentSpanId, name, startMs, durationMs, errored, errorMessage, statusCode, attributes, kind, events }) => {
```

and immediately after the existing `if (attributes && attributes.length) span.attributes = attributes;` line, add:

```js
  if (events && events.length) span.events = events;
```

Then, directly below the `buildSpan` function (after its closing `};`), add the helper:

```js
// OTel `exception` span event. otelStore reads exception.type/message/stacktrace off
// these (preferring them over the span.error fallback); deriveProbableCause then sets
// error_type/error_message from them. `code_location` comes separately from the span's
// own code.* attributes. timeMs = when the exception was recorded (span end is fine).
const buildExceptionEvent = ({ type, message, stacktrace, timeMs }) => ({
  name: 'exception',
  timeUnixNano: String(BigInt(Math.round(timeMs)) * 1_000_000n),
  attributes: [
    { key: 'exception.type', value: { stringValue: type } },
    { key: 'exception.message', value: { stringValue: message } },
    ...(stacktrace ? [{ key: 'exception.stacktrace', value: { stringValue: stacktrace } }] : []),
  ],
});
```

Then update the export line at the bottom of the file from:

```js
module.exports = { generateTrace };
```

to:

```js
module.exports = { generateTrace, buildSpan, buildExceptionEvent };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run __tests__/step-zero-synthetic-scenario.test.mjs`
Expected: PASS (new describe blocks green; existing generateTrace tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/step-zero/synthetic-scenario.js backend/__tests__/step-zero-synthetic-scenario.test.mjs
git commit -m "feat(synthetic): buildSpan events seam + buildExceptionEvent helper"
```

---

## Task 2: Pattern B — inventory-db exception + code.*

**Files:**
- Modify: `backend/routes/step-zero/synthetic-scenario.js`
- Test: `backend/__tests__/step-zero-synthetic-scenario.test.mjs`

- [ ] **Step 1: Write the failing integration test**

Append to `backend/__tests__/step-zero-synthetic-scenario.test.mjs`:

```js
describe('inventory-db error RCA enrichment', () => {
  // Helper: flatten OTLP attrs to {key: value} handling string/int values.
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run __tests__/step-zero-synthetic-scenario.test.mjs -t "inventory-db error RCA"`
Expected: FAIL — exception event is `undefined` (spans don't emit it yet).

- [ ] **Step 3: Implement the enrichment**

In `backend/routes/step-zero/synthetic-scenario.js`, add a module-level constant directly below the `buildExceptionEvent` helper from Task 1:

```js
// Short, believable Python traceback for the inventory connection failure.
const INVENTORY_DB_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "services/inventory/repositories/stock_repository.py", line 142, in get_stock',
  '    cur.execute(_STOCK_QUERY, (item_id,))',
  '  File "/usr/local/lib/python3.11/site-packages/psycopg2/__init__.py", line 122, in connect',
  '    conn = _connect(dsn, connection_factory=connection_factory, **kwasync)',
  'psycopg2.OperationalError: connection refused: inventory-db unreachable',
].join('\n');
```

In `buildInvDbAttributes` (the closure inside `generateTrace`), add the `code.*` attributes in the error case — insert directly before its `return attrs;`:

```js
    if (injectInventoryError) {
      attrs.push(
        { key: 'code.filepath', value: { stringValue: 'services/inventory/repositories/stock_repository.py' } },
        { key: 'code.function', value: { stringValue: 'get_stock' } },
        { key: 'code.lineno', value: { intValue: 142 } },
      );
    }
```

Then in the inventory-db `spans:` mapper (the `invLatencies.map(...)` that builds `SELECT stock` spans), add an `events` field to the `buildSpan({...})` call — insert it after the `kind: 3,` line:

```js
          events: injectInventoryError ? [buildExceptionEvent({
            type: 'psycopg2.OperationalError',
            message: invErrMsg,
            stacktrace: INVENTORY_DB_TRACEBACK,
            timeMs: invStartMsList[i] + dur,
          })] : undefined,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && npx vitest run __tests__/step-zero-synthetic-scenario.test.mjs -t "inventory-db error RCA"`
Expected: PASS (`checked` > 20, all assertions hold).

- [ ] **Step 5: Run the full file (no regressions)**

Run: `cd backend && npx vitest run __tests__/step-zero-synthetic-scenario.test.mjs`
Expected: PASS — including the existing inventory-cascade and N+1 tests (the new attrs/events are additive).

- [ ] **Step 6: Commit**

```bash
git add backend/routes/step-zero/synthetic-scenario.js backend/__tests__/step-zero-synthetic-scenario.test.mjs
git commit -m "feat(synthetic): inventory-db error span emits psycopg2 exception + code.* (RCA)"
```

---

## Task 3: Pattern G — stripe retry-storm exceptions + code.*

**Files:**
- Modify: `backend/routes/step-zero/synthetic-scenario.js`
- Test: `backend/__tests__/step-zero-synthetic-scenario.test.mjs`

- [ ] **Step 1: Write the failing integration test**

Append to `backend/__tests__/step-zero-synthetic-scenario.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run __tests__/step-zero-synthetic-scenario.test.mjs -t "stripe retry-storm error RCA"`
Expected: FAIL — exception event is `undefined` on the failed attempts.

- [ ] **Step 3: Implement the enrichment**

In `backend/routes/step-zero/synthetic-scenario.js`, add module-level constants directly below `INVENTORY_DB_TRACEBACK`:

```js
// Stripe client code location (the payment-service call site that raised/handled the error).
const STRIPE_CLIENT_CODE_ATTRS = [
  { key: 'code.filepath', value: { stringValue: 'services/payment/clients/stripe_client.py' } },
  { key: 'code.function', value: { stringValue: 'charge' } },
  { key: 'code.lineno', value: { intValue: 88 } },
];
const stripeTraceback = (type, message) => [
  'Traceback (most recent call last):',
  '  File "services/payment/clients/stripe_client.py", line 88, in charge',
  '    resp = self._session.post(_STRIPE_CHARGES_URL, json=payload, timeout=5)',
  `${type}: ${message}`,
].join('\n');
const STRIPE_TIMEOUT_MSG = "HTTPSConnectionPool(host='api.stripe.com', port=443): Read timed out. (read timeout=5)";
const STRIPE_503_MSG = '503 Server Error: Service Unavailable for url: /v1/charges';
```

In `buildRetryStormStripeSpans`, replace the first two `buildSpan({...})` entries (attempt 1 `timeout` and attempt 2 `service_unavailable`) with versions that add `STRIPE_CLIENT_CODE_ATTRS` and an exception event. The attempt-1 entry becomes:

```js
    buildSpan({
      traceId, spanId: randomHex(8), parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: t1Start, durationMs: attempt1,
      statusCode: 2, errorMessage: 'timeout',
      attributes: [{ key: 'retry.attempt', value: { intValue: 1 } }, ...STRIPE_CLIENT_CODE_ATTRS],
      events: [buildExceptionEvent({
        type: 'requests.exceptions.ReadTimeout', message: STRIPE_TIMEOUT_MSG,
        stacktrace: stripeTraceback('requests.exceptions.ReadTimeout', STRIPE_TIMEOUT_MSG),
        timeMs: t1Start + attempt1,
      })],
    }),
```

and the attempt-2 entry becomes:

```js
    buildSpan({
      traceId, spanId: randomHex(8), parentSpanId: paymentSpanId,
      name: 'POST /v1/charges', startMs: t2Start, durationMs: attempt2,
      statusCode: 2, errorMessage: 'service_unavailable',
      attributes: [{ key: 'retry.attempt', value: { intValue: 2 } }, ...STRIPE_CLIENT_CODE_ATTRS],
      events: [buildExceptionEvent({
        type: 'requests.exceptions.HTTPError', message: STRIPE_503_MSG,
        stacktrace: stripeTraceback('requests.exceptions.HTTPError', STRIPE_503_MSG),
        timeMs: t2Start + attempt2,
      })],
    }),
```

Leave the attempt-3 (success) span unchanged.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && npx vitest run __tests__/step-zero-synthetic-scenario.test.mjs -t "stripe retry-storm error RCA"`
Expected: PASS (`checked` > 5, all failed attempts enriched).

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS — all files green, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/step-zero/synthetic-scenario.js backend/__tests__/step-zero-synthetic-scenario.test.mjs
git commit -m "feat(synthetic): stripe retry-storm failed attempts emit requests exceptions + code.* (RCA)"
```

---

## Task 4: Live verification

**Files:** none (operational).

- [ ] **Step 1: Rebuild + restart the container**

Run: `docker compose up -d --build helix-configurator`
Expected: builds and restarts; `docker ps` shows it Up.

- [ ] **Step 2: Confirm a fresh errored trace yields populated RCA fields**

Let the generator run (it auto-emits) or trigger the demo scenario, then convert a fresh errored trace (new trace_id) via the trace-detail "Convert to event" action. Confirm the resulting event/Situation now carries non-empty `error_type` (`psycopg2.OperationalError`) and `code_location` (`services/inventory/repositories/stock_repository.py:get_stock:142`). Old events won't backfill.

---

## Self-Review

**Spec coverage:**
- `buildSpan` events seam + `buildExceptionEvent` → Task 1. ✓
- Pattern B inventory exception + code.* (psycopg2, the three paths) → Task 2. ✓
- Pattern G stripe failed-attempt exceptions + code.* (requests.*, the client path) → Task 3. ✓
- Origin selection unaffected (only originating spans get exceptions) → inherent: cascade spans untouched; tests assert on inventory-db / stripe-mock spans. ✓
- Tests mirror the ~2000-sample pattern; unit tests for the helpers; full suite green → Tasks 1–3. ✓
- Live verification → Task 4. ✓

**Placeholder scan:** none — every code step is complete; commands have expected output.

**Type/name consistency:** `buildExceptionEvent({type,message,stacktrace,timeMs})` and `buildSpan({…,events})` are defined in Task 1 and used by the same signatures in Tasks 2–3. Constants `INVENTORY_DB_TRACEBACK`, `STRIPE_CLIENT_CODE_ATTRS`, `stripeTraceback`, `STRIPE_TIMEOUT_MSG`, `STRIPE_503_MSG` are defined before use. Test helper `flat()` is redefined per describe block (self-contained). ✓
