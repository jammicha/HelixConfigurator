# Show the Problematic Span in a Helix AIOps Situation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the OTel-anomaly event with the failing span's id, a hot-path string, and a deep-link to a custom Helix dashboard that embeds the configurator's waterfall scrolled to that span — and add the chromeless `/otel-data/embed` viewer route the dashboard iframes.

**Architecture:** One enriched event, two surfaces. Backend (`situations-payloads.js`) gains the span id + `hot_path` + `span_dashboard_url` slots (Option 3 = in-situation text). Frontend gains a chromeless `/otel-data/embed?trace=&span=` route that reuses the existing `Waterfall` with a new `focusSpanId` highlight+scroll (Option 2 = embedded waterfall, framed by a manually-created Helix dashboard).

**Tech Stack:** Node/Express (CommonJS) backend, vitest (ESM `.mjs` tests). React + Vite + TypeScript frontend, vitest (no testing-library — pure-function tests only), path-based routing in `main.tsx` (no React Router).

---

## Pre-flight (execution time)

- Per [[reference_helix_worktree_and_docs_workflow]]: the working tree is shared with a concurrent session and the EnterWorktree hook is broken. Before editing code, create a **manual git worktree** (via superpowers:using-git-worktrees) and **symlink `node_modules`** in both `backend/` and `frontend/`. This plan file lives under `docs/` which is **gitignored** (local-only) — it is not committed.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (shown on the first commit; apply to all).
- **Backend tests** run from `backend/`: `npx vitest run __tests__/situations-payloads.test.mjs`. **Frontend tests** run from `frontend/`: `npm test` (`TZ=America/Chicago vitest run`).

## File structure

- Modify `backend/routes/situations-payloads.js` — add `probable_cause_span_id` to `deriveProbableCause`; add `buildHotPath` + `buildSpanDashboardUrl`; wire new slots + `spanDashboardUid` param into `buildAnomalyEventPayload`; register 3 new class attributes; export the new helpers.
- Modify `backend/__tests__/situations-payloads.test.mjs` — new tests.
- Modify `backend/routes/situations.js` — pass `spanDashboardUid` from env at the call site.
- Modify `backend/index.js` — add a frame-permissive `/otel-data/embed` route (before the general `/otel-data` fallback). *(Optional hardening.)*
- Create `frontend/src/components/otel-data/embed/parseEmbedParams.ts` + `parseEmbedParams.test.ts`.
- Create `frontend/src/components/OtelEmbedPage.tsx`.
- Modify `frontend/src/components/otel-data/trace-detail/Waterfall.tsx` — add `focusSpanId` prop (highlight + scroll-into-view).
- Modify `frontend/src/components/otel-data/trace-detail/SpanRow.tsx` — add `data-span-id` attribute for scroll targeting.
- Modify `frontend/src/main.tsx` — route `/otel-data/embed` → `OtelEmbedPage`.
- Manual (no code): create the "OTel Problem Span" Helix dashboard; set `HELIX_SPAN_DASHBOARD_UID`.

---

## Task 1: `deriveProbableCause` returns the failing span id

**Files:**
- Modify: `backend/routes/situations-payloads.js:163-199`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add inside the existing top-level `describe` (the `span()` factory at lines 14-29 is already in scope):

```javascript
describe('deriveProbableCause span id', () => {
  it('returns the originating error span id', () => {
    const spans = [
      span({ spanId: 'root', serviceName: 'frontend', name: 'POST /checkout', startTimeNs: 0 }),
      span({ spanId: 'bad', parentSpanId: 'root', serviceName: 'redis-manual', name: 'Fetch Driver Profile',
             statusCode: 2, statusMessage: 'errors.errorString', startTimeNs: 100 }),
    ];
    const cause = deriveProbableCause(spans);
    expect(cause.probable_cause_span_id).toBe('bad');
    expect(cause.probable_cause_service).toBe('redis-manual');
    expect(cause.probable_cause_operation).toBe('Fetch Driver Profile');
  });

  it('returns empty span id when there is no error span', () => {
    expect(deriveProbableCause([span({ statusCode: 0 })]).probable_cause_span_id).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "span id"`
Expected: FAIL — `expected undefined to be 'bad'` (property doesn't exist yet).

- [ ] **Step 3: Implement**

In `situations-payloads.js`, add `probable_cause_span_id` to BOTH the `empty` object and the returned object:

```javascript
  const empty = {
    probable_cause_span_id: '',
    probable_cause_service: '', probable_cause_operation: '',
    error_type: '', error_message: '', code_location: '',
  };
```

```javascript
  return {
    probable_cause_span_id: origin.spanId || '',
    probable_cause_service: origin.serviceName || '',
    probable_cause_operation: origin.name || '',
    error_type: errorType,
    error_message: errorMessage,
    code_location: codeLocation,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "span id"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): capture probable-cause span id

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `buildHotPath` helper

**Files:**
- Modify: `backend/routes/situations-payloads.js` (add function near `blastRadius`, ~line 219; add to `module.exports`)
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('buildHotPath', () => {
  it('traces the ancestor chain root→…→error span, marking the failure', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: null, serviceName: 'frontend', name: 'POST /checkout' }),
      span({ spanId: 'b', parentSpanId: 'a', serviceName: 'driver', name: 'GetDriver' }),
      span({ spanId: 'c', parentSpanId: 'b', serviceName: 'redis-manual', name: 'Fetch Driver Profile' }),
    ];
    expect(buildHotPath(spans, 'c'))
      .toBe('frontend/POST /checkout → driver/GetDriver → redis-manual/Fetch Driver Profile ✗');
  });

  it('returns empty string for an unknown or missing span id', () => {
    expect(buildHotPath([span({ spanId: 'a' })], 'nope')).toBe('');
    expect(buildHotPath([span({ spanId: 'a' })], '')).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "buildHotPath"`
Expected: FAIL — `buildHotPath is not defined`.

- [ ] **Step 3: Implement**

Add the function (after `blastRadius`):

```javascript
// Ancestor chain from the originating error span up to the root, in call order
// (root → … → error span) as "service/operation" per hop, the failure marked
// with ✗. Deterministic; '' when the span isn't in the trace.
function buildHotPath(spans, originSpanId) {
  if (!Array.isArray(spans) || !originSpanId) return '';
  const byId = new Map(spans.map(s => [s.spanId, s]));
  const chain = [];
  const seen = new Set();
  let cur = byId.get(originSpanId);
  while (cur && !seen.has(cur.spanId)) {
    seen.add(cur.spanId);
    chain.push(cur);
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : null;
  }
  if (chain.length === 0) return '';
  chain.reverse();
  return chain
    .map((s, i) => `${s.serviceName || '?'}/${s.name || '?'}` + (i === chain.length - 1 ? ' ✗' : ''))
    .join(' → ');
}
```

Add `buildHotPath` to `module.exports`:

```javascript
  deriveProbableCause, blastRadius, anomalyFactor, priorityForTrace, buildHotPath,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "buildHotPath"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): add buildHotPath ancestor-chain helper"
```

---

## Task 3: `buildSpanDashboardUrl` helper

**Files:**
- Modify: `backend/routes/situations-payloads.js` (add after `buildHelixTraceUrlFromSummary`, ~line 268; add to `module.exports`)
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('buildSpanDashboardUrl', () => {
  it('builds a uid + trace + span deep link', () => {
    expect(buildSpanDashboardUrl({
      baseUrl: 'https://acme.onbmc.com', tenantId: '999', dashboardUid: 'abc123',
      summary: { trace_id: 'deadBEEF' }, spanId: 'span-1',
    })).toBe('https://acme.onbmc.com/dashboards/d/abc123/otel-problem-span?orgId=999&var-TraceId=DEADBEEF&var-SpanId=span-1');
  });

  it('returns empty without a dashboard uid or span id', () => {
    const base = { baseUrl: 'https://acme.onbmc.com', tenantId: '9', summary: { trace_id: 't' } };
    expect(buildSpanDashboardUrl({ ...base, spanId: 's', dashboardUid: '' })).toBe('');
    expect(buildSpanDashboardUrl({ ...base, spanId: '', dashboardUid: 'x' })).toBe('');
  });

  it('returns empty for the install-bundle placeholder endpoint', () => {
    expect(buildSpanDashboardUrl({
      baseUrl: 'https://your-tenant.onbmc.com', tenantId: '9',
      summary: { trace_id: 't' }, spanId: 's', dashboardUid: 'x',
    })).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "buildSpanDashboardUrl"`
Expected: FAIL — `buildSpanDashboardUrl is not defined`.

- [ ] **Step 3: Implement**

Add after `buildHelixTraceUrlFromSummary`:

```javascript
// Deep-link to the custom "OTel Problem Span" dashboard whose single Text panel
// iframes the configurator's waterfall scrolled to the failing span. Mirrors
// buildHelixTraceUrlFromSummary but targets a configured dashboard UID and adds
// var-SpanId. '' when uid/spanId missing or the endpoint is still the placeholder.
function buildSpanDashboardUrl({ baseUrl, tenantId, summary, spanId, dashboardUid }) {
  if (!baseUrl || !tenantId || !dashboardUid || !spanId || !summary || !summary.trace_id) return '';
  if (/\/\/your-tenant\.onbmc\.com\b/i.test(baseUrl)) return '';
  const params = new URLSearchParams({
    orgId: tenantId,
    'var-TraceId': String(summary.trace_id).toUpperCase(),
    'var-SpanId': String(spanId),
  });
  const qs = params.toString().replace(/\+/g, '%20');
  return `${String(baseUrl).replace(/\/+$/, '')}/dashboards/d/${encodeURIComponent(dashboardUid)}/otel-problem-span?${qs}`;
}
```

Add `buildSpanDashboardUrl` to `module.exports`:

```javascript
  buildHelixTraceUrlFromSummary, buildSpanDashboardUrl,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "buildSpanDashboardUrl"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): add buildSpanDashboardUrl deep-link helper"
```

---

## Task 4: Wire new slots into `buildAnomalyEventPayload`

**Files:**
- Modify: `backend/routes/situations-payloads.js:66-156`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
describe('buildAnomalyEventPayload span enrichment', () => {
  const errSpans = [
    span({ spanId: 'a', parentSpanId: null, serviceName: 'frontend', name: 'POST /checkout', startTimeNs: 0 }),
    span({ spanId: 'c', parentSpanId: 'a', serviceName: 'redis-manual', name: 'Fetch Driver Profile',
           statusCode: 2, statusMessage: 'errors.errorString', startTimeNs: 100 }),
  ];
  const summary = {
    trace_id: 'abc', service_name: 'frontend', service_namespace: 'JM_OTEL',
    root_operation: 'POST /checkout', duration_ms: 1864, span_count: 2, has_error: true, start_time_ns: 0,
  };

  it('adds span id, hot_path, and span_dashboard_url slots when spans + uid are present', () => {
    const [ev] = buildAnomalyEventPayload({
      summary, p95Ms: 200, xSource: 'JM_OTEL', spans: errSpans,
      baseUrl: 'https://acme.onbmc.com', tenantId: '999', spanDashboardUid: 'abc123',
    });
    expect(ev.class_slots.probable_cause_span_id).toBe('c');
    expect(ev.class_slots.hot_path).toBe('frontend/POST /checkout → redis-manual/Fetch Driver Profile ✗');
    expect(ev.class_slots.span_dashboard_url)
      .toBe('https://acme.onbmc.com/dashboards/d/abc123/otel-problem-span?orgId=999&var-TraceId=ABC&var-SpanId=c');
  });

  it('omits span_dashboard_url when no dashboard uid is configured', () => {
    const [ev] = buildAnomalyEventPayload({
      summary, p95Ms: 200, xSource: 'JM_OTEL', spans: errSpans,
      baseUrl: 'https://acme.onbmc.com', tenantId: '999',
    });
    expect(ev.class_slots).not.toHaveProperty('span_dashboard_url');
    expect(ev.class_slots.probable_cause_span_id).toBe('c');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "span enrichment"`
Expected: FAIL — `expected undefined to be 'c'`.

- [ ] **Step 3: Implement**

Change the function signature (line 66) to accept `spanDashboardUid`:

```javascript
function buildAnomalyEventPayload({ summary, p95Ms, businessServiceKey, xSource, spans, baseUrl, tenantId, spanDashboardUid }) {
```

After the existing `const traceUrl = …` block (~line 84), add:

```javascript
  const hotPath = (hasSpans && cause) ? buildHotPath(spans, cause.probable_cause_span_id) : '';
  const spanDashboardUrl = hasSpans
    ? buildSpanDashboardUrl({ baseUrl, tenantId, summary, spanId: cause.probable_cause_span_id, dashboardUid: (spanDashboardUid || '').trim() })
    : '';
```

In the `detailLines` enrichment block (after the `traceUrl` detail line ~line 115), add:

```javascript
  if (hasSpans && hotPath) detailLines.push(`Path to failure: ${hotPath}.`);
  if (hasSpans && spanDashboardUrl) detailLines.push(`Open the failing span: ${spanDashboardUrl}`);
```

In the `enrichedSlots` block (inside `if (hasSpans)`, after `traceUrl`/`priority` ~line 128), add:

```javascript
    if (cause.probable_cause_span_id) enrichedSlots.probable_cause_span_id = cause.probable_cause_span_id;
    if (hotPath) enrichedSlots.hot_path = hotPath;
    if (spanDashboardUrl) enrichedSlots.span_dashboard_url = spanDashboardUrl;
```

- [ ] **Step 4: Run to verify it passes (and nothing regressed)**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs`
Expected: PASS — the new "span enrichment" tests AND the existing pinned `"without spans, output is unchanged from the legacy shape"` test (the new code is all inside `if (hasSpans)`).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): emit span id, hot_path, span_dashboard_url slots"
```

---

## Task 5: Register the new class attributes

**Files:**
- Modify: `backend/routes/situations-payloads.js:8-39` (`buildClassDefinition`)
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('class definition new slots', () => {
  it('registers the three new span attributes', () => {
    const names = buildClassDefinition().attributes.map(a => a.name);
    expect(names).toEqual(expect.arrayContaining(['probable_cause_span_id', 'hot_path', 'span_dashboard_url']));
  });
  it('class update body keeps the new slots and still drops the built-in priority', () => {
    const names = buildClassUpdateBody().attributes.map(a => a.name);
    expect(names).toContain('hot_path');
    expect(names).not.toContain('priority');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "new slots"`
Expected: FAIL — array does not contain the new names.

- [ ] **Step 3: Implement**

In `buildClassDefinition`, add to the `attributes` array (after `trace_url`, before `priority`):

```javascript
      { name: 'probable_cause_span_id', dataType: 'STRING', enum: false },
      { name: 'hot_path', dataType: 'STRING', enum: false },
      { name: 'span_dashboard_url', dataType: 'STRING', enum: false },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs -t "new slots"`
Expected: PASS (2 tests). `buildClassUpdateBody` already filters only `priority`, so the new STRING slots pass through unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): register span_id/hot_path/span_dashboard_url class slots"
```

---

## Task 6: Pass `spanDashboardUid` at the route call site

**Files:**
- Modify: `backend/routes/situations.js:90-97`

- [ ] **Step 1: Edit the call site**

In the `buildAnomalyEventPayload({ … })` call inside `/api/situations/convert-trace`, add the new argument:

```javascript
  const payload = buildAnomalyEventPayload({
    summary,
    p95Ms,
    businessServiceKey: (process.env.BUSINESS_SERVICE_KEY || '').trim(),
    xSource: process.env.X_SOURCE,
    spans: trace.spans,
    baseUrl: portalBaseUrl,
    tenantId,
    spanDashboardUid: (process.env.HELIX_SPAN_DASHBOARD_UID || '').trim(),
  });
```

- [ ] **Step 2: Run the full backend suite (no regressions)**

Run: `cd backend && npm test`
Expected: PASS (all existing + new tests). This change is pure wiring; payload behavior is covered by Task 4.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/situations.js
git commit -m "feat(situations): wire HELIX_SPAN_DASHBOARD_UID into the trace-convert route"
```

---

## Task 7: `parseEmbedParams` (frontend pure function)

**Files:**
- Create: `frontend/src/components/otel-data/embed/parseEmbedParams.ts`
- Test: `frontend/src/components/otel-data/embed/parseEmbedParams.test.ts`

- [ ] **Step 1: Write the failing test**

`parseEmbedParams.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseEmbedParams } from './parseEmbedParams';

describe('parseEmbedParams', () => {
  it('reads trace and span from the query string', () => {
    expect(parseEmbedParams('?trace=abc&span=s1')).toEqual({ traceId: 'abc', spanId: 's1' });
  });
  it('returns nulls when params are missing or blank', () => {
    expect(parseEmbedParams('?trace=&span=')).toEqual({ traceId: null, spanId: null });
    expect(parseEmbedParams('')).toEqual({ traceId: null, spanId: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npm test -- parseEmbedParams`
Expected: FAIL — cannot resolve `./parseEmbedParams`.

- [ ] **Step 3: Implement**

`parseEmbedParams.ts`:

```typescript
export type EmbedParams = { traceId: string | null; spanId: string | null };

export function parseEmbedParams(search: string): EmbedParams {
  const p = new URLSearchParams(search || '');
  const traceId = (p.get('trace') || '').trim() || null;
  const spanId = (p.get('span') || '').trim() || null;
  return { traceId, spanId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npm test -- parseEmbedParams`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/otel-data/embed/parseEmbedParams.ts frontend/src/components/otel-data/embed/parseEmbedParams.test.ts
git commit -m "feat(otel-embed): add parseEmbedParams query parser"
```

---

## Task 8: `Waterfall` gains `focusSpanId` (highlight + scroll)

**Files:**
- Modify: `frontend/src/components/otel-data/trace-detail/Waterfall.tsx:180,199-209`
- Modify: `frontend/src/components/otel-data/trace-detail/SpanRow.tsx:102`

*No component test infra exists (the repo unit-tests pure functions only). Verified by `tsc`/build in Step 3 and live in Task 12.*

- [ ] **Step 1: Add `data-span-id` to the span row**

In `SpanRow.tsx`, add the attribute to the outer wrapper `div` (line 102):

```jsx
  return (
    <div data-span-id={span.spanId} className={`group transition-all duration-200 ${open ? 'bg-gray-900/60' : ''} ${isDimmed ? 'opacity-40' : ''}`}>
```

- [ ] **Step 2: Add the `focusSpanId` prop + highlight + scroll**

In `Waterfall.tsx`, change the component signature (line 180):

```typescript
export const Waterfall: React.FC<{ detail: TraceDetail; logs: LogRecord[]; focusSpanId?: string | null }> = ({ detail, logs, focusSpanId }) => {
```

Make `focusSpanId` win in `isSpanHighlighted` (add as the first check, line ~199):

```typescript
  const isSpanHighlighted = (span: SpanDetail): boolean => {
    if (focusSpanId && span.spanId === focusSpanId) return true;
    if (spanSearchQuery && spanMatchesQuery(span, spanSearchQuery)) return true;
    const activeSvc = selectedService || hoveredService;
    if (activeSvc && span.serviceName === activeSvc) return true;
    return false;
  };
```

Add a scroll-into-view effect (place near the other hooks at the top of the component body; ensure `useEffect` is imported from `react`):

```typescript
  useEffect(() => {
    if (!focusSpanId) return;
    const el = document.querySelector(`[data-span-id="${CSS.escape(focusSpanId)}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusSpanId, detail]);
```

- [ ] **Step 3: Type-check / build**

Run: `cd frontend && npm run build`
Expected: PASS (tsc + vite build, no type errors). `focusSpanId` is optional, so existing `<Waterfall>` usages remain valid.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/otel-data/trace-detail/Waterfall.tsx frontend/src/components/otel-data/trace-detail/SpanRow.tsx
git commit -m "feat(otel-embed): Waterfall focusSpanId highlight + scroll"
```

---

## Task 9: `OtelEmbedPage` chromeless component

**Files:**
- Create: `frontend/src/components/OtelEmbedPage.tsx`

*Verified by build (Step 2) + live (Task 12).*

- [ ] **Step 1: Create the component**

`OtelEmbedPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Waterfall } from './otel-data/trace-detail/Waterfall';
import { parseEmbedParams } from './otel-data/embed/parseEmbedParams';
import type { TraceDetail, LogRecord } from './otel-data/types';

export default function OtelEmbedPage() {
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { traceId, spanId } = parseEmbedParams(typeof window !== 'undefined' ? window.location.search : '');

  useEffect(() => {
    if (!traceId) { setError('Missing ?trace= parameter'); setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      fetch(`/api/traces/${traceId}`).then(r => (r.ok ? r.json() : null)),
      fetch(`/api/logs/${traceId}`).then(r => (r.ok ? r.json() : { logs: [] })),
    ]).then(([d, l]) => {
      if (cancelled) return;
      if (!d) { setError('Trace not found'); setLoading(false); return; }
      setDetail(d as TraceDetail);
      setLogs(((l && l.logs) || []) as LogRecord[]);
      setLoading(false);
    }).catch(() => { if (!cancelled) { setError('Failed to load trace'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [traceId]);

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading trace…</div>;
  if (error || !detail) return <div className="p-4 text-sm text-red-400">{error || 'No trace'}</div>;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Waterfall detail={detail} logs={logs} focusSpanId={spanId} />
    </div>
  );
}
```

- [ ] **Step 2: Build (also confirms the type imports resolve)**

Run: `cd frontend && npm run build`
Expected: PASS. If `LogRecord` is not exported from `./otel-data/types`, import it from the same module `TraceDetailDrawer.tsx` uses and re-run.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/OtelEmbedPage.tsx
git commit -m "feat(otel-embed): chromeless OtelEmbedPage rendering the waterfall"
```

---

## Task 10: Route `/otel-data/embed` → `OtelEmbedPage`

**Files:**
- Modify: `frontend/src/main.tsx:10-22`

*Verified by build (Step 2) + live (Task 12).*

- [ ] **Step 1: Add import + route branch**

Add the import alongside the other page imports:

```typescript
import OtelEmbedPage from './components/OtelEmbedPage'
```

Update the route flags and render so `/otel-data/embed` is matched **before** the general `/otel-data`:

```typescript
const path = window.location.pathname
const isOtelEmbed = path.startsWith('/otel-data/embed')
const isAiops = path.startsWith('/aiops')
const isOtelData = path.startsWith('/otel-data') && !isOtelEmbed
const isStepZero = path.startsWith('/step-zero')
const isDashboardMockup = path.startsWith('/dashboard-mockup')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOtelEmbed ? <OtelEmbedPage /> :
     isAiops ? <AiopsPage /> :
     isOtelData ? <OtelDataPage /> :
     isStepZero ? <StepZero /> :
     isDashboardMockup ? <DashboardMockup /> :
     <App />}
  </React.StrictMode>,
)
```

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/main.tsx
git commit -m "feat(otel-embed): route /otel-data/embed to OtelEmbedPage"
```

---

## Task 11: Frame-permissive header for the embed route (optional hardening)

**Files:**
- Modify: `backend/index.js:46-48` (add a route **before** the existing `/^\/otel-data(\/.*)?$/` fallback)

*Framing already works (no helmet / no `X-Frame-Options`). This scopes/locks framing to the Helix origin and future-proofs against a later helmet addition.*

- [ ] **Step 1: Add the embed route before the general otel-data fallback**

```javascript
// Embed surface for the Helix-dashboard iframe. Served like the SPA but with an
// explicit frame-ancestors so it stays framable by the Helix portal even if a
// CSP/helmet layer is added later. Must precede the general /otel-data fallback.
app.get(/^\/otel-data\/embed(\/.*)?$/, (req, res) => {
  const helixOrigin = (process.env.HELIX_ENDPOINT || '').trim().replace(/\/+$/, '');
  const ancestors = helixOrigin ? `'self' ${helixOrigin}` : "'self' https:";
  res.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
  res.removeHeader('X-Frame-Options');
  res.sendFile(path.join(__dirname, '../frontend-dist/index.html'));
});
```

- [ ] **Step 2: Verify serving + header**

Run (with the backend running, build present):
```bash
curl -sI http://localhost:3001/otel-data/embed | grep -i 'content-security-policy\|x-frame-options'
```
Expected: a `Content-Security-Policy: frame-ancestors …` line; **no** `X-Frame-Options` line.

- [ ] **Step 3: Commit**

```bash
git add backend/index.js
git commit -m "feat(otel-embed): scope frame-ancestors for the embed route"
```

---

## Task 12: Manual Helix dashboard + live end-to-end verification

*No code. One-time tenant setup + acceptance.*

- [ ] **Step 1: Create the "OTel Problem Span" dashboard**

In Helix Dashboards → **New dashboard**:
1. Dashboard **Settings → Variables**: add `TraceId` (Type: *Textbox*) and `SpanId` (Type: *Textbox*).
2. **Add panel → Text**, **Mode: HTML**, content (replace `<VIEWER_BASE>` with the configurator's public/tunnel URL, e.g. `https://demo-xyz.trycloudflare.com`):

```html
<iframe src="https://<VIEWER_BASE>/otel-data/embed?trace=${TraceId}&span=${SpanId}"
        width="100%" height="800" frameborder="0"></iframe>
```

3. **Save**. Copy the dashboard **UID** from the URL (`/dashboards/d/<UID>/…`).

- [ ] **Step 2: Configure the configurator**

In the configurator `.env`: set `HELIX_SPAN_DASHBOARD_UID=<UID>`; confirm `HELIX_ENDPOINT`, `HELIX_API_KEY`, `X_SOURCE` are set; set `INSTALL_BASE_URL` to the tunnel base (so `<VIEWER_BASE>` and the served embed origin match). Restart the backend.

- [ ] **Step 3: Direct embed-route check**

Open `https://<VIEWER_BASE>/otel-data/embed?trace=<id>&span=<spanId>` in a browser. Expected: chromeless waterfall with the target span highlighted (left primary border) and scrolled into view. (Demo tunnels leave `UI_AUTH_PASSWORD` blank per [[feedback_demo_auth]], so `/api/traces/*` is reachable from the iframe.)

- [ ] **Step 4: Full path**

1. Inject an error trace via the OTel Traffic Simulator / synthetic scenario.
2. Convert it: `POST /api/situations/convert-trace` with `{ "traceId": "<id>" }`. Expected: 200; the sent event's `class_slots` include `probable_cause_span_id`, `hot_path`, and `span_dashboard_url`.
3. In Helix AIOps: open the resulting Situation → **Events** → the event → **Event Details**. Confirm `hot_path`, `probable_cause_span_id`, `span_dashboard_url` are present; click `span_dashboard_url`.
4. Expected: the custom dashboard opens and renders the **embedded waterfall with the failing span highlighted + centered**.

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch (merge/PR/cleanup). The native `trace_url` slot is retained as the secondary "see it in Helix" link.

---

## Self-review notes

- **Spec coverage:** Component A → Tasks 1–6; Option 3 text (B) → Tasks 4–6 + 12; Option 2 embed (C1 route → Tasks 9–10; C2 headers → Task 11 [now optional, helmet absent]; C3 link → Tasks 3–6; C4 dashboard → Task 12). HelixGPT narration is automatic (no task). ✔
- **Resolved risk:** the spec's "header blocker" doesn't exist — no helmet in `backend/index.js`; framing works by default, so Task 11 is hardening.
- **Type/name consistency:** `probable_cause_span_id`, `hot_path`, `span_dashboard_url`, `buildHotPath(spans, originSpanId)`, `buildSpanDashboardUrl({baseUrl,tenantId,summary,spanId,dashboardUid})`, `spanDashboardUid` param, `parseEmbedParams → {traceId, spanId}`, `focusSpanId`, `data-span-id`, `HELIX_SPAN_DASHBOARD_UID` — used identically across tasks. ✔
