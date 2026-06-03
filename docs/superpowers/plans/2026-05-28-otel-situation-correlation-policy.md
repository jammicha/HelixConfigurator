# OTel Situation Correlation Policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the configurator provision a deterministic BMC correlation policy (and the slots it needs) so `OTEL_TRACE_ANOMALY` events aggregate, per service, into AIOps Situations — with a clickable `trace_url` on each event.

**Architecture:** Pure payload/decision builders in a new `backend/routes/situations-payloads.js` module (unit-tested, no network); `backend/routes/situations.js` imports them and adds a `provision-correlation-policy` route + slot enrichment, following the existing `provision-class` HTTP pattern (axios, `apiKey` auth, `validateStatus`, soft-success). Frontend adds two provision buttons to `HelixConnectionSettingsDrawer`.

**Tech Stack:** Node/Express + axios (backend), better-sqlite3 store (read-only here), Vitest (`npm --prefix backend test`); React + TypeScript + Vitest (`npm --prefix frontend test`).

**Spec:** `docs/superpowers/specs/2026-05-28-otel-situation-correlation-policy-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/routes/situations-payloads.js` (**create**) | Pure builders: class definition, anomaly-event payload, correlation policy, upsert decision. No network, no `process.env` reads — all inputs passed in. |
| `backend/__tests__/situations-payloads.test.mjs` (**create**) | Unit tests for the pure builders. |
| `backend/routes/situations.js` (**modify**) | Import builders; add `provision-correlation-policy` route; enhance `provision-class` to add slots to an existing class; route now reads env and delegates payload shape to the builders. |
| `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx` (**modify**) | Add a "Provisioning" section with two buttons (event class, correlation policy) + inline status. Self-contained `useState`; POSTs against saved config. |

Decomposition rationale: all payload *shape* and *decision* logic is pure and lives in one tested module; `situations.js` keeps only HTTP orchestration (mirrors how the codebase already isolates `otelStore` logic from routes).

---

## Task 1: Validate `/event_policies` auth + CRUD shape (manual probe — GATES everything)

This is an exploratory probe against a **real tenant**, not a code task. It removes the two open risks before any code depends on them. Do NOT skip — the rest of the plan assumes its findings.

**Files:** none (records findings inline in the plan / commit message).

- [ ] **Step 1: Confirm the `apiKey` scheme works for listing policies**

Run (substitute the tenant base + key already used by the configurator):

```bash
BASE="https://<tenant>"            # same origin convert-trace/provision-class use
KEY="<TenantID::AccessKey::SecretKey>"
curl -s -o /tmp/pol.json -w "%{http_code}\n" \
  -H "Authorization: apiKey ${KEY}" \
  "${BASE}/events-service/api/v1.0/event_policies"
cat /tmp/pol.json | head -c 2000; echo
```

Expected: `200`. Record the JSON shape — specifically **where the policy `id` and `name` live** in each list item (e.g. top-level `id`/`name`, or nested). This shape is used by `selectPolicyUpsert` parsing in Task 3.

- [ ] **Step 2: If Step 1 returns 401/403, capture the JWT path instead**

If `apiKey` is rejected, the events *ingest* key is not accepted for policy management. Record that finding and STOP — report to the human: the policy route needs a JWT obtained from the Helix access/authentication endpoint, which is a design addition (token exchange) beyond this plan's `apiKey` assumption. Do not proceed to Task 3 until the auth path is decided.

- [ ] **Step 3: Confirm the class-update path (for Task 5)**

Check whether an existing class accepts added slots via the classes endpoint:

```bash
curl -s -o /tmp/cls.json -w "%{http_code}\n" \
  -H "Authorization: apiKey ${KEY}" \
  "${BASE}/events-service/api/v1.0/events/classes/OTEL_TRACE_ANOMALY"
cat /tmp/cls.json | head -c 1500; echo
```

Record: the GET shape, and whether updates use `PUT /events/classes/{name}` or a `POST` with the full attribute list. Note in the plan which verb Task 5 will use.

- [ ] **Step 4: Record findings**

Append a short note to this task in the plan file: chosen auth scheme, policy list item `id`/`name` path, and class-update verb. Commit the plan note:

```bash
git add docs/superpowers/plans/2026-05-28-otel-situation-correlation-policy.md 2>/dev/null || true
git commit -m "docs(plan): record Helix event_policies auth + CRUD findings" --allow-empty
```
(Note: `docs/` is gitignored in this repo, so this commit may be empty/skipped — that's fine; the findings live in the working copy.)

---

## Task 2: Pure payload + decision builders (TDD)

**Files:**
- Create: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `backend/__tests__/situations-payloads.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, selectPolicyUpsert,
} = require('../routes/situations-payloads');

const summary = {
  trace_id: '471e26391536a66fa17429e69bffd45f',
  service_name: 'traffic-generator',
  service_namespace: 'jaeger-hotrod',
  root_operation: 'scenario.iteration',
  duration_ms: 1864.4,
  span_count: 42,
  has_error: 1,
};

describe('buildClassDefinition', () => {
  it('declares the new first-class slots', () => {
    const def = buildClassDefinition();
    const names = def.attributes.map(a => a.name);
    expect(def.name).toBe(OTEL_TRACE_ANOMALY_CLASS);
    expect(def.parentClassName).toBe('EVENT');
    expect(names).toEqual(expect.arrayContaining(['helix_trace_id', 'service_name', 'service_namespace', 'trace_url']));
  });
  it('keeps helix_trace_id as the dedup slot', () => {
    const slot = buildClassDefinition().attributes.find(a => a.name === 'helix_trace_id');
    expect(slot.allFacet).toEqual(expect.arrayContaining([{ name: 'dup_detect', value: 'true' }]));
  });
});

describe('buildAnomalyEventPayload', () => {
  it('populates service_name, service_namespace and trace_url slots', () => {
    const [evt] = buildAnomalyEventPayload({ summary, p95Ms: 200, businessServiceKey: 'BSKEY', xSource: 'JM_OTEL', appUrl: 'https://cfg.example.com/' });
    expect(evt.class).toBe(OTEL_TRACE_ANOMALY_CLASS);
    expect(evt.class_slots.service_name).toBe('traffic-generator');
    expect(evt.class_slots.service_namespace).toBe('jaeger-hotrod');
    expect(evt.class_slots.trace_url).toBe('https://cfg.example.com/otel-data?selected=471e26391536a66fa17429e69bffd45f');
    expect(evt.class_slots.helix_trace_id).toBe(summary.trace_id);
    expect(evt.source_attributes.source_hostname).toBe('traffic-generator');
  });
  it('maps severity: error->CRITICAL, outlier->MAJOR, else MINOR', () => {
    expect(buildAnomalyEventPayload({ summary, appUrl: '' })[0].severity).toBe('CRITICAL');
    const slow = { ...summary, has_error: 0, duration_ms: 500 };
    expect(buildAnomalyEventPayload({ summary: slow, p95Ms: 200, appUrl: '' })[0].severity).toBe('MAJOR');
    expect(buildAnomalyEventPayload({ summary: slow, p95Ms: 0, appUrl: '' })[0].severity).toBe('MINOR');
  });
  it('omits trace_url when appUrl is empty', () => {
    const [evt] = buildAnomalyEventPayload({ summary, appUrl: '' });
    expect(evt.class_slots.trace_url).toBe('');
  });
});

describe('buildCorrelationPolicy', () => {
  it('is a CORRELATION policy selecting on the custom class', () => {
    const p = buildCorrelationPolicy();
    expect(p.name).toBe(CORRELATION_POLICY_NAME);
    expect(p.types).toEqual(['CORRELATION']);
    expect(p.selectorCriteriaList.join(' ')).toContain("class equals 'OTEL_TRACE_ANOMALY'");
  });
  it('groups by service_name + service_namespace and outputs a non-restricted class', () => {
    const agg = buildCorrelationPolicy().configurations[0].definition.children[0];
    const slots = agg.conditions.map(c => `${c.slotName}=${c.slotValue}`);
    expect(slots).toEqual(expect.arrayContaining([
      '$NEW.service_name=$OLD.service_name',
      '$NEW.service_namespace=$OLD.service_namespace',
    ]));
    expect(agg.within).toBe(15);
    expect(agg.minCount).toBe(3);
    expect(['Anomaly', 'Prediction', 'Situation']).not.toContain(agg.newEvent.newEventClass);
  });
});

describe('selectPolicyUpsert', () => {
  it('returns POST when no policy matches the name', () => {
    expect(selectPolicyUpsert([{ id: '1', name: 'other' }], CORRELATION_POLICY_NAME)).toEqual({ method: 'POST' });
  });
  it('returns PUT with the matched id when a policy matches the name', () => {
    const existing = [{ id: '9', name: CORRELATION_POLICY_NAME }];
    expect(selectPolicyUpsert(existing, CORRELATION_POLICY_NAME)).toEqual({ method: 'PUT', id: '9' });
  });
  it('tolerates a non-array input', () => {
    expect(selectPolicyUpsert(null, CORRELATION_POLICY_NAME)).toEqual({ method: 'POST' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix backend test -- situations-payloads`
Expected: FAIL — `Cannot find module '../routes/situations-payloads'`.

- [ ] **Step 3: Implement the module**

Create `backend/routes/situations-payloads.js`:

```js
// Pure builders for the OTel→AIOps event/policy payloads. No network, no
// process.env reads — all inputs are passed in so this module is unit-tested
// in isolation. situations.js wires these to the Events API.

const OTEL_TRACE_ANOMALY_CLASS = 'OTEL_TRACE_ANOMALY';
const CORRELATION_POLICY_NAME = 'HelixConfigurator-OTel-Trace-Anomaly';

// Custom event class. Inherits EVENT; helix_trace_id is the dedup slot.
// service_name/service_namespace are first-class so the correlation policy can
// group on them unconditionally (service_id is only present when a business
// service key is configured). trace_url gives a one-click jump back to the
// configurator's trace view from the Situation's secondary events.
function buildClassDefinition() {
  return {
    name: OTEL_TRACE_ANOMALY_CLASS,
    parentClassName: 'EVENT',
    attributes: [
      { name: 'helix_trace_id', dataType: 'STRING', enum: false, allFacet: [
        { name: 'dup_detect', value: 'true' },
        { name: 'mandatory', value: 'true' },
      ] },
      { name: 'service_name', dataType: 'STRING', enum: false },
      { name: 'service_namespace', dataType: 'STRING', enum: false },
      { name: 'trace_url', dataType: 'STRING', enum: false },
      { name: 'root_operation', dataType: 'STRING', enum: false },
      { name: 'duration_ms', dataType: 'STRING', enum: false },
      { name: 'p95_ms', dataType: 'STRING', enum: false },
      { name: 'span_count', dataType: 'STRING', enum: false },
      { name: 'has_error', dataType: 'STRING', enum: false },
      { name: 'service_id', dataType: 'STRING', enum: false },
      { name: 'business_service_key', dataType: 'STRING', enum: false },
      { name: 'x_source', dataType: 'STRING', enum: false },
    ],
  };
}

// The slots added since the class first shipped — used by provision-class to
// patch an already-registered class (Task 5).
const ADDED_SLOTS = ['service_name', 'service_namespace', 'trace_url'];

function buildAnomalyEventPayload({ summary, p95Ms, businessServiceKey, xSource, appUrl }) {
  const hasError = !!summary.has_error;
  const isOutlier = typeof p95Ms === 'number' && p95Ms > 0 && summary.duration_ms > p95Ms * 2;
  const severity = hasError ? 'CRITICAL' : isOutlier ? 'MAJOR' : 'MINOR';
  const base = (appUrl || '').replace(/\/+$/, '');
  const traceUrl = base ? `${base}/otel-data?selected=${summary.trace_id}` : '';
  const flavor = hasError ? 'errored' : isOutlier ? `outlier (>2x p95 ${Math.round(p95Ms)}ms)` : 'manual send';
  const msg = `OTel trace ${flavor}: ${summary.service_name}/${summary.root_operation} took ${Math.round(summary.duration_ms)}ms`;
  const details = [
    `Trace ${summary.trace_id} on service ${summary.service_name}.`,
    `Root operation: ${summary.root_operation}. Duration: ${Math.round(summary.duration_ms)}ms across ${summary.span_count} span(s).`,
    hasError ? 'Trace contains at least one error span.' : '',
    isOutlier ? `Operation p95 in window: ${Math.round(p95Ms)}ms.` : '',
    traceUrl ? `Inspect in configurator: ${traceUrl}` : '',
  ].filter(Boolean).join('\n');

  return [{
    class: OTEL_TRACE_ANOMALY_CLASS,
    severity,
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
      trace_url: traceUrl,
      root_operation: summary.root_operation,
      duration_ms: String(Math.round(summary.duration_ms)),
      span_count: String(summary.span_count),
      has_error: hasError ? '1' : '0',
      ...(isOutlier ? { p95_ms: String(Math.round(p95Ms)) } : {}),
      ...(businessServiceKey ? { service_id: businessServiceKey, business_service_key: businessServiceKey } : {}),
      x_source: (xSource || '').trim(),
    },
  }];
}

// Deterministic per-service correlation policy. newEventClass must NOT be
// Anomaly/Prediction/Situation (restricted as aggregate output).
function buildCorrelationPolicy() {
  return {
    name: CORRELATION_POLICY_NAME,
    description: 'Aggregates OTEL_TRACE_ANOMALY events per service into a Situation. Managed by Helix Configurator.',
    types: ['CORRELATION'],
    enabled: true,
    executionOrder: 100,
    selectorCriteriaList: ["( class equals 'OTEL_TRACE_ANOMALY' )"],
    configurations: [{
      type: 'CORRELATION',
      configOrder: 1,
      definition: {
        type: 'root',
        label: 'policy',
        children: [{
          type: 'aggregate',
          within: 15,
          minCount: 3,
          conditions: [
            { slotName: '$NEW.service_name', slotOperator: 'equals', slotValue: '$OLD.service_name' },
            { slotName: '$NEW.service_namespace', slotOperator: 'equals', slotValue: '$OLD.service_namespace' },
          ],
          newEvent: {
            newEventClass: 'ALARM',
            severity: 'MAJOR',
            priority: 'PRIORITY_3',
            status: 'OPEN',
            msg: 'OTel anomaly cluster on %service_name% (%service_namespace%) - %msg%',
          },
        }],
      },
    }],
  };
}

// Decide create vs update from the policy list returned by the API. Adjust the
// `.id`/`.name` access here if Task 1 found a different list-item shape.
function selectPolicyUpsert(existingPolicies, name) {
  const list = Array.isArray(existingPolicies) ? existingPolicies : [];
  const match = list.find(p => p && p.name === name);
  return match ? { method: 'PUT', id: match.id } : { method: 'POST' };
}

module.exports = {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, selectPolicyUpsert,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix backend test -- situations-payloads`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): pure builders for OTel event class, payload, correlation policy"
```

---

## Task 3: Add the `provision-correlation-policy` route (idempotent upsert)

**Files:**
- Modify: `backend/routes/situations.js` (add route inside `register`, near `provision-class`)

- [ ] **Step 1: Import the builders at the top of `situations.js`**

Add under the existing `require('axios')` line:

```js
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, selectPolicyUpsert,
} = require('./situations-payloads');
```

Then delete the now-duplicated local `const OTEL_TRACE_ANOMALY_CLASS = ...` declaration in the file (the import replaces it).

- [ ] **Step 2: Add the route** (place after the `provision-class` handler, before the closing `}` of `register`)

```js
  // Provision (idempotently) the per-service correlation policy that turns
  // OTEL_TRACE_ANOMALY events into Situations. Follows the same auth/host
  // pattern as provision-class. Upsert: list policies, match by name, PUT or POST.
  app.post('/api/situations/provision-correlation-policy', async (req, res) => {
    const apiKey = (process.env.HELIX_API_KEY || '').trim();
    if (!apiKey) return res.status(412).json({ error: 'HELIX_API_KEY not configured - set it on the Settings page first.' });
    const baseUrl = resolveEventsBaseUrl();
    if (!baseUrl) return res.status(412).json({ error: 'No events endpoint configured - set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });

    const headers = { 'Content-Type': 'application/json', Authorization: `apiKey ${apiKey}` };
    const policiesUrl = `${baseUrl}/events-service/api/v1.0/event_policies`;
    try {
      // List existing policies to decide create vs update (Task 1 confirmed the shape).
      const list = await axios.get(policiesUrl, { headers, timeout: 15_000, validateStatus: () => true });
      const existing = Array.isArray(list.data) ? list.data : (list.data && list.data.responseContent) || [];
      const action = selectPolicyUpsert(existing, CORRELATION_POLICY_NAME);
      const policy = buildCorrelationPolicy();

      const writeUrl = action.method === 'PUT' ? `${policiesUrl}/${action.id}` : policiesUrl;
      const response = await axios({
        method: action.method, url: writeUrl, headers, data: policy,
        timeout: 15_000, validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return res.json({ ok: true, action: action.method, policyName: CORRELATION_POLICY_NAME, upstream: response.data });
      }
      return res.status(502).json({ error: `Helix event_policies API returned ${response.status}`, upstream: response.data });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Helix event_policies API', details: e.message });
    }
  });
```

> Adjust the `existing` extraction line to match the list shape Task 1 recorded if it differs from `Array.isArray(data)` / `data.responseContent`.

- [ ] **Step 3: Run the existing backend suite to confirm no regressions**

Run: `npm --prefix backend test`
Expected: PASS (109 prior + the new situations-payloads tests). No new unit test for the route itself — its logic is covered by `selectPolicyUpsert` (Task 2); the HTTP path is exercised in the Task 7 smoke.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/situations.js
git commit -m "feat(situations): provision-correlation-policy route (idempotent upsert)"
```

---

## Task 4: Enrich `convert-trace` via the builder (adds the new slots)

**Files:**
- Modify: `backend/routes/situations.js` (the `convert-trace` handler body)

- [ ] **Step 1: Replace the inline payload construction with the builder**

In `convert-trace`, after `const trace = otelStore.getTrace(...)` and the env reads, replace the inline `const summary = ...; const payload = [{...}]` block with:

```js
    const summary = trace.summary;
    const payload = buildAnomalyEventPayload({
      summary,
      p95Ms,
      businessServiceKey: (process.env.BUSINESS_SERVICE_KEY || '').trim(),
      xSource: process.env.X_SOURCE,
      appUrl: process.env.APP_URL,
    });
    // severity for the response body comes from the built event
    const severity = payload[0].severity;
```

Keep the existing axios POST to `${baseUrl}/events-service/api/v1.0/events` and the response handling unchanged.

- [ ] **Step 2: Run the backend suite**

Run: `npm --prefix backend test`
Expected: PASS. (The payload shape is pinned by Task 2's tests; this step just routes `convert-trace` through the same builder.)

- [ ] **Step 3: Commit**

```bash
git add backend/routes/situations.js
git commit -m "refactor(situations): build convert-trace payload via shared builder + new slots"
```

---

## Task 5: Enhance `provision-class` to add slots to an existing class

**Files:**
- Modify: `backend/routes/situations.js` (the `provision-class` handler)

- [ ] **Step 1: Use the builder for the class def, and patch on already-exists**

Replace the inline `classDef` with `buildClassDefinition()`, and in the already-exists branch, issue the class-update call recorded in Task 1 to add `ADDED_SLOTS`. Using the verb Task 1 confirmed (shown here as `PUT /events/classes/{name}` with the full definition — adjust if Task 1 found `POST`):

```js
    const classDef = buildClassDefinition();
    const url = `${baseUrl}/events-service/api/v1.0/events/classes`;
    // ... existing POST attempt unchanged ...
    // In the already-exists branch (after detecting 409 / "already exists"):
    const updateUrl = `${url}/${OTEL_TRACE_ANOMALY_CLASS}`;
    const upd = await axios.put(updateUrl, classDef, { headers: { 'Content-Type': 'application/json', Authorization: `apiKey ${apiKey}` }, timeout: 15_000, validateStatus: () => true });
    if (upd.status >= 200 && upd.status < 300) {
      return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, updated: true, addedSlots: ADDED_SLOTS, upstream: upd.data });
    }
    return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, alreadyExists: true, slotUpdate: `failed (${upd.status})`, upstream: upd.data });
```

> If Task 1 found that classes cannot be updated via API, skip the PUT and instead return `alreadyExists: true` with a note that new slots require dropping/recreating the class — and record that limitation in the spec's "Open risks" section.

- [ ] **Step 2: Run the backend suite**

Run: `npm --prefix backend test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/situations.js
git commit -m "feat(situations): provision-class adds new slots to an existing class"
```

---

## Task 6: Frontend provisioning buttons

**Files:**
- Modify: `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx`

- [ ] **Step 1: Add provisioning state + handlers inside the component**

After the existing `useEffect`s and before `if (!open) return null;`, add:

```tsx
  type ProvState = 'idle' | 'running' | 'done' | 'error';
  const [classState, setClassState] = React.useState<ProvState>('idle');
  const [classMsg, setClassMsg] = React.useState('');
  const [policyState, setPolicyState] = React.useState<ProvState>('idle');
  const [policyMsg, setPolicyMsg] = React.useState('');

  const provision = async (
    path: string,
    setState: (s: ProvState) => void,
    setMsg: (m: string) => void,
    okMsg: string,
  ) => {
    setState('running'); setMsg('');
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setState('done'); setMsg(data.alreadyExists ? `${okMsg} (already existed)` : okMsg); }
      else { setState('error'); setMsg(data.error || `Request failed (${res.status})`); }
    } catch (e: any) { setState('error'); setMsg(e.message || 'Network error'); }
  };
```

- [ ] **Step 2: Add the Provisioning section to the drawer body**

Inside the `<div className="flex-1 p-6 space-y-5">`, after the Business Service Key field's closing `</div>`, add:

```tsx
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">AIOps Provisioning</div>
            <p className="text-tiny text-gray-500">Provisions against your <em>saved</em> connection. Update settings first, then provision the event class, then the correlation policy.</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => provision('/api/situations/provision-class', setClassState, setClassMsg, 'Event class provisioned')}
                disabled={classState === 'running'}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded border border-gray-800 hover:border-active text-sm font-semibold text-gray-200 disabled:opacity-60"
              >
                {classState === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
                1. Provision event class
              </button>
              {classMsg && <span className={`text-tiny ${classState === 'error' ? 'text-danger-text' : 'text-gray-400'}`}>{classMsg}</span>}
              <button
                type="button"
                onClick={() => provision('/api/situations/provision-correlation-policy', setPolicyState, setPolicyMsg, 'Correlation policy provisioned')}
                disabled={policyState === 'running'}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded border border-gray-800 hover:border-active text-sm font-semibold text-gray-200 disabled:opacity-60"
              >
                {policyState === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
                2. Provision correlation policy
              </button>
              {policyMsg && <span className={`text-tiny ${policyState === 'error' ? 'text-danger-text' : 'text-gray-400'}`}>{policyMsg}</span>}
            </div>
          </div>
```

(`Loader2` is already imported; `React` is already imported.)

- [ ] **Step 3: Type-check + build**

Run: `npm --prefix frontend run build`
Expected: PASS (tsc clean, vite build succeeds).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx
git commit -m "feat(settings): provision event class + correlation policy buttons"
```

---

## Task 7: End-to-end manual smoke (against the tenant)

**Files:** none.

- [ ] **Step 1: Provision, then drive anomalies**

1. In the settings drawer: Update Settings → "Provision event class" → "Provision correlation policy" (each returns ok).
2. Send ≥3 `OTEL_TRACE_ANOMALY` events for the **same** service within 15 min (use the trace drawer "Send to AIOps" on 3+ anomalous traces of one service, or the synthetic generator).

- [ ] **Step 2: Verify in AIOps**

- A Situation forms for that service.
- Its secondary events are the individual anomaly events, each carrying `trace_url` and `helix_trace_id`.
- The `trace_url` round-trips to the configurator's trace view.

- [ ] **Step 3: Record results** in the spec's Verification section; note any shape adjustments made to Task 3/5 from Task 1 findings.

---

## Self-Review

**Spec coverage:**
- Backend `provision-correlation-policy` endpoint → Task 3. ✓
- Idempotent upsert (match by name) → `selectPolicyUpsert` (Task 2) + Task 3. ✓
- Policy: CORRELATION, selector on class, group by service_name+namespace, within/minCount, non-restricted aggregate class → Task 2 (`buildCorrelationPolicy`) + tests. ✓
- New slots `service_name`/`service_namespace`/`trace_url` on class + convert-trace → Tasks 2, 4, 5. ✓
- `provision-class` updates an existing class → Task 5. ✓
- Auth (apiKey vs JWT) + CRUD shape de-risked first → Task 1 (gate). ✓
- Frontend buttons in `HelixConnectionSettingsDrawer` → Task 6. ✓
- Error handling (412 / verbatim upstream / soft-success) → Tasks 3, 5 follow the existing pattern. ✓
- Testing (pure builder unit tests + manual smoke) → Tasks 2, 7. ✓

**Placeholder scan:** No "TBD"/"add error handling"-style gaps; the only "adjust per Task 1" notes are explicit, bounded de-risk hooks for confirmed-unknown external shapes, not vague work.

**Type consistency:** `buildClassDefinition` / `buildAnomalyEventPayload` / `buildCorrelationPolicy` / `selectPolicyUpsert` / `OTEL_TRACE_ANOMALY_CLASS` / `CORRELATION_POLICY_NAME` / `ADDED_SLOTS` are defined in Task 2 and referenced with identical names/signatures in Tasks 3–5. `provision()` helper signature in Task 6 matches both call sites.

---

## Out of scope (per spec)
Operation-level grouping; policy de-provisioning; replacing the 26.2 Trace Analyzer; ML-correlation tuning.
