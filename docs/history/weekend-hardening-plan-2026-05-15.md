# Weekend Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 5 items in `docs/5-15-WeekendHardeningSpec.md` — wizard hardening (Step 1 test-connection, Step 2 restart snippet, Step 4 send-test-trace) + day-2 stability (System Health panel + network watchdog).

**Architecture:** Extends existing files; two new files (`backend/errorLog.js`, `frontend/src/components/dashboard/SystemHealthPanel.tsx`). One new GET route (`/api/diagnostics/system-health`) consolidates all panel data into a single 30s round-trip.

**Tech Stack:** Node 20 + Express, React 18 + Vite + Tailwind, Vitest for unit tests. No new dependencies.

**Working directory:** `/Users/jammicha/dev/HelixConfigurator/.claude/worktrees/jolly-edison-8df9e4` (worktree on `claude/jolly-edison-8df9e4`). Main is at `cca276d` after PR #2 merged — this branch needs to rebase onto main before starting. See Task 0.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `backend/errorLog.js` | **Create** | In-memory ring buffer of tagged errors (push/recent/cap=50). Pure module, no I/O. |
| `backend/__tests__/errorLog.test.mjs` | **Create** | Unit tests for the ring buffer. |
| `backend/__tests__/runOtlpProbe.test.mjs` | **Create** | Unit tests for the extracted probe function with mocked axios. |
| `backend/routes/diagnostics.js` | Modify | Extract `runOtlpProbe` helper; new `/test-connection` route; new `/system-health` route; instrument existing warnings. |
| `backend/routes/lifecycle.js` | Modify | Refactor `reconcileBridgedNetworks` for reuse; add watchdog timer; instrument warnings. |
| `backend/routes/discovery.js` | Modify | Instrument smart-add failure warning. |
| `backend/otelStore.js` | Modify | New `recentThroughput()` + `storeUsage()` methods. |
| `frontend/src/components/wizard/Step1.tsx` | Modify | Test Connection button + result display. |
| `frontend/src/components/wizard/Step2.tsx` | Modify | Restart snippet block. |
| `frontend/src/components/wizard/Step4.tsx` | Modify | Send Test Trace button + local state. |
| `frontend/src/components/dashboard/SystemHealthPanel.tsx` | **Create** | Presentational component for the 4 stat cards + event log. |
| `frontend/src/App.tsx` | Modify | Wire test-connection handler; poll system-health; mount SystemHealthPanel. |

---

## Task 0: Rebase the branch onto main

The PR-merge fast-forwarded main on origin but left this branch's local position behind. Bring it current before adding new commits.

**Files:**
- None (git operation)

- [ ] **Step 1: Fetch + check branch position**

```bash
git fetch origin
git log --oneline origin/main..HEAD  # should show no commits NOT on main
git log --oneline HEAD..origin/main  # should show the new commits
```

Expected: HEAD..origin/main shows `cca276d` (merge commit) + `169607a` (simplify cleanup). The branch's commits all landed via PR.

- [ ] **Step 2: Reset branch to origin/main**

Since the branch's commits are all already on main via the merge, just reset:

```bash
git reset --hard origin/main
```

Expected: working tree clean, HEAD now at `cca276d`.

---

## Task 1: Extract `runOtlpProbe` from `apikey-probe`

Refactor the existing OTLP probe logic in `/api/diagnostics/apikey-probe` into a reusable internal function. Behavior MUST NOT change — the existing route's response stays identical.

**Files:**
- Modify: `backend/routes/diagnostics.js` (around lines 1013–1130)
- Create: `backend/__tests__/runOtlpProbe.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/runOtlpProbe.test.mjs`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { runOtlpProbe } from '../routes/diagnostics.js';

vi.mock('axios');

describe('runOtlpProbe', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns valid on 200', async () => {
    axios.post.mockResolvedValue({ status: 200 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('valid');
    expect(r.httpStatus).toBe(200);
    expect(typeof r.latencyMs).toBe('number');
  });

  it('returns rejected on 401', async () => {
    axios.post.mockResolvedValue({ status: 401 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('rejected');
    expect(r.httpStatus).toBe(401);
  });

  it('returns rejected on 403', async () => {
    axios.post.mockResolvedValue({ status: 403 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('rejected');
    expect(r.httpStatus).toBe(403);
  });

  it('returns tenant-error on other 4xx', async () => {
    axios.post.mockResolvedValue({ status: 404 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('tenant-error');
  });

  it('returns helix-error on 5xx', async () => {
    axios.post.mockResolvedValue({ status: 502 });
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('helix-error');
  });

  it('returns network-error on ECONNREFUSED', async () => {
    const e = new Error('connect ECONNREFUSED 127.0.0.1:443');
    e.code = 'ECONNREFUSED';
    axios.post.mockRejectedValue(e);
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('network-error');
  });

  it('returns network-error on timeout', async () => {
    const e = new Error('timeout of 8000ms exceeded');
    e.code = 'ECONNABORTED';
    axios.post.mockRejectedValue(e);
    const r = await runOtlpProbe('https://tenant.onbmc.com', 'TenantID::Access::Secret');
    expect(r.status).toBe('network-error');
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

```bash
cd backend && npm test -- runOtlpProbe
```

Expected: FAIL with "runOtlpProbe is not exported" or similar.

- [ ] **Step 3: Extract runOtlpProbe**

In `backend/routes/diagnostics.js`, the existing `apikey-probe` route (around lines 1013-1130) does the OTLP traces POST. Extract its body into a top-level (module-scope) `runOtlpProbe(endpoint, apiKey)` that returns the same `{ status, httpStatus?, latencyMs?, message, remediation? }` shape. Export it via `module.exports.runOtlpProbe = runOtlpProbe;` AT THE BOTTOM of the file (after the `register` function).

The existing route delegates:

```javascript
app.post('/api/diagnostics/apikey-probe', async (req, res) => {
  const endpoint = process.env.HELIX_ENDPOINT;
  const apiKey = process.env.HELIX_API_KEY;
  if (!endpoint || !apiKey) {
    return res.status(400).json({ error: 'HELIX_ENDPOINT or HELIX_API_KEY not set' });
  }
  const result = await runOtlpProbe(endpoint, apiKey);
  res.json(result);
});
```

The new top-level function uses the existing code's payload, headers, URL construction, and status-code branching verbatim. Just generalize the source of `endpoint` and `apiKey` to function params instead of env reads.

- [ ] **Step 4: Run all backend tests (expect PASS)**

```bash
cd backend && npm test
```

Expected: 31 prior + 7 new = 38 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/diagnostics.js backend/__tests__/runOtlpProbe.test.mjs
git commit -m "refactor(diagnostics): extract runOtlpProbe from apikey-probe route

No behavior change. The probe logic is now callable with explicit
endpoint+apiKey args so the upcoming /test-connection route (which
operates on in-form values, not process.env) can reuse it. The
existing apikey-probe route delegates to the extracted helper."
```

---

## Task 2: Add `/api/diagnostics/test-connection` route

New route that accepts `{ endpoint, apiKey }` in body and calls `runOtlpProbe` with them. Used by Step 1's Test Connection button.

**Files:**
- Modify: `backend/routes/diagnostics.js`
- Modify: `backend/__tests__/runOtlpProbe.test.mjs` (add route-level tests via supertest, OR just rely on integration testing — see Step 1 below)

- [ ] **Step 1: Add the route**

In `backend/routes/diagnostics.js`, inside the `register()` function, add:

```javascript
app.post('/api/diagnostics/test-connection', async (req, res) => {
  const { endpoint, apiKey } = req.body || {};
  if (typeof endpoint !== 'string' || !/^https?:\/\/[^\s]+$/.test(endpoint)) {
    return res.status(400).json({ status: 'invalid-input', error: 'Invalid endpoint URL' });
  }
  if (typeof apiKey !== 'string' || !/^[^:]+::[^:]+::[^:]+$/.test(apiKey)) {
    return res.status(400).json({ status: 'invalid-input', error: 'API key must be three :: separated parts' });
  }
  const result = await runOtlpProbe(endpoint, apiKey);
  res.json(result);
});
```

- [ ] **Step 2: Smoke test via curl**

Start the backend locally (or rebuild the container) and:

```bash
curl -s -X POST http://localhost:8765/api/diagnostics/test-connection \
  -H "Content-Type: application/json" \
  -d '{"endpoint":"https://example.com","apiKey":"a::b::c"}'
```

Expected: returns a JSON response with `status` (likely `network-error` against example.com). 400 for invalid input.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/diagnostics.js
git commit -m "feat(diagnostics): add /api/diagnostics/test-connection route

Accepts {endpoint, apiKey} in body and delegates to runOtlpProbe.
Lets Step 1 probe Helix reachability with in-form values before the
user saves and triggers a gateway recreate."
```

---

## Task 3: Wire Test Connection button on Step 1

Frontend addition. Calls the new backend route, displays the result inline.

**Files:**
- Modify: `frontend/src/components/wizard/Step1.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Extend Step1 props + state**

In `frontend/src/components/wizard/Step1.tsx`, extend the props type:

```typescript
type Props = {
  // ... existing props
  onTestConnection: () => void;
  testConnectionResult: { status: string; message: string; remediation?: string; httpStatus?: number; latencyMs?: number } | null;
  testingConnection: boolean;
};
```

Add the destructure in the component signature.

- [ ] **Step 2: Add the button + result UI**

Just before the existing "Save & initialize" button, add:

```tsx
<div className="space-y-2 mb-3">
  <button
    type="button"
    onClick={onTestConnection}
    disabled={testingConnection || !canSubmit}
    className="inline-flex items-center gap-2 px-4 py-2 rounded font-semibold text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60"
    title={!canSubmit ? 'Fill in valid Endpoint and API Key first' : 'Probe Helix with the values above (does not save)'}
  >
    {testingConnection ? (<><Loader2 className="w-4 h-4 animate-spin" /> Testing…</>) : 'Test connection →'}
  </button>
  {testConnectionResult && (
    <div className={`flex items-start gap-2 text-tiny p-2.5 rounded border ${
      testConnectionResult.status === 'valid' ? 'bg-success/10 border-success/40 text-success' : 'bg-warning/10 border-warning/40 text-warning'
    }`}>
      {testConnectionResult.status === 'valid'
        ? <Check className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
      <div className="flex-1">
        <div className="text-gray-200">{testConnectionResult.message}</div>
        {testConnectionResult.remediation && <p className="text-gray-400 mt-0.5">{testConnectionResult.remediation}</p>}
      </div>
    </div>
  )}
</div>
```

You'll need to import `Loader2`, `Check`, and `AlertTriangle` from `lucide-react` (Check is already imported).

- [ ] **Step 3: Wire the handler in App.tsx**

In `frontend/src/App.tsx`, add state + handler near the other Step 1 state:

```typescript
const [testConnectionResult, setTestConnectionResult] = useState<{ status: string; message: string; remediation?: string; httpStatus?: number; latencyMs?: number } | null>(null);
const [testingConnection, setTestingConnection] = useState(false);
const handleTestConnection = async () => {
  if (testingConnection) return;
  setTestingConnection(true);
  setTestConnectionResult(null);
  try {
    const res = await fetch('/api/diagnostics/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: envVars.HELIX_ENDPOINT, apiKey: envVars.HELIX_API_KEY }),
    });
    const data = await res.json();
    setTestConnectionResult({
      status: data.status || (res.ok ? 'unknown' : 'error'),
      message: data.message || data.error || 'Test finished',
      remediation: data.remediation,
      httpStatus: data.httpStatus,
      latencyMs: data.latencyMs,
    });
  } catch (e: any) {
    setTestConnectionResult({ status: 'error', message: e?.message || 'Request failed' });
  } finally {
    setTestingConnection(false);
  }
};
```

Also: clear `testConnectionResult` on any change to `envVars.HELIX_ENDPOINT` or `envVars.HELIX_API_KEY` (stale results would mislead). Easiest: add a `useEffect` that watches those two values and calls `setTestConnectionResult(null)`.

Pass `onTestConnection={handleTestConnection}`, `testConnectionResult={testConnectionResult}`, `testingConnection={testingConnection}` to the `<Step1>` mount (the `setupStep === 1` block).

- [ ] **Step 4: Build the frontend**

```bash
cd frontend && npm run build
```

Expected: clean build, no TS errors.

- [ ] **Step 5: Rebuild container and smoke test**

```bash
cd ../ && docker compose -p helixconfigurator up --build -d
```

Open the wizard at http://localhost:8765, type a fake endpoint + key, click Test Connection. Expected: result banner appears with appropriate status.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/wizard/Step1.tsx frontend/src/App.tsx
git commit -m "feat(wizard): inline Test Connection affordance on Step 1

Probes Helix with the typed-but-not-yet-saved endpoint + API key
via /api/diagnostics/test-connection. Informational only — does not
gate Save & initialize. Result clears on any change to either field
so stale verdicts don't mislead."
```

---

## Task 4: Add restart-collector snippet to Step 2

Pure frontend addition. No tests.

**Files:**
- Modify: `frontend/src/components/wizard/Step2.tsx`

- [ ] **Step 1: Add the snippet block**

In `frontend/src/components/wizard/Step2.tsx`, find the existing `{!compactAfterApply && (...)}` wrapper that holds the Exporter + Pipelines blocks. After the Pipelines block (around line 192) and BEFORE the existing amber "After saving, restart your collector container" warning, add:

```tsx
<div className="mb-2 flex items-baseline justify-between gap-3">
  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Restart your collector</span>
</div>
<SnippetBlock text={`docker restart ${smartAddProposal?.name || '<your-collector>'}`} />
<p className="text-tiny text-gray-500 -mt-4 mb-6">
  Runs from your terminal. After the collector finishes restarting, head to Step 3 to wire the network.
</p>
```

- [ ] **Step 2: Build + smoke**

```bash
cd frontend && npm run build && cd ../ && docker compose -p helixconfigurator up --build -d
```

Open the wizard, go to Step 2 with no detected collectors. Expected: a SnippetBlock with `docker restart <your-collector>` placeholder. With one detected, the name should be substituted.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/wizard/Step2.tsx
git commit -m "feat(wizard): add restart-collector snippet to Step 2 manual path

Closes the 'how do I restart this thing?' gap on the manual-snippet
path. Substitutes the detected collector's name when smart-add found
exactly one; placeholder otherwise. Hidden when smart-add succeeded
(same compact-mode wrapper as the other manual snippets)."
```

---

## Task 5: Add Send Test Trace button to Step 4

Pure frontend addition. Calls existing `/api/diagnostics/inject-trace` endpoint.

**Files:**
- Modify: `frontend/src/components/wizard/Step4.tsx`

- [ ] **Step 1: Add state + handler**

In `frontend/src/components/wizard/Step4.tsx`, near the top of the component body, add:

```typescript
const [testTraceStatus, setTestTraceStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
const sendTestTrace = async () => {
  if (testTraceStatus === 'sending') return;
  setTestTraceStatus('sending');
  try {
    const res = await fetch('/api/diagnostics/inject-trace', { method: 'POST' });
    if (!res.ok) throw new Error('Inject failed');
    setTestTraceStatus('sent');
    setTimeout(() => setTestTraceStatus('idle'), 3000);
  } catch {
    setTestTraceStatus('error');
    setTimeout(() => setTestTraceStatus('idle'), 5000);
  }
};
```

Make sure `useState` is imported (already is).

- [ ] **Step 2: Add the button**

In the JSX, find the button row containing **Back / Verify gateway → Helix / Launch dashboard** (~lines 290–305). Insert a new button between Verify and Launch:

```tsx
<button
  type="button"
  onClick={sendTestTrace}
  disabled={testTraceStatus === 'sending'}
  className="px-4 py-3 rounded font-semibold text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60 inline-flex items-center justify-center gap-2"
  title="Inject one synthetic trace, fire-and-forget. Different from Verify — no polling, no verdict."
>
  {testTraceStatus === 'sending' && <Loader2 className="w-4 h-4 animate-spin" />}
  {testTraceStatus === 'sending' ? 'Sending…' : testTraceStatus === 'sent' ? 'Sent ✓' : testTraceStatus === 'error' ? 'Failed — retry' : 'Send test trace'}
</button>
```

The button is `px-4` (narrower than the flex-1 primaries) so it sits as a tertiary action.

- [ ] **Step 3: Build + smoke**

```bash
cd frontend && npm run build && cd ../ && docker compose -p helixconfigurator up --build -d
```

Open wizard → complete to Step 4 → click Send test trace. Expected: "Sending…" → "Sent ✓" → fades back. Span counter on the dashboard should tick up.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/wizard/Step4.tsx
git commit -m "feat(wizard): add Send Test Trace button on Step 4

Tertiary action next to Verify gateway → Helix. Fires the existing
inject-trace endpoint fire-and-forget — no polling, no verdict.
Lets the user see *anything* flow without configuring their app or
waiting for the 20s verify poll loop. Does not unlock Launch (only
Verify does — gating rule unchanged)."
```

---

## Task 6: Create errorLog ring buffer

In-memory tagged-error buffer powering the System Health panel's "Last error" card.

**Files:**
- Create: `backend/errorLog.js`
- Create: `backend/__tests__/errorLog.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/errorLog.test.mjs`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { push, recent, _reset } from '../errorLog.js';

describe('errorLog', () => {
  beforeEach(() => { _reset(); });

  it('returns empty array when nothing pushed', () => {
    expect(recent()).toEqual([]);
  });

  it('returns pushed entries newest-first', () => {
    push('tag1', 'first message');
    push('tag2', 'second message');
    const entries = recent();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('second message');
    expect(entries[1].message).toBe('first message');
  });

  it('attaches a numeric timestamp to each entry', () => {
    const before = Date.now();
    push('t', 'm');
    const [entry] = recent();
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(Date.now());
  });

  it('respects the limit param', () => {
    for (let i = 0; i < 10; i++) push('t', `msg${i}`);
    expect(recent(3)).toHaveLength(3);
  });

  it('caps the buffer at 50 entries (oldest evicted)', () => {
    for (let i = 0; i < 60; i++) push('t', `msg${i}`);
    const entries = recent(100);
    expect(entries).toHaveLength(50);
    // Newest first; msg59 should be index 0, msg10 (the oldest survivor) should be last.
    expect(entries[0].message).toBe('msg59');
    expect(entries[49].message).toBe('msg10');
  });

  it('preserves optional detail field', () => {
    push('tag', 'message', { foo: 'bar' });
    expect(recent()[0].detail).toEqual({ foo: 'bar' });
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)**

```bash
cd backend && npm test -- errorLog
```

Expected: FAIL with "Cannot find module '../errorLog.js'".

- [ ] **Step 3: Implement errorLog.js**

Create `backend/errorLog.js`:

```javascript
// Tiny in-memory ring buffer of tagged errors. Lifecycle / diagnostics /
// discovery routes push here at any existing console.warn / console.error
// site that represents a user-relevant failure; the dashboard polls
// `recent()` to surface the latest in the System Health panel.
const CAP = 50;
let buffer = [];

const push = (tag, message, detail) => {
  buffer.push({ ts: Date.now(), tag, message, detail });
  if (buffer.length > CAP) buffer = buffer.slice(buffer.length - CAP);
};

const recent = (limit = 10) => {
  const slice = buffer.slice(-limit).reverse();
  return slice;
};

// Test-only — resets the buffer between cases.
const _reset = () => { buffer = []; };

module.exports = { push, recent, _reset };
```

- [ ] **Step 4: Run test (expect PASS)**

```bash
cd backend && npm test
```

Expected: 38 prior + 6 new = 44 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/errorLog.js backend/__tests__/errorLog.test.mjs
git commit -m "feat(errorLog): add in-memory ring buffer for tagged errors

Cap 50 entries; oldest evicted on overflow. Read with recent(limit).
No persistence by design — the System Health panel cares about recent
state, not history."
```

---

## Task 7: Add `otelStore.recentThroughput` + `storeUsage`

Two new methods on the existing OtelStore class.

**Files:**
- Modify: `backend/otelStore.js`
- Modify: `backend/__tests__/otelStore.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `backend/__tests__/otelStore.test.mjs`, append (re-using the existing file's `OtelStore` import, `vi.useFakeTimers()` beforeEach pattern, and the `makeSpan` helper already defined at the top):

```javascript
const buildSpans = (n, traceId) => Array.from({ length: n }, (_, i) => makeSpan({
  traceId, spanId: `${traceId}-${i}`,
}));

describe('recentThroughput', () => {
  let store;
  beforeEach(() => { vi.useFakeTimers(); store = new OtelStore({ dbPath: ':memory:' }); });
  afterEach(() => { store.stopMaintenance(); store.db.close(); vi.useRealTimers(); });

  it('returns zero rate on an empty store', () => {
    const r = store.recentThroughput();
    expect(r.totalSpans).toBe(0);
    expect(r.spansPerSec).toBe(0);
    expect(r.windowMs).toBe(3_600_000);
  });

  it('counts spans whose trace was received in the window', () => {
    // Trace ingested at t=0 with 3 spans (received_at = now per ingestSpans)
    store.ingestSpans(buildSpans(3, 't-recent'));
    const r = store.recentThroughput(60 * 60 * 1000);
    expect(r.totalSpans).toBe(3);
    expect(r.spansPerSec).toBeCloseTo(3 / 3600, 5);
  });

  it('excludes traces received outside the window', () => {
    // Old trace: 2h ago. New trace: now.
    vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000);
    store.ingestSpans(buildSpans(5, 't-old'));
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
    store.ingestSpans(buildSpans(2, 't-new'));
    const r = store.recentThroughput(60 * 60 * 1000);
    expect(r.totalSpans).toBe(2);
  });
});

describe('storeUsage', () => {
  let store;
  beforeEach(() => { vi.useFakeTimers(); store = new OtelStore({ dbPath: ':memory:' }); });
  afterEach(() => { store.stopMaintenance(); store.db.close(); vi.useRealTimers(); });

  it('returns zero percentages on an empty store', () => {
    const r = store.storeUsage();
    expect(r.tracesUsedPct).toBe(0);
    expect(r.logsUsedPct).toBe(0);
    expect(r.errorsUsedPct).toBe(0);
  });

  it('reports non-zero tracesUsedPct after ingest', () => {
    for (let i = 0; i < 5; i++) store.ingestSpans(buildSpans(1, `t-${i}`));
    const r = store.storeUsage();
    // 5 / TRACE_CAP(500) = 1% rounded.
    expect(r.tracesUsedPct).toBe(1);
  });
});
```

Spans don't carry their own `received_at` column (only `traces` do — see otelStore.js line 245), so the throughput query goes through `traces` and uses the `span_count` rollup that ingestion already maintains.

- [ ] **Step 2: Run tests (expect FAIL)**

```bash
cd backend && npm test
```

Expected: FAIL with `recentThroughput is not a function` / `storeUsage is not a function`.

- [ ] **Step 3: Implement the methods**

In `backend/otelStore.js`, add inside the OtelStore class:

```javascript
recentThroughput(windowMs = 3_600_000) {
  const sinceMs = Date.now() - windowMs;
  // spans has no received_at column — count via traces.received_at and
  // sum the span_count rollup that ingestion already maintains. Lets us
  // measure "spans received in the last hour" without joining the spans
  // table on every call.
  const row = this.db.prepare(
    'SELECT COALESCE(SUM(span_count), 0) AS total FROM traces WHERE received_at >= ?'
  ).get(sinceMs);
  const totalSpans = row?.total || 0;
  const spansPerSec = totalSpans / (windowMs / 1000);
  return { totalSpans, spansPerSec, windowMs };
}

storeUsage() {
  const traceCount = this.db.prepare('SELECT COUNT(*) AS n FROM traces').get().n;
  const logCount = this.db.prepare('SELECT COUNT(*) AS n FROM log_records').get().n;
  const errorCount = this.db.prepare('SELECT COUNT(*) AS n FROM span_errors').get().n;
  return {
    tracesUsedPct: Math.round((traceCount / TRACE_CAP) * 100),
    logsUsedPct: Math.round((logCount / LOG_CAP) * 100),
    errorsUsedPct: Math.round((errorCount / ERROR_CAP) * 100),
  };
}
```

(TRACE_CAP / LOG_CAP / ERROR_CAP are already module-scope constants in this file.)

- [ ] **Step 4: Run tests (expect PASS)**

```bash
cd backend && npm test
```

Expected: 44 prior + 4 new = 48 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/otelStore.js backend/__tests__/otelStore.test.mjs
git commit -m "feat(otelStore): add recentThroughput and storeUsage methods

recentThroughput(windowMs) returns {totalSpans, spansPerSec, windowMs}
for the configurable window. storeUsage() returns percentages against
the existing TRACE_CAP / LOG_CAP / ERROR_CAP. Both power the System
Health panel's stat cards."
```

---

## Task 8: Add `/api/diagnostics/system-health` route + instrument warnings

One new GET route returning everything the panel needs. Then sprinkle `errorLog.push()` calls at existing failure sites.

**Files:**
- Modify: `backend/routes/diagnostics.js`
- Modify: `backend/routes/lifecycle.js`
- Modify: `backend/routes/discovery.js`

- [ ] **Step 1: Add the route**

In `backend/routes/diagnostics.js`, at the top of the file (with other requires):

```javascript
const errorLog = require('../errorLog');
```

Pass `otelStore` to the `register` function — check the call site in `backend/index.js`; if it's not already passed, add it: `diagnostics.register(app, { docker, containerLogs, configPath: CONFIG_PATH, otelStore });` (in index.js).

Inside the `register` function, add:

```javascript
app.get('/api/diagnostics/system-health', async (req, res) => {
  const targetContainer = TARGET_CONTAINER();
  let gatewayStatus = 'unknown';
  let gatewayExitCode;
  try {
    const inspect = await withDockerTimeout(docker.getContainer(targetContainer).inspect(), 'container.inspect', 5_000);
    gatewayStatus = inspect.State?.Status || 'unknown';
    if (gatewayStatus !== 'running') gatewayExitCode = inspect.State?.ExitCode;
  } catch (e) {
    gatewayStatus = 'error';
  }
  const throughput = otelStore.recentThroughput();
  const storeUsage = otelStore.storeUsage();
  const recentErrors = errorLog.recent(10);
  res.json({ gatewayStatus, gatewayExitCode, throughput, storeUsage, recentErrors });
});
```

Confirm `withDockerTimeout` is imported in this file (it should be — it's used by other routes here).

- [ ] **Step 2: Instrument lifecycle warnings**

In `backend/routes/lifecycle.js`, add at the top:

```javascript
const errorLog = require('../errorLog');
```

Then at each existing user-visible `console.warn` / `console.error` site, add a parallel push. The high-value sites:

- `recreateGateway` stop warning (around line 56): after the warn, `errorLog.push('gateway.recreate.stop', \`stop ${name}: ${e.message}\`);`
- `recreateGateway` network-attach warning (around line 91): `errorLog.push('gateway.recreate.network', \`pre-start connect to ${net}: ${e.message}\`);`
- `bridge-network` route's recreate failure case (around line 296): `errorLog.push('bridge-network.recreate', e.message);` BEFORE the 500 response.
- `reset-onboarding` recreate failure (the existing `console.warn`): `errorLog.push('reset-onboarding.recreate', e.message);`
- `reconcileBridgedNetworks` failures (existing warns): `errorLog.push('bridged-networks.reconcile', \`${net}: ${e.message}\`);`

(Each push uses a `tag.subtag` shape so future filtering is cheap. Keep the messages user-readable — they may show up on the dashboard.)

- [ ] **Step 3: Instrument discovery warnings**

In `backend/routes/discovery.js`:

```javascript
const errorLog = require('../errorLog');
```

The smart-add apply route's catch block (around line 643): before `res.status(500).json(...)`, add `errorLog.push('smart-add.apply', \`${name}: ${e.message}\`);`.

- [ ] **Step 4: Smoke test the route**

```bash
cd ../ && docker compose -p helixconfigurator up --build -d
sleep 3
curl -s http://localhost:8765/api/diagnostics/system-health | jq .
```

Expected: JSON with the five fields populated. `gatewayStatus: "running"`, throughput numbers, storeUsage percentages, `recentErrors: []` (or populated if any errors have fired since boot).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/diagnostics.js backend/routes/lifecycle.js backend/routes/discovery.js backend/index.js
git commit -m "feat(diagnostics): add /system-health route + instrument warnings

Single GET returning gateway status + throughput + store usage +
recent errors. Lifecycle and discovery routes push tagged messages
to errorLog at existing user-visible failure sites so the dashboard's
'Last error' card surfaces operational drift without changing log
output."
```

---

## Task 9: Create SystemHealthPanel + wire into App.tsx

**Files:**
- Create: `frontend/src/components/dashboard/SystemHealthPanel.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create the panel component**

Create `frontend/src/components/dashboard/SystemHealthPanel.tsx`:

```tsx
import React, { useState } from 'react';
import { Activity, Database, AlertTriangle, Server } from 'lucide-react';

type SystemHealth = {
  gatewayStatus: 'running' | 'restarting' | 'exited' | 'unknown' | 'error';
  gatewayExitCode?: number;
  throughput: { totalSpans: number; spansPerSec: number; windowMs: number };
  storeUsage: { tracesUsedPct: number; logsUsedPct: number; errorsUsedPct: number };
  recentErrors: Array<{ ts: number; tag: string; message: string }>;
};

type Props = { health: SystemHealth | null };

const fmtRate = (rate: number): string => {
  if (rate === 0) return '0 spans/s';
  if (rate < 1) return `${(rate * 60).toFixed(1)} spans/min`;
  return `${rate.toFixed(1)} spans/s`;
};

const fmtAgo = (ts: number): string => {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
};

export const SystemHealthPanel: React.FC<Props> = ({ health }) => {
  const [showErrors, setShowErrors] = useState(false);
  if (!health) {
    return (
      <div className="adapt-card">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">System health</div>
        <div className="text-tiny text-gray-500">Loading…</div>
      </div>
    );
  }
  const maxStorePct = Math.max(health.storeUsage.tracesUsedPct, health.storeUsage.logsUsedPct, health.storeUsage.errorsUsedPct);
  const lastErr = health.recentErrors[0];
  return (
    <div className="adapt-card">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">System health</div>
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-gray-1000 border border-gray-800 rounded p-3">
          <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><Server className="w-3 h-3" /> Gateway</div>
          <div className={`text-sm font-semibold ${health.gatewayStatus === 'running' ? 'text-success' : 'text-warning'}`}>
            {health.gatewayStatus}{health.gatewayExitCode != null ? ` (${health.gatewayExitCode})` : ''}
          </div>
        </div>
        <div className="bg-gray-1000 border border-gray-800 rounded p-3">
          <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><Activity className="w-3 h-3" /> Throughput (1h)</div>
          <div className="text-sm font-semibold text-gray-200 tabular-nums">{fmtRate(health.throughput.spansPerSec)}</div>
        </div>
        <div className="bg-gray-1000 border border-gray-800 rounded p-3">
          <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><Database className="w-3 h-3" /> Store size</div>
          <div className={`text-sm font-semibold tabular-nums ${maxStorePct > 85 ? 'text-danger' : 'text-gray-200'}`}>{maxStorePct}%</div>
          <div className="text-tiny text-gray-500 mt-0.5">Clear store (coming soon)</div>
        </div>
        <div className="bg-gray-1000 border border-gray-800 rounded p-3">
          <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" /> Last error</div>
          {lastErr ? (
            <>
              <div className="text-sm font-semibold text-warning truncate" title={lastErr.message}>{lastErr.tag}</div>
              <div className="text-tiny text-gray-500">{fmtAgo(lastErr.ts)}</div>
            </>
          ) : (
            <div className="text-sm text-gray-500">None</div>
          )}
        </div>
      </div>
      {health.recentErrors.length > 0 && (
        <div className="mt-3 border-t border-gray-800 pt-2">
          <button
            onClick={() => setShowErrors(s => !s)}
            className="text-tiny text-gray-400 hover:text-gray-200 font-semibold"
          >
            {showErrors ? 'Hide' : 'Show'} recent errors ({health.recentErrors.length})
          </button>
          {showErrors && (
            <ul className="mt-2 space-y-1">
              {health.recentErrors.map((e, i) => (
                <li key={i} className="text-tiny text-gray-400 flex gap-2">
                  <span className="text-gray-500 font-mono">{fmtAgo(e.ts)}</span>
                  <span className="text-gray-300 font-mono">{e.tag}</span>
                  <span className="text-gray-400 break-all">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
```

(`adapt-card` is an existing utility class used by other dashboard sections.)

- [ ] **Step 2: Wire polling in App.tsx**

In `frontend/src/App.tsx`:

```typescript
import { SystemHealthPanel } from './components/dashboard/SystemHealthPanel';

// ... inside the component body, near other dashboard state:
const [systemHealth, setSystemHealth] = useState<any>(null);
useEffect(() => {
  if (!isSetupComplete) return;
  const fetchHealth = async () => {
    try {
      const r = await fetch('/api/diagnostics/system-health');
      if (r.ok) setSystemHealth(await r.json());
    } catch { /* keep last known good */ }
  };
  fetchHealth();
  const id = setInterval(fetchHealth, 30_000);
  return () => clearInterval(id);
}, [isSetupComplete]);
```

Then in the dashboard render section (search for where `OverviewTab` or the existing live counters are mounted in the `{isSetupComplete && ...}` branch), add `<SystemHealthPanel health={systemHealth} />` as the FIRST element of the dashboard body, above whatever's currently there.

- [ ] **Step 3: Build + smoke**

```bash
cd frontend && npm run build && cd ../ && docker compose -p helixconfigurator up --build -d
```

Open the dashboard. Expected: 4-card panel at the top showing actual data. Throughput should show a non-zero number after sending a few traces.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/SystemHealthPanel.tsx frontend/src/App.tsx
git commit -m "feat(dashboard): System Health panel

Four-card summary (gateway / throughput / store / last-error) backed
by /api/diagnostics/system-health, polled every 30s. Errors collapse
behind a 'Show recent errors' disclosure; Clear store is intentionally
a placeholder for v1."
```

---

## Task 10: Network watchdog

Refactor `reconcileBridgedNetworks` for reuse, then add a `setInterval` running it every 5 min.

**Files:**
- Modify: `backend/routes/lifecycle.js`

- [ ] **Step 1: Confirm the function already accepts `docker` as a param**

Check the existing signature of `reconcileBridgedNetworks` in lifecycle.js. If it already takes `(docker)` and returns a promise, no refactor needed — proceed to Step 2. If it's bound to a closure or has a different signature, lift it to module scope with a `(docker)` param.

- [ ] **Step 2: Add the watchdog**

In `backend/routes/lifecycle.js`, inside the `register(app, { docker })` function, AFTER the existing fire-and-forget reconcile call (the `.catch(...)` line at the end of the file), add:

```javascript
// Watchdog: re-run the bridge reconcile every ~5 min so a network
// dropped after boot (compose down/up on a peer, manual disconnect,
// etc.) heals without requiring a configurator restart. Configurable
// via env var; 0 disables. unref'd so it doesn't block process exit.
const watchdogIntervalMs = Number.parseInt(process.env.BRIDGED_NETWORKS_WATCHDOG_INTERVAL_MS, 10);
const effectiveInterval = Number.isFinite(watchdogIntervalMs) ? watchdogIntervalMs : 5 * 60 * 1000;
if (effectiveInterval > 0) {
  setInterval(() => {
    reconcileBridgedNetworks(docker).catch(e => {
      console.warn('bridged-networks: watchdog threw:', e.message);
      try { require('../errorLog').push('bridged-networks.watchdog', e.message); } catch { /* errorLog might not be loaded yet — non-fatal */ }
    });
  }, effectiveInterval).unref();
}
```

- [ ] **Step 3: Smoke test (manual)**

Rebuild the container, bridge to a customer network via Step 3, then:

```bash
docker network disconnect <bridged-network> helix-gateway
```

Within 5 minutes (or set `BRIDGED_NETWORKS_WATCHDOG_INTERVAL_MS=10000` for testing — 10s), the configurator should log `bridged-networks: re-attached helix-gateway to <name>` and re-attach the network.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/lifecycle.js
git commit -m "feat(lifecycle): network bridge watchdog (~5 min cadence)

Reuses the boot-time reconcileBridgedNetworks function on a setInterval
so a network dropped after startup self-heals without a configurator
restart. Cadence configurable via BRIDGED_NETWORKS_WATCHDOG_INTERVAL_MS
(default 5 min, set 0 to disable). unref'd so it doesn't pin the
process alive at exit."
```

---

## Final verification

After all tasks land:

- [ ] **Step 1: Full test suite passes**

```bash
cd backend && npm test
```

Expected: 48 passing (31 prior + 6 errorLog + 7 runOtlpProbe + 4 otelStore methods).

- [ ] **Step 2: Frontend build clean**

```bash
cd frontend && npm run build
```

Expected: no TS errors, no warnings beyond the existing baseline.

- [ ] **Step 3: Manual end-to-end**

Walk the wizard:
- Step 1: type fake creds, click Test Connection, see appropriate verdict.
- Step 2: see restart-collector snippet appear in manual path.
- Step 4: click Send test trace, see "Sent ✓".
- Dashboard: see System Health panel populated with real numbers.
- Disconnect helix-gateway from a bridged network, wait 5 min, confirm watchdog re-attaches.

- [ ] **Step 4: Push branch + open PR**

```bash
git push origin claude/jolly-edison-8df9e4
gh pr create --title "feat: weekend hardening bundle (wizard + day-2 panel + watchdog)" \
  --body "Implements docs/5-15-WeekendHardeningSpec.md. See spec for full design."
```

---

## Self-review notes

- Task 0 covers the rebase needed because the PR merge advanced main past this branch's commits.
- All TDD tasks (1, 6, 7) write a failing test FIRST, then verify failure, then implement.
- UI-only tasks (4, 5, 9) have manual smoke verification, not unit tests — appropriate for presentational React work.
- Each commit message names the feature scope; matches existing repo convention (feat/fix/refactor/chore).
- Cumulative estimate: ~10 hrs. Falls inside the 8–12 hr budget. Task 9 (System Health panel) is the biggest single chunk at ~4 hrs.
