# Situation auto-close + event-notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator resolve a sent OTel-anomaly so its Helix event(s) close (and the correlated Situation auto-closes), and attach event-level triage/resolution notes — all without depending on the trace viewer or browser retaining any state.

**Architecture:** Resolution is stateless: the backend re-discovers the configurator's own open `OTEL_TRACE_ANOMALY` events from Helix by their deterministic `source_identifier` (`helix-otel-trace:<traceId>[:<svc>]`) via the events-service `msearch` API, then closes each via `PATCH /events/<id>`. Pure, network-free builders live in `backend/routes/situations-payloads.js` (unit-tested in isolation); `backend/routes/situations.js` wires them to the events-service over the existing IMS Bearer-JWT auth. Two viewer-independent UI surfaces hit the same endpoints: a "Sent events" panel in the Helix settings drawer and a Resolve button in the trace drawer.

**Tech Stack:** Node/Express (CommonJS) backend, Vitest tests (`backend/__tests__/*.test.mjs`), React + TypeScript + Tailwind frontend, BMC Helix events-service REST API (Elasticsearch-DSL `msearch`, PATCH event update).

---

## Verified BMC API shapes (from docs.bmc.com / docs.helixops.ai, 2026-06-18)

- **Search:** `POST {base}/events-service/api/v1.0/events/msearch`, body is Elasticsearch DSL. Filter via `query_string.query`, e.g. `class:OTEL_TRACE_ANOMALY AND status:OPEN AND source_identifier.keyword:helix-otel-trace\:<traceId>*`. Colons escaped `\:`; trailing `*` with `analyze_wildcard:true` catches the `:<svc>` suffix.
- **Update/close:** `PATCH {base}/events-service/api/v1.0/events/<event-id>` (omit `?skipAddNotes=true` so a Logs-and-Notes entry IS recorded). Body e.g. `{"status":"CLOSED"}`. Success → `{ "successfullEventIds": ["eps...."], ... }`.
- **Auth:** reuse the existing IMS Bearer JWT (`getHelixBearerToken`) + `bmcHeaders` (`Accept: application/json`).

**Three items to confirm against a live tenant in Task 10 (each isolated to one builder, so a change is one-spot):**
1. The msearch **response hit shape** (`hits.hits[]._id` vs `_source.id`) and the `_source` slot field names used by `summarizeOpenEvents`.
2. Whether the events POST (ingest) response exposes created ids as `successfullEventIds` (used by `extractCreatedEventIds`).
3. Whether a `notes` slot is accepted on the update PATCH (the custom note is best-effort; the status-only close is the guaranteed part regardless).

---

## File Structure

- **Modify** `backend/routes/situations-payloads.js` — add pure builders: `buildEventSearchQuery`, `buildEventSearchBody`, `buildEventSearchUrl`, `buildEventByIdUrl`, `extractSearchEventIds`, `extractCreatedEventIds`, `summarizeOpenEvents`, `buildTriageNote`, `buildTriageNoteForTrace`, `buildResolutionNote`, `buildEventUpdateBody`. Export all.
- **Modify** `backend/routes/situations.js` — best-effort triage note on `convert-trace`; new `POST /api/situations/close-events`; new `GET /api/situations/open-events`.
- **Modify** `backend/__tests__/situations-payloads.test.mjs` — unit tests for the new builders.
- **Create** `backend/__tests__/situations-routes.test.mjs` — supertest + axios-spy route tests for close-events / open-events.
- **Modify** `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx` — "Sent events" panel.
- **Modify** `frontend/src/components/otel-data/trace-detail/TraceDetailDrawer.tsx` — Resolve button.

Test commands (run from repo root):
- Single payloads file: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs`
- Single test by name: append ` -t "name"`
- Routes file: `npm --prefix backend test -- __tests__/situations-routes.test.mjs`
- Full backend suite: `npm --prefix backend test`

---

### Task 1: Event-search query + URL builders

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `backend/__tests__/situations-payloads.test.mjs`. First add the new names to the existing destructured `require('../routes/situations-payloads')` import at the top of the file:

```js
// add to the existing destructuring block:
//   buildEventSearchQuery, buildEventSearchBody, buildEventSearchUrl, buildEventByIdUrl,
```

Then append:

```js
describe('event search builders', () => {
  it('buildEventSearchQuery scopes to our class + OPEN, with an escaped source_identifier prefix', () => {
    const q = buildEventSearchQuery({ traceId: 'abc123' });
    expect(q).toBe("class:OTEL_TRACE_ANOMALY AND status:OPEN AND source_identifier.keyword:helix-otel-trace\\:abc123*");
  });

  it('buildEventSearchQuery with all:true drops the source_identifier clause', () => {
    expect(buildEventSearchQuery({ all: true })).toBe('class:OTEL_TRACE_ANOMALY AND status:OPEN');
  });

  it('buildEventSearchBody wraps the query in an msearch DSL body', () => {
    const body = buildEventSearchBody({ all: true });
    expect(body.size).toBe(500);
    expect(body.query.bool.filter[0].query_string.analyze_wildcard).toBe(true);
    expect(body.query.bool.filter[0].query_string.query).toBe('class:OTEL_TRACE_ANOMALY AND status:OPEN');
    expect(body.sort.creation_time.order).toBe('desc');
  });

  it('buildEventSearchUrl and buildEventByIdUrl target the events-service paths', () => {
    expect(buildEventSearchUrl('https://t.onbmc.com/')).toBe('https://t.onbmc.com/events-service/api/v1.0/events/msearch');
    expect(buildEventByIdUrl('https://t.onbmc.com', 'eps.1:2')).toBe('https://t.onbmc.com/events-service/api/v1.0/events/eps.1%3A2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "event search builders"`
Expected: FAIL — `buildEventSearchQuery is not a function` (not yet exported).

- [ ] **Step 3: Implement the builders**

In `backend/routes/situations-payloads.js`, add near the other URL helpers (after `classesBase`/`buildClassByIdUrl`):

```js
// ---- Event search + update (auto-close / notes) ----

const eventsBase = (base) => `${String(base).replace(/\/+$/, '')}/events-service/api/v1.0/events`;
function buildEventSearchUrl(base) { return `${eventsBase(base)}/msearch`; }
function buildEventByIdUrl(base, id) { return `${eventsBase(base)}/${encodeURIComponent(id)}`; }

// Elasticsearch query_string to find the configurator's OWN open OTEL_TRACE_ANOMALY
// events. Colons in source_identifier are escaped (\:) per BMC's msearch DSL, and a
// trailing * (with analyze_wildcard) catches the optional :<service> suffix that
// multi-event mode appends.
function buildEventSearchQuery({ traceId, all } = {}) {
  const parts = [`class:${OTEL_TRACE_ANOMALY_CLASS}`, 'status:OPEN'];
  if (!all && traceId) {
    const esc = String(traceId).replace(/[\\:]/g, '\\$&');
    parts.push(`source_identifier.keyword:helix-otel-trace\\:${esc}*`);
  }
  return parts.join(' AND ');
}

// BMC events msearch request body (Elasticsearch DSL). size caps results; newest first.
function buildEventSearchBody({ traceId, all, size = 500 } = {}) {
  return {
    size,
    query: { bool: { filter: [{ query_string: { analyze_wildcard: true, query: buildEventSearchQuery({ traceId, all }) } }] } },
    sort: { creation_time: { order: 'desc', unmapped_type: 'boolean' } },
    script_fields: {},
  };
}
```

Add all four names to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "event search builders"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): event msearch query/url builders for auto-close"
```

---

### Task 2: Event-id extractors

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `extractSearchEventIds, extractCreatedEventIds` to the import block, then append:

```js
describe('event-id extractors', () => {
  it('extractSearchEventIds reads ids from msearch hits (_id, then _source fallbacks)', () => {
    const resp = { hits: { hits: [
      { _id: 'eps.1', _source: { id: 'ignored' } },
      { _source: { _id: 'eps.2' } },
      { _source: { id: 'eps.3' } },
      { _id: 'eps.1' }, // dup
    ] } };
    expect(extractSearchEventIds(resp)).toEqual(['eps.1', 'eps.2', 'eps.3']);
  });

  it('extractSearchEventIds returns [] for empty/malformed responses', () => {
    expect(extractSearchEventIds(null)).toEqual([]);
    expect(extractSearchEventIds({})).toEqual([]);
    expect(extractSearchEventIds({ hits: {} })).toEqual([]);
  });

  it('extractCreatedEventIds reads successfullEventIds (sic) and tolerant fallbacks', () => {
    expect(extractCreatedEventIds({ successfullEventIds: ['eps.9'] })).toEqual(['eps.9']);
    expect(extractCreatedEventIds({ eventIds: ['eps.8'] })).toEqual(['eps.8']);
    expect(extractCreatedEventIds(['eps.7'])).toEqual(['eps.7']);
    expect(extractCreatedEventIds([{ id: 'eps.6' }])).toEqual(['eps.6']);
    expect(extractCreatedEventIds(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "event-id extractors"`
Expected: FAIL — `extractSearchEventIds is not a function`.

- [ ] **Step 3: Implement the extractors**

In `situations-payloads.js`:

```js
// IDs of the open events returned by an msearch (Elasticsearch hits shape). Defensive
// across the common id locations; confirm the exact field live (Task 10, risk #1).
function extractSearchEventIds(resp) {
  const hits = resp && resp.hits && Array.isArray(resp.hits.hits) ? resp.hits.hits : [];
  const ids = [];
  for (const h of hits) {
    const id = (h && (h._id || (h._source && (h._source._id || h._source.id)))) || '';
    if (id && !ids.includes(String(id))) ids.push(String(id));
  }
  return ids;
}

// IDs of events created by a POST /events ingest call. BMC wraps created ids in
// successfullEventIds (sic on the double-l); tolerate a few shapes (Task 10, risk #2).
function extractCreatedEventIds(resp) {
  if (!resp) return [];
  if (Array.isArray(resp)) {
    return resp.map((x) => (typeof x === 'string' ? x : x && (x.id || x._id))).filter(Boolean).map(String);
  }
  const arr = resp.successfullEventIds || resp.successfulEventIds || resp.eventIds || [];
  return Array.isArray(arr) ? arr.filter(Boolean).map(String) : [];
}
```

Add both to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "event-id extractors"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): msearch + ingest event-id extractors"
```

---

### Task 3: Open-events summarizer (for the panel)

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `summarizeOpenEvents` to the import block, then append:

```js
describe('summarizeOpenEvents', () => {
  it('trims msearch hits to the panel fields', () => {
    const resp = { hits: { hits: [
      { _id: 'eps.1', _source: { service_name: 'redis-manual', msg: 'OTel anomaly: x', severity: 'CRITICAL', source_identifier: 'helix-otel-trace:abc', creation_time: 111 } },
      { _id: 'eps.2', _source: { service_name: 'hotrod' } },
    ] } };
    expect(summarizeOpenEvents(resp)).toEqual([
      { id: 'eps.1', service: 'redis-manual', msg: 'OTel anomaly: x', severity: 'CRITICAL', sourceIdentifier: 'helix-otel-trace:abc', creationTime: 111 },
      { id: 'eps.2', service: 'hotrod', msg: '', severity: '', sourceIdentifier: '', creationTime: null },
    ]);
  });

  it('drops hits with no id and tolerates empty input', () => {
    expect(summarizeOpenEvents({ hits: { hits: [{ _source: {} }] } })).toEqual([]);
    expect(summarizeOpenEvents(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "summarizeOpenEvents"`
Expected: FAIL — `summarizeOpenEvents is not a function`.

- [ ] **Step 3: Implement the summarizer**

```js
// Trim msearch hits to the fields the "Sent events" panel renders. _source slot
// names mirror our event class_slots; confirm live (Task 10, risk #1).
function summarizeOpenEvents(resp) {
  const hits = resp && resp.hits && Array.isArray(resp.hits.hits) ? resp.hits.hits : [];
  return hits.map((h) => {
    const s = (h && h._source) || {};
    return {
      id: String((h && h._id) || s._id || s.id || ''),
      service: s.service_name || '',
      msg: s.msg || '',
      severity: s.severity || '',
      sourceIdentifier: s.source_identifier || '',
      creationTime: s.creation_time != null ? s.creation_time : (s.creationTime != null ? s.creationTime : null),
    };
  }).filter((e) => e.id);
}
```

Add to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "summarizeOpenEvents"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): summarizeOpenEvents for the sent-events panel"
```

---

### Task 4: Note + update-body builders

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `buildTriageNote, buildTriageNoteForTrace, buildResolutionNote, buildEventUpdateBody` to the import block. (`deriveProbableCause` and `buildHelixTraceUrlFromSummary` are already imported.) Append:

```js
describe('note + update builders', () => {
  const summary = { service_name: 'redis-manual', root_operation: 'Fetch Driver Profile', trace_id: 'abc', service_namespace: 'hotrod', start_time_ns: 0 };
  const cause = { probable_cause_service: 'redis-manual', probable_cause_operation: 'GET driver', error_type: 'redis.TimeoutError', error_message: 'timed out', code_location: 'a.py:get:1' };

  it('buildTriageNote leads with cause + location + recommendation + trace link', () => {
    const n = buildTriageNote(summary, cause, 'https://t/trace');
    expect(n).toContain('probable cause redis-manual/GET driver (redis.TimeoutError — timed out)');
    expect(n).toContain('Location: a.py:get:1');
    expect(n).toContain('Recommended:');
    expect(n).toContain('Trace: https://t/trace');
  });

  it('buildTriageNote falls back to the root op when no cause', () => {
    expect(buildTriageNote(summary, null, '')).toContain('probable cause redis-manual/Fetch Driver Profile (latency/availability anomaly)');
  });

  it('buildTriageNoteForTrace returns "" with no spans', () => {
    expect(buildTriageNoteForTrace({ summary, spans: [], baseUrl: 'https://t', tenantId: 'T1', source: 'hotrod' })).toBe('');
  });

  it('buildResolutionNote names the service/op, tolerates null', () => {
    expect(buildResolutionNote(summary)).toBe('Resolved via Helix Configurator: redis-manual/Fetch Driver Profile anomaly cleared; closing event.');
    expect(buildResolutionNote(null)).toBe('Resolved via Helix Configurator: service anomaly cleared; closing event.');
  });

  it('buildEventUpdateBody sets status and/or a notes list', () => {
    expect(buildEventUpdateBody({ status: 'CLOSED' })).toEqual({ status: 'CLOSED' });
    expect(buildEventUpdateBody({ note: 'hi' })).toEqual({ notes: ['hi'] });
    expect(buildEventUpdateBody({ status: 'CLOSED', note: 'hi' })).toEqual({ status: 'CLOSED', notes: ['hi'] });
    expect(buildEventUpdateBody({})).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "note + update builders"`
Expected: FAIL — `buildTriageNote is not a function`.

- [ ] **Step 3: Implement the builders**

```js
// Analyst-style note for the event's Logs & Notes audit trail at send time —
// distinct from the event `details` body; leads with the recommended next step.
function buildTriageNote(summary, cause, traceUrl) {
  if (!summary) return '';
  const where = cause && cause.probable_cause_service
    ? `${cause.probable_cause_service}/${cause.probable_cause_operation || '?'}`
    : `${summary.service_name}/${summary.root_operation}`;
  const what = cause && (cause.error_type || cause.error_message)
    ? `${cause.error_type || 'error'}${cause.error_message ? ` — ${cause.error_message}` : ''}`
    : 'latency/availability anomaly';
  return [
    `Triaged by Helix Configurator: probable cause ${where} (${what}).`,
    cause && cause.code_location ? `Location: ${cause.code_location}.` : '',
    'Recommended: inspect the failing span and the correlated trace.',
    traceUrl ? `Trace: ${traceUrl}` : '',
  ].filter(Boolean).join(' ');
}

// Convenience wrapper: derive cause + trace deep-link from the trace and build the
// triage note in one call (keeps the route tidy). '' when the trace has no spans.
function buildTriageNoteForTrace({ summary, spans, baseUrl, tenantId, source }) {
  if (!Array.isArray(spans) || spans.length === 0) return '';
  const cause = deriveProbableCause(spans);
  const traceUrl = buildHelixTraceUrlFromSummary({ baseUrl, tenantId, source: (source || '').trim(), summary });
  return buildTriageNote(summary, cause, traceUrl);
}

// Note recorded when the operator resolves the anomaly.
function buildResolutionNote(summary) {
  const svc = (summary && summary.service_name) || 'service';
  const op = summary && summary.root_operation ? `/${summary.root_operation}` : '';
  return `Resolved via Helix Configurator: ${svc}${op} anomaly cleared; closing event.`;
}

// PATCH body for the events update op. status drives the close; note (when given)
// goes to the Logs & Notes tab (caller must omit ?skipAddNotes so it is recorded).
function buildEventUpdateBody({ status, note } = {}) {
  const body = {};
  if (status) body.status = status;
  if (note) body.notes = [note];
  return body;
}
```

Add all four to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs -t "note + update builders"`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full payloads file to confirm no regressions**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs`
Expected: PASS (all prior + new).

- [ ] **Step 6: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): triage/resolution note + event-update body builders"
```

---

### Task 5: Best-effort triage note on convert-trace

**Files:**
- Modify: `backend/routes/situations.js` (the `convert-trace` success branch, ~L118)
- Test: `backend/__tests__/situations-routes.test.mjs` (created in Task 6; the triage-note assertion is added there)

- [ ] **Step 1: Extend the import in situations.js**

At the top `require('./situations-payloads')` destructuring, add:
`buildTriageNoteForTrace, buildEventUpdateBody, buildEventByIdUrl, extractCreatedEventIds, buildEventSearchUrl, buildEventSearchBody, extractSearchEventIds, buildResolutionNote, summarizeOpenEvents,`

- [ ] **Step 2: Add a best-effort note helper + wire it into the success branch**

Add a module-level helper in `situations.js` (above `register`):

```js
// Best-effort: PATCH a note onto each just-created event's Logs & Notes tab.
// Never throws — a note failure must not fail the send. Returns true if any wrote.
async function attachNoteToEvents(baseUrl, bearer, eventIds, note) {
  if (!note || !Array.isArray(eventIds) || eventIds.length === 0) return false;
  let any = false;
  for (const id of eventIds) {
    try {
      const r = await axios.patch(buildEventByIdUrl(baseUrl, id), buildEventUpdateBody({ note }), {
        headers: bmcHeaders(bearer), timeout: 10_000, validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) any = true;
    } catch { /* best-effort */ }
  }
  return any;
}
```

In the `convert-trace` handler, replace the success return (currently `return res.json({ ok: true, severity, upstream: response.data });`) with:

```js
if (response.status >= 200 && response.status < 300) {
  const createdIds = extractCreatedEventIds(response.data);
  const triageNote = buildTriageNoteForTrace({
    summary, spans: trace.spans, baseUrl: portalBaseUrl, tenantId, source: process.env.X_SOURCE,
  });
  let noteWritten = false;
  try { noteWritten = await attachNoteToEvents(baseUrl, bearer, createdIds, triageNote); } catch { /* best-effort */ }
  return res.json({ ok: true, severity, eventIds: createdIds, noteWritten, upstream: response.data });
}
```

(Note: `bearer` is already in scope from the earlier `getHelixBearerToken` call; `summary`, `portalBaseUrl`, `tenantId` are already defined above the payload build.)

- [ ] **Step 3: Verify nothing breaks yet**

Run: `npm --prefix backend test -- __tests__/situations-payloads.test.mjs`
Expected: PASS (unchanged — this task only edits the route; its assertion lands in Task 6).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/situations.js
git commit -m "feat(situations): best-effort triage note + return eventIds on convert-trace"
```

---

### Task 6: `POST /api/situations/close-events`

**Files:**
- Modify: `backend/routes/situations.js`
- Create: `backend/__tests__/situations-routes.test.mjs`

- [ ] **Step 1: Write the failing route test**

Create `backend/__tests__/situations-routes.test.mjs`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import express from 'express';
const require = createRequire(import.meta.url);
const axios = require('axios');
const { register } = require('../routes/situations');

// situations.js reads process.env directly. Set a fresh key per test so the
// module-level Bearer cache doesn't bleed across tests.
let keyCounter = 0;
function setEnv() {
  keyCounter += 1;
  process.env.HELIX_ENDPOINT = 'https://acme.onbmc.com';
  process.env.HELIX_EVENTS_ENDPOINT = 'https://acme.onbmc.com';
  process.env.HELIX_API_KEY = `T${keyCounter}::AK::SK`;
}
function makeApp() {
  const app = express();
  app.use(express.json());
  register(app, { otelStore: { getTrace: () => null } });
  return app;
}
// Route IMS login + msearch + patch through a URL-branching axios.post/.patch spy.
function mockAxios({ hits = [] } = {}) {
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (url.endsWith('/ims/api/v1/access_keys/login')) return { status: 200, data: { json_web_token: 'jwt' } };
    if (url.endsWith('/events/msearch')) return { status: 200, data: { hits: { hits } } };
    return { status: 404, data: {} };
  });
  const patchSpy = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { successfullEventIds: ['x'] } });
  return { patchSpy };
}

beforeEach(setEnv);
afterEach(() => vi.restoreAllMocks());

describe('POST /api/situations/close-events', () => {
  it('412s when no API key is configured', async () => {
    delete process.env.HELIX_API_KEY;
    const res = await request(makeApp()).post('/api/situations/close-events').send({ all: true });
    expect(res.status).toBe(412);
  });

  it('searches by traceId then PATCHes each match to CLOSED', async () => {
    const { patchSpy } = mockAxios({ hits: [{ _id: 'eps.1' }, { _id: 'eps.2' }] });
    const res = await request(makeApp()).post('/api/situations/close-events').send({ traceId: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.closed).toBe(2);
    // first call closes (status), an optional best-effort note PATCH may follow.
    const closeCalls = patchSpy.mock.calls.filter(([, b]) => b && b.status === 'CLOSED');
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[0][0]).toContain('/events-service/api/v1.0/events/eps.1');
  });

  it('closes by explicit eventIds without searching', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { json_web_token: 'jwt' } });
    vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: {} });
    const res = await request(makeApp()).post('/api/situations/close-events').send({ eventIds: ['eps.9'] });
    expect(res.status).toBe(200);
    expect(res.body.closed).toBe(1);
    // only the IMS login should have used post — never msearch.
    expect(postSpy.mock.calls.some(([u]) => u.endsWith('/events/msearch'))).toBe(false);
  });

  it('soft-succeeds with closed:0 when nothing matches', async () => {
    mockAxios({ hits: [] });
    const res = await request(makeApp()).post('/api/situations/close-events').send({ traceId: 'none' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, closed: 0 });
  });

  it('400s when neither traceId, all, nor eventIds is given', async () => {
    const res = await request(makeApp()).post('/api/situations/close-events').send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix backend test -- __tests__/situations-routes.test.mjs`
Expected: FAIL — route returns 404 (not yet registered).

- [ ] **Step 3: Implement the route**

In `situations.js`, inside `register(app, ...)`, after the `provision-correlation-policy` handler:

```js
// Close the configurator's OWN open OTEL_TRACE_ANOMALY events so the correlated
// Situation auto-closes. Stateless: re-discovers events from Helix by
// source_identifier (no remembered ids). Non-destructive — only ever touches
// events whose class is OTEL_TRACE_ANOMALY (the search is scoped to it).
app.post('/api/situations/close-events', async (req, res) => {
  const { traceId, all, eventIds } = req.body || {};
  const explicitIds = Array.isArray(eventIds) ? eventIds.filter((x) => typeof x === 'string' && x.trim()) : null;
  if (!traceId && !all && (!explicitIds || explicitIds.length === 0)) {
    return res.status(400).json({ error: 'Provide one of: traceId, all:true, or eventIds[]' });
  }
  const apiKey = (process.env.HELIX_API_KEY || '').trim();
  if (!apiKey) return res.status(412).json({ error: 'HELIX_API_KEY not configured — set it on the Settings page first.' });
  const baseUrl = resolveEventsBaseUrl();
  if (!baseUrl) return res.status(412).json({ error: 'No events endpoint configured — set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });

  let bearer;
  try { bearer = await getHelixBearerToken(baseUrl, apiKey); }
  catch (e) { return res.status(502).json({ error: 'Helix authentication failed', details: e.message, upstream: e.upstream }); }

  let ids = explicitIds;
  if (!ids || ids.length === 0) {
    try {
      const sr = await axios.post(buildEventSearchUrl(baseUrl), buildEventSearchBody({ traceId, all: !!all }), {
        headers: bmcHeaders(bearer), timeout: 15_000, validateStatus: () => true,
      });
      if (sr.status < 200 || sr.status >= 300) {
        return res.status(502).json({ error: `Helix event search returned ${sr.status}`, upstream: sr.data });
      }
      ids = extractSearchEventIds(sr.data);
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Helix event search API', details: e.message });
    }
  }
  if (ids.length === 0) return res.json({ ok: true, closed: 0, results: [] });

  const note = buildResolutionNote(null);
  const results = [];
  for (const id of ids) {
    let ok = false; let status = 0;
    try {
      // 1) Guaranteed close (status only). Omitting ?skipAddNotes records an auto note.
      const r = await axios.patch(buildEventByIdUrl(baseUrl, id), buildEventUpdateBody({ status: 'CLOSED' }), {
        headers: bmcHeaders(bearer), timeout: 10_000, validateStatus: () => true,
      });
      status = r.status;
      const body = JSON.stringify(r.data || '').toLowerCase();
      ok = (r.status >= 200 && r.status < 300) || body.includes('already') || body.includes('closed');
      // 2) Best-effort custom resolution note (separate; never affects close result).
      try {
        await axios.patch(buildEventByIdUrl(baseUrl, id), buildEventUpdateBody({ note }), {
          headers: bmcHeaders(bearer), timeout: 10_000, validateStatus: () => true,
        });
      } catch { /* best-effort */ }
    } catch (e) { status = -1; ok = false; }
    results.push({ id, ok, status });
  }
  return res.json({ ok: true, closed: results.filter((r) => r.ok).length, results });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix backend test -- __tests__/situations-routes.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/situations.js backend/__tests__/situations-routes.test.mjs
git commit -m "feat(situations): close-events route (stateless auto-close by source_identifier)"
```

---

### Task 7: `GET /api/situations/open-events`

**Files:**
- Modify: `backend/routes/situations.js`
- Test: `backend/__tests__/situations-routes.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `situations-routes.test.mjs`:

```js
describe('GET /api/situations/open-events', () => {
  it('returns the summarized open OTEL_TRACE_ANOMALY events', async () => {
    vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      if (url.endsWith('/ims/api/v1/access_keys/login')) return { status: 200, data: { json_web_token: 'jwt' } };
      if (url.endsWith('/events/msearch')) return { status: 200, data: { hits: { hits: [
        { _id: 'eps.1', _source: { service_name: 'redis-manual', msg: 'm', severity: 'CRITICAL', source_identifier: 'helix-otel-trace:abc', creation_time: 1 } },
      ] } } };
      return { status: 404, data: {} };
    });
    const res = await request(makeApp()).get('/api/situations/open-events');
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([
      { id: 'eps.1', service: 'redis-manual', msg: 'm', severity: 'CRITICAL', sourceIdentifier: 'helix-otel-trace:abc', creationTime: 1 },
    ]);
  });

  it('412s with no API key', async () => {
    delete process.env.HELIX_API_KEY;
    const res = await request(makeApp()).get('/api/situations/open-events');
    expect(res.status).toBe(412);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix backend test -- __tests__/situations-routes.test.mjs -t "open-events"`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Implement the route**

In `situations.js` `register`, after the close-events handler:

```js
// List the configurator's open OTEL_TRACE_ANOMALY events for the "Sent events"
// panel. Read-only; viewer-independent (queries Helix, not the local store).
app.get('/api/situations/open-events', async (req, res) => {
  const apiKey = (process.env.HELIX_API_KEY || '').trim();
  if (!apiKey) return res.status(412).json({ error: 'HELIX_API_KEY not configured — set it on the Settings page first.' });
  const baseUrl = resolveEventsBaseUrl();
  if (!baseUrl) return res.status(412).json({ error: 'No events endpoint configured — set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });

  let bearer;
  try { bearer = await getHelixBearerToken(baseUrl, apiKey); }
  catch (e) { return res.status(502).json({ error: 'Helix authentication failed', details: e.message, upstream: e.upstream }); }

  try {
    const sr = await axios.post(buildEventSearchUrl(baseUrl), buildEventSearchBody({ all: true }), {
      headers: bmcHeaders(bearer), timeout: 15_000, validateStatus: () => true,
    });
    if (sr.status < 200 || sr.status >= 300) {
      return res.status(502).json({ error: `Helix event search returned ${sr.status}`, upstream: sr.data });
    }
    return res.json({ ok: true, events: summarizeOpenEvents(sr.data) });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach Helix event search API', details: e.message });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix backend test -- __tests__/situations-routes.test.mjs`
Expected: PASS (all route tests).

- [ ] **Step 5: Run the full backend suite**

Run: `npm --prefix backend test`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add backend/routes/situations.js backend/__tests__/situations-routes.test.mjs
git commit -m "feat(situations): open-events route for the sent-events panel"
```

---

### Task 8: Frontend — "Sent events" panel in the Helix settings drawer

**Files:**
- Modify: `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx`

This is the durable, viewer-independent surface. No component test infra exists in `frontend/`; verify via the preview server (Step 4).

- [ ] **Step 1: Add state + load/close handlers**

Near the existing `provision` state, add (match the file's existing fetch/error idioms):

```tsx
type OpenEvent = { id: string; service: string; msg: string; severity: string; sourceIdentifier: string; creationTime: number | null };
const [openEvents, setOpenEvents] = useState<OpenEvent[] | null>(null);
const [openEventsMsg, setOpenEventsMsg] = useState('');
const [closing, setClosing] = useState(false);

const loadOpenEvents = async () => {
  setOpenEventsMsg('Loading…');
  try {
    const res = await fetch('/api/situations/open-events');
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setOpenEvents(data.events || []); setOpenEventsMsg(''); }
    else { setOpenEvents([]); setOpenEventsMsg(data.error || `Failed (${res.status})`); }
  } catch (e: any) { setOpenEvents([]); setOpenEventsMsg(e.message || 'Network error'); }
};

const closeEvents = async (body: { traceId?: string; all?: boolean; eventIds?: string[] }) => {
  setClosing(true);
  try {
    const res = await fetch('/api/situations/close-events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setOpenEventsMsg(res.ok ? `Closed ${data.closed ?? 0} event(s).` : (data.error || `Failed (${res.status})`));
  } catch (e: any) { setOpenEventsMsg(e.message || 'Network error'); }
  finally { setClosing(false); await loadOpenEvents(); }
};
```

- [ ] **Step 2: Render the panel**

Below the existing Provision buttons section, add a panel (match the drawer's Tailwind classes — copy the surrounding section's wrapper/heading classes verbatim):

```tsx
<div className="mt-6">
  <div className="flex items-center justify-between">
    <h3 className="text-sm font-semibold text-gray-200">Sent events (open in Helix)</h3>
    <div className="flex gap-2">
      <button className="text-xs text-blue-400 hover:underline" onClick={loadOpenEvents} disabled={closing}>Refresh</button>
      {openEvents && openEvents.length > 0 && (
        <button className="text-xs text-red-400 hover:underline" onClick={() => closeEvents({ all: true })} disabled={closing}>Close all</button>
      )}
    </div>
  </div>
  {openEventsMsg && <p className="text-xs text-gray-400 mt-1">{openEventsMsg}</p>}
  {openEvents && openEvents.length === 0 && !openEventsMsg && <p className="text-xs text-gray-500 mt-1">No open configurator events.</p>}
  <ul className="mt-2 space-y-1">
    {(openEvents || []).map((e) => (
      <li key={e.id} className="flex items-center justify-between gap-2 text-xs bg-gray-900 rounded px-2 py-1">
        <span className="truncate"><span className="text-gray-400">{e.severity}</span> {e.service} — {e.msg}</span>
        <button className="text-red-400 hover:underline shrink-0" onClick={() => closeEvents({ eventIds: [e.id] })} disabled={closing}>Close</button>
      </li>
    ))}
  </ul>
</div>
```

Trigger an initial `loadOpenEvents()` when the drawer opens (add to the existing open effect, or a `useEffect(() => { loadOpenEvents(); }, [])` if the drawer mounts on open).

- [ ] **Step 3: Type-check + lint**

Run: `npm --prefix frontend run lint`
Expected: no new errors (warnings ratchet is acceptable per project policy).
Also: `npm --prefix frontend run build` (or `tsc -p frontend`) — expected: clean compile.

- [ ] **Step 4: Verify in the preview**

Start the preview server (per the project's preview workflow), open the Helix settings drawer, confirm the "Sent events" panel renders, lists open events when a tenant is configured (or the empty/no-key state otherwise), and that Close / Close all call the endpoints (check the network panel). Screenshot for the PR.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx
git commit -m "feat(situations): sent-events panel with per-event + close-all resolve"
```

---

### Task 9: Frontend — Resolve button in the trace drawer

**Files:**
- Modify: `frontend/src/components/otel-data/trace-detail/TraceDetailDrawer.tsx`

- [ ] **Step 1: Add a resolve handler**

Near `sendToAiops` (~L92), add:

```tsx
const [resolveState, setResolveState] = useState<'idle' | 'resolving' | 'done' | 'error'>('idle');
const [resolveMsg, setResolveMsg] = useState('');

const resolveTrace = async () => {
  setResolveState('resolving'); setResolveMsg('');
  try {
    const res = await fetch('/api/situations/close-events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ traceId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setResolveState('done'); setResolveMsg(`Closed ${data.closed ?? 0} event(s); Situation will resolve shortly.`); }
    else { setResolveState('error'); setResolveMsg(data.error || `Failed (${res.status})`); }
  } catch (e: any) { setResolveState('error'); setResolveMsg(e.message || 'Network error'); }
};
```

- [ ] **Step 2: Render the Resolve button when the trace has been sent**

In the header action area next to the "Send to AIOps" button (~L141), add — shown only once `priorSend` exists (the trace has been sent this session):

```tsx
{priorSend && (
  <button
    onClick={resolveTrace}
    disabled={resolveState === 'resolving'}
    className="px-3 py-1.5 text-sm rounded border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-50"
    title="Close this trace's Helix event(s) so the Situation auto-resolves"
  >
    {resolveState === 'resolving' ? 'Resolving…' : 'Resolve'}
  </button>
)}
```

Render `resolveMsg` near the existing `sendMsg` display.

- [ ] **Step 3: Type-check + lint**

Run: `npm --prefix frontend run lint` and a `build`/`tsc` — expected: clean (warnings ratchet OK).

- [ ] **Step 4: Verify in the preview**

In the preview, open a sent trace, confirm the Resolve button appears after a send and that clicking it POSTs `close-events { traceId }` (network panel) and shows the result message. Screenshot for the PR.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/otel-data/trace-detail/TraceDetailDrawer.tsx
git commit -m "feat(situations): Resolve button on the trace drawer"
```

---

### Task 10: Live verification + memory/spec update

**Files:**
- Modify: `docs/superpowers/specs/2026-06-18-situation-autoclose-event-notes-design.md` (status → verified)
- Modify: memory `project_situation_page_configurator_addressable_fields.md` (record live results) + MEMORY.md if needed

This task confirms the three verify-live risks against a live tenant (e.g. `demotenant-neodev4` / a configured tenant) and adjusts the isolated builders if reality differs. **Do not finalize/merge before this passes.**

- [ ] **Step 1: Confirm the msearch response shape (risk #1)**

With a configured tenant, hit `GET /api/situations/open-events` and inspect the JSON. Confirm `summarizeOpenEvents` populates `id` and `service`/`msg`/`severity` (not empty). If the hit id lives elsewhere or `_source` slot names differ, adjust `extractSearchEventIds` / `summarizeOpenEvents` (one spot each) + their unit tests.

- [ ] **Step 2: Confirm created-id capture (risk #2)**

Send a trace (`convert-trace`), inspect the response `eventIds` and `noteWritten`. If `eventIds` is empty, capture the real POST `/events` response shape and adjust `extractCreatedEventIds` + its test. (Triage note is best-effort, so an empty result degrades gracefully but should be fixed.)

- [ ] **Step 3: Confirm the close + note PATCH (risk #3)**

Resolve the sent trace (`close-events { traceId }`). Confirm `closed >= 1` and that the event is `CLOSED` in Helix with a Logs & Notes entry. If the `notes` slot is rejected by the update PATCH, the status-only close still works — keep `buildEventUpdateBody`'s `notes` only if accepted; otherwise rely on the auto-note and drop the best-effort note call.

- [ ] **Step 4: End-to-end Situation close**

On the live tenant: send a trace → confirm the Situation forms → Resolve → confirm the **Situation transitions to Closed** within the window (~10–15 min). Note: docs guarantee this for the policy-ALARM path; for a pure-ML Situation, record the observed behavior (it may need the correlation policy path). Capture the result in the spec + memory.

- [ ] **Step 5: Update spec status + memory, final full-suite run**

Run: `npm --prefix backend test` (expected: all pass). Update the spec `Status:` line and append a "Live verification" section with the confirmed shapes + Situation-close behavior. Update `project_situation_page_configurator_addressable_fields` memory with the live outcome.

```bash
git add docs/superpowers/specs/2026-06-18-situation-autoclose-event-notes-design.md
git commit -m "docs(situations): record live verification of auto-close + event-notes"
```

---

## Self-Review

**Spec coverage:**
- Stateless resolution by `source_identifier` → Tasks 1, 6. ✓
- Triage note at send → Tasks 4, 5. ✓
- Resolution note + Status→Closed on resolve → Tasks 4, 6. ✓
- Viewer-independent "Sent events" panel → Tasks 3, 7, 8. ✓
- Trace-drawer Resolve convenience → Task 9. ✓
- Non-destructive (scoped to `class:OTEL_TRACE_ANOMALY`) → search query in Task 1; close route in Task 6. ✓
- Verify-live items → Task 10. ✓
- Out-of-scope (time-based policy, tags, similar-situations) → correctly omitted. ✓

**Type/name consistency:** `buildEventSearchBody({ traceId, all })`, `extractSearchEventIds`, `extractCreatedEventIds`, `summarizeOpenEvents`, `buildEventUpdateBody({ status, note })`, `buildEventByIdUrl`, `buildEventSearchUrl`, `buildTriageNoteForTrace` — names used identically in payloads, route, and tests. `close-events` accepts `{ traceId | all | eventIds }` consistently across route (Task 6) and both frontend callers (Tasks 8, 9). The frontend `OpenEvent` fields match `summarizeOpenEvents`'s output keys.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The three "verify-live" items are explicit, isolated, and have a concrete confirmation procedure in Task 10 (not placeholders).
