# OTEL_TRACE_ANOMALY class + policy recreate — Implementation Plan

> ⛔ **SUPERSEDED.** This plan's destructive recreate endpoint + UI button were built then
> reverted (user rejected destructive teardown in the configurator; BMC also 409s deleting a
> class with open events). The slice shipped instead as a non-destructive fix to the existing
> `provision-class` button — see branch `feat/situations-class-slot-update`. Task 1's live
> discovery (policy addressing, class-delete-blocked-by-events) is the still-useful part.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one user-triggered `POST /api/situations/reprovision` endpoint (+ a danger-styled UI button) that deletes & recreates the `OTEL_TRACE_ANOMALY` event class and its correlation policy, so the live class gains all 21 slots and the policy gains the new title.

**Architecture:** Pure decision logic (response classifiers + URL builders) lives in `backend/routes/situations-payloads.js` and is unit-tested; the network orchestration lives in `backend/routes/situations.js` and is verified live (mirrors the existing `provision-class` convention). One new React button reuses the drawer's `provision()`-style state pattern and renders the returned per-step trail.

**Tech Stack:** Node/Express (CommonJS) backend, axios, vitest; React + TypeScript + Tailwind frontend; Docker Compose for the live container.

**Spec:** `docs/superpowers/specs/2026-05-29-otel-class-recreate-design.md`

---

## Task 1 findings (discovery complete — approach revised)

Live read-only probes changed the policy approach:
- **Policies are addressable only by internal id.** `GET /event_policies/{name}?idType=name` → 400 `"Invalid id format"`; the collection has no GET (500 wrapping 405). `POST /event_policies/search` with body `{}` → 200 `{totalRecords, policies:[{id,name,types,…}]}` (only `{}` is a valid body — the schema is `additionalProperties:false`). `GET /event_policies/{id}` → 200 `{policy:{…}}`.
- **Our correlation policy does NOT currently exist** — search returns only the 4 built-in `Template for…` policies. So the policy half is a clean create now; the delete branch is there for when a stale policy exists.
- **Class confirmed:** `GET …/classes/OTEL_TRACE_ANOMALY?idType=name` → id `0376ea69-5af8-11f1-a087-5b3c44d5e1b3`; delete by id.
- **Revised policy flow:** search (`{}`) → find by name → delete by id (if found) → POST. Replaces the original delete-by-name guess.

## File Structure

- **Modify** `backend/routes/situations-payloads.js` — add pure helpers `classifyDeleteResponse`, `classifyCreateResponse`, `buildClassByNameUrl`, `buildClassDeleteUrl`, `buildPolicySearchUrl`, `buildPolicyDeleteUrl` (by **id**), `findPolicyIdByName`; export them. Refactor `provision-class`'s inline create-conflict check onto `classifyCreateResponse` (DRY).
- **Modify** `backend/__tests__/situations-payloads.test.mjs` — unit tests for the five new helpers.
- **Modify** `backend/routes/situations.js` — import the new helpers + class/policy builders; add the `reprovision` handler; switch the existing `provision-class` conflict check to `classifyCreateResponse`.
- **Modify** `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx` — add the danger "Recreate class + policy" button, `recreate()` handler, and step-trail message.

---

## Task 1: Read-only live discovery of delete shapes

Pre-implementation de-risking. **Read-only** (IMS login + GETs only) — confirms the policy GET-by-name shape and the policy `id` (fallback delete key), and reconfirms the class `id`. No mutations.

**Files:**
- Create (temporary, deleted at end): `data/_discover.mjs` (the `data/` dir is mounted into the container at `/app/data`).

- [ ] **Step 1: Write the read-only discovery probe**

Create `data/_discover.mjs`:

```js
// READ-ONLY: IMS login + GETs only. No POST/PUT/DELETE of resources.
const endpoint = (process.env.HELIX_EVENTS_ENDPOINT || '').trim()
  || new URL((process.env.HELIX_ENDPOINT || '').trim()).origin;
const apiKey = (process.env.HELIX_API_KEY || '').trim();
const [, accessKey, accessSecretKey] = apiKey.split('::');
const h = (b) => ({ 'Content-Type': 'application/json', Accept: 'application/json', ...(b ? { Authorization: `Bearer ${b}` } : {}) });

const login = await fetch(`${endpoint}/ims/api/v1/access_keys/login`, {
  method: 'POST', headers: h(),
  body: JSON.stringify({ access_key: accessKey, access_secret_key: accessSecretKey }),
});
const jwt = (await login.json()).json_web_token;
console.log('login:', login.status, '| jwt?', !!jwt);

const classUrl = `${endpoint}/events-service/api/v1.0/events/classes/OTEL_TRACE_ANOMALY?idType=name`;
const cr = await fetch(classUrl, { headers: h(jwt) });
const cd = await cr.json();
console.log('GET class by name:', cr.status, '| id:', (cd.eventClass || cd).id);

const polUrl = `${endpoint}/events-service/api/v1.0/event_policies/HelixConfigurator-OTel-Trace-Anomaly?idType=name`;
const pr = await fetch(polUrl, { headers: h(jwt) });
const pbody = await pr.text();
console.log('GET policy by name:', pr.status);
console.log('policy body (first 500):', pbody.slice(0, 500));
```

- [ ] **Step 2: Run it in the container**

Run: `docker exec helix-configurator node /app/data/_discover.mjs`
Expected: `login: 200 | jwt? true`; `GET class by name: 200 | id: 0376ea69-...`. Record the **policy GET status**: if `200`, note the policy `id` from the body (fallback delete key) and that name-addressing works; if `400/404/500`, note it — the policy delete will rely on name+idType and we confirm it live in Task 5.

- [ ] **Step 3: Remove the probe**

Run: `rm -f data/_discover.mjs`
Expected: gone (don't leave artifacts in the mounted `data/` dir).

- [ ] **Step 4: Commit** (nothing to commit if probe removed — skip). Record findings in the Task 5 verification notes instead.

---

## Task 2: Pure helpers + unit tests (TDD)

**Files:**
- Modify: `backend/routes/situations-payloads.js`
- Test: `backend/__tests__/situations-payloads.test.mjs`

- [ ] **Step 1: Write failing tests for `classifyDeleteResponse`**

Append to `backend/__tests__/situations-payloads.test.mjs`. The file already imports `describe/it/expect` from vitest and defines `require` via `createRequire` at the top — do NOT re-import or redeclare them. Just pull the new helpers off the existing `require` and add the describe blocks:

```js
const {
  classifyDeleteResponse, classifyCreateResponse,
  buildClassByNameUrl, buildClassDeleteUrl,
  buildPolicySearchUrl, buildPolicyDeleteUrl, findPolicyIdByName,
} = require('../routes/situations-payloads');

describe('classifyDeleteResponse', () => {
  it('treats 2xx as deleted', () => {
    expect(classifyDeleteResponse({ status: 200, body: {} })).toBe('deleted');
    expect(classifyDeleteResponse({ status: 204, body: '' })).toBe('deleted');
  });
  it('treats 404 / not-found bodies as already-gone (idempotent)', () => {
    expect(classifyDeleteResponse({ status: 404, body: {} })).toBe('already-gone');
    expect(classifyDeleteResponse({ status: 400, body: { message: 'Event class does not exist' } })).toBe('already-gone');
    expect(classifyDeleteResponse({ status: 400, body: 'Policy not found' })).toBe('already-gone');
  });
  it('treats other 4xx/5xx as failed', () => {
    expect(classifyDeleteResponse({ status: 500, body: { message: 'class has active events' } })).toBe('failed');
    expect(classifyDeleteResponse({ status: 403, body: {} })).toBe('failed');
  });
});

describe('classifyCreateResponse', () => {
  it('treats 2xx as created', () => {
    expect(classifyCreateResponse({ status: 201, body: {} })).toBe('created');
  });
  it('treats 409 / already-exists / duplicate as already-exists', () => {
    expect(classifyCreateResponse({ status: 409, body: {} })).toBe('already-exists');
    expect(classifyCreateResponse({ status: 500, body: { message: 'EVCLASS_ALREADY_EXIST' } })).toBe('already-exists');
    expect(classifyCreateResponse({ status: 400, body: 'POLICY_ALREADY_EXIST' })).toBe('already-exists');
    expect(classifyCreateResponse({ status: 400, body: { message: 'duplicate key' } })).toBe('already-exists');
  });
  it('treats other errors as failed', () => {
    expect(classifyCreateResponse({ status: 400, body: { message: 'validation.request.accept.invalid' } })).toBe('failed');
  });
});

describe('URL builders', () => {
  const base = 'https://t.onbmc.com';
  it('class-by-name GET uses idType=name', () => {
    expect(buildClassByNameUrl(base, 'OTEL_TRACE_ANOMALY'))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/events/classes/OTEL_TRACE_ANOMALY?idType=name');
  });
  it('class delete addresses by UUID (default idType)', () => {
    expect(buildClassDeleteUrl(base, '0376ea69-5af8-11f1-a087-5b3c44d5e1b3'))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/events/classes/0376ea69-5af8-11f1-a087-5b3c44d5e1b3');
  });
  it('policy search is the collection /search sub-path', () => {
    expect(buildPolicySearchUrl(base))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/event_policies/search');
  });
  it('policy delete addresses by internal id (no idType)', () => {
    expect(buildPolicyDeleteUrl(base, '7ef7d48c-4333-11f1-a087-cfcbf9d5d094'))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/event_policies/7ef7d48c-4333-11f1-a087-cfcbf9d5d094');
  });
  it('strips a trailing slash from base', () => {
    expect(buildClassDeleteUrl('https://t.onbmc.com/', 'abc'))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/events/classes/abc');
  });
});

describe('findPolicyIdByName', () => {
  const data = { totalRecords: 2, policies: [
    { id: 'aaa', name: 'Template for X' },
    { id: 'bbb', name: 'HelixConfigurator-OTel-Trace-Anomaly' },
  ] };
  it('returns the id of the exact-name match', () => {
    expect(findPolicyIdByName(data, 'HelixConfigurator-OTel-Trace-Anomaly')).toBe('bbb');
  });
  it('returns null when no policy matches', () => {
    expect(findPolicyIdByName(data, 'Nope')).toBe(null);
  });
  it('returns null for an empty/missing list', () => {
    expect(findPolicyIdByName({}, 'x')).toBe(null);
    expect(findPolicyIdByName({ policies: [] }, 'x')).toBe(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs`
Expected: FAIL — `classifyDeleteResponse is not a function` (helpers not exported yet).

- [ ] **Step 3: Implement the helpers**

In `backend/routes/situations-payloads.js`, add before the `module.exports` block:

```js
// Classify an events-service DELETE response. 2xx → deleted; a 404 or a body that
// says the resource is already gone → already-gone (idempotent recreate); anything
// else (auth, "class has events", 5xx) → failed. body may be object or string.
function classifyDeleteResponse({ status, body }) {
  if (status >= 200 && status < 300) return 'deleted';
  const text = JSON.stringify(body == null ? '' : body).toLowerCase();
  if (status === 404
    || text.includes('not found')
    || text.includes('does not exist')
    || text.includes('no policy')
    || text.includes('no event class')) {
    return 'already-gone';
  }
  return 'failed';
}

// Classify an events-service POST (create) response. 2xx → created; a 409 or a body
// signalling a name collision → already-exists (soft success); else failed. Mirrors
// the live-validated markers: EVCLASS_ALREADY_EXIST (class), POLICY_ALREADY_EXIST
// (policy), and generic "already exist"/"duplicate".
function classifyCreateResponse({ status, body }) {
  if (status >= 200 && status < 300) return 'created';
  const text = JSON.stringify(body == null ? '' : body).toLowerCase();
  if (status === 409 || text.includes('already exist') || text.includes('duplicate')) {
    return 'already-exists';
  }
  return 'failed';
}

const EVENTS_BASE = 'events-service/api/v1.0';
const trimBase = (base) => String(base).replace(/\/+$/, '');

// GET/resolve a class by its name (the path is parsed as a UUID unless idType=name).
function buildClassByNameUrl(base, className) {
  return `${trimBase(base)}/${EVENTS_BASE}/events/classes/${encodeURIComponent(className)}?idType=name`;
}

// DELETE a class by UUID. UUID is the default idType, so no idType param — this
// sidesteps the "Invalid UUID string" failure that breaks name-addressed mutation.
function buildClassDeleteUrl(base, uuid) {
  return `${trimBase(base)}/${EVENTS_BASE}/events/classes/${encodeURIComponent(uuid)}`;
}

// Policies are addressable ONLY by internal id (name-addressing 400s "Invalid id
// format"; the collection has no GET). POST {} to this search endpoint to list them.
function buildPolicySearchUrl(base) {
  return `${trimBase(base)}/${EVENTS_BASE}/event_policies/search`;
}

// DELETE a policy by its internal id (from the search results).
function buildPolicyDeleteUrl(base, id) {
  return `${trimBase(base)}/${EVENTS_BASE}/event_policies/${encodeURIComponent(id)}`;
}

// Find a policy's id by exact name in a search response ({policies:[{id,name}]}).
// Returns null when absent. Pure — no network.
function findPolicyIdByName(searchData, name) {
  const list = (searchData && searchData.policies) || [];
  const hit = list.find((p) => p && p.name === name);
  return hit ? (hit.id || null) : null;
}
```

Then extend `module.exports` to include them:

```js
module.exports = {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildClassUpdateBody, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
  deriveProbableCause, blastRadius, anomalyFactor, priorityForTrace,
  buildHelixTraceUrlFromSummary,
  classifyDeleteResponse, classifyCreateResponse,
  buildClassByNameUrl, buildClassDeleteUrl,
  buildPolicySearchUrl, buildPolicyDeleteUrl, findPolicyIdByName,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run __tests__/situations-payloads.test.mjs`
Expected: PASS (all new describe blocks green; previously-passing tests unaffected).

- [ ] **Step 5: Run the full suite**

Run: `cd backend && npm test`
Expected: PASS — 159 prior + new tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/situations-payloads.js backend/__tests__/situations-payloads.test.mjs
git commit -m "feat(situations): pure delete/create response classifiers + delete URL builders"
```

---

## Task 3: Wire the `reprovision` orchestration handler

Network glue. Not unit-tested (consistent with the existing `provision-class` handler) — every decision delegates to the Task 2 classifiers, which ARE tested; the wired endpoint is verified live in Task 5. Also DRY-refactor the existing `provision-class` conflict check onto `classifyCreateResponse`.

**Files:**
- Modify: `backend/routes/situations.js`

- [ ] **Step 1: Extend the payloads import**

In `backend/routes/situations.js`, replace the existing destructured `require('./situations-payloads')` (lines 8-11) with:

```js
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildClassUpdateBody, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
  classifyDeleteResponse, classifyCreateResponse,
  buildClassByNameUrl, buildClassDeleteUrl,
  buildPolicySearchUrl, buildPolicyDeleteUrl, findPolicyIdByName,
} = require('./situations-payloads');
```

- [ ] **Step 2: DRY the existing provision-class conflict check**

In `provision-class`, replace the inline conflict detection (currently `const body = JSON.stringify(...).toLowerCase(); if (response.status === 409 || body.includes('already exist') || body.includes('duplicate'))`) with the shared classifier:

```js
      if (classifyCreateResponse({ status: response.status, body: response.data }) === 'already-exists') {
```

Leave the rest of that branch (the `?idType=name` PUT update + graceful degrade) unchanged.

- [ ] **Step 3: Run the full suite to confirm no regression**

Run: `cd backend && npm test`
Expected: PASS — the refactor is behavior-preserving; 0 failures.

- [ ] **Step 4: Add the `reprovision` handler**

In `backend/routes/situations.js`, inside `register(app, { otelStore })`, add after the `provision-correlation-policy` handler (before the closing `}` of `register`):

```js
  // Destructively recreate the OTEL_TRACE_ANOMALY class AND its correlation policy.
  // Needed when the class already exists but is missing slots (the update API rejects
  // slot additions) and/or the policy title is stale (POST-only provisioning never
  // updates an existing policy). Order matters: the policy selector references the
  // class, so delete policy -> delete class -> recreate class -> recreate policy.
  // Resolves the class UUID by name at runtime (never hardcoded) so it is tenant-
  // agnostic. Returns a per-step trail; stops before recreate if a delete hard-fails.
  app.post('/api/situations/reprovision', async (req, res) => {
    const apiKey = (process.env.HELIX_API_KEY || '').trim();
    if (!apiKey) return res.status(412).json({ error: 'HELIX_API_KEY not configured — set it on the Settings page first.' });
    const baseUrl = resolveEventsBaseUrl();
    if (!baseUrl) return res.status(412).json({ error: 'No events endpoint configured — set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });

    let bearer;
    try { bearer = await getHelixBearerToken(baseUrl, apiKey); }
    catch (e) { return res.status(502).json({ error: 'Helix authentication failed', details: e.message, upstream: e.upstream }); }

    const headers = bmcHeaders(bearer);
    const opts = { headers, timeout: 15_000, validateStatus: () => true };
    const steps = [];
    const push = (step, status, ok, soft, upstream) => steps.push({ step, status, ok, soft, upstream });

    // 1. Find + delete the correlation policy. Policies are addressable only by
    //    internal id, so search (POST {}) -> match by name -> DELETE by id. If
    //    absent (our policy doesn't exist yet), skip straight to recreate.
    {
      const sr = await axios.post(buildPolicySearchUrl(baseUrl), {}, opts);
      if (sr.status < 200 || sr.status >= 300) {
        push('search-policy', sr.status, false, false, sr.data);
        return res.status(502).json({ ok: false, error: 'Failed to list event policies', steps });
      }
      const policyId = findPolicyIdByName(sr.data, CORRELATION_POLICY_NAME);
      push('search-policy', sr.status, true, !policyId, { found: !!policyId, id: policyId });
      if (policyId) {
        const r = await axios.delete(buildPolicyDeleteUrl(baseUrl, policyId), opts);
        const cls = classifyDeleteResponse({ status: r.status, body: r.data });
        push('delete-policy', r.status, cls !== 'failed', cls === 'already-gone', r.data);
        if (cls === 'failed') return res.status(502).json({ ok: false, error: 'Failed to delete correlation policy', steps });
      }
    }

    // 2. Resolve the class UUID by name (404 => class absent, skip the delete).
    let classId = null;
    {
      const r = await axios.get(buildClassByNameUrl(baseUrl, OTEL_TRACE_ANOMALY_CLASS), opts);
      if (r.status >= 200 && r.status < 300) {
        classId = ((r.data && (r.data.eventClass || r.data)) || {}).id || null;
        push('resolve-class', r.status, true, false, { id: classId });
      } else if (r.status === 404) {
        push('resolve-class', r.status, true, true, r.data);
      } else {
        push('resolve-class', r.status, false, false, r.data);
        return res.status(502).json({ ok: false, error: 'Failed to resolve event class', steps });
      }
    }

    // 3. Delete the class by UUID (skipped if it was absent).
    if (classId) {
      const r = await axios.delete(buildClassDeleteUrl(baseUrl, classId), opts);
      const cls = classifyDeleteResponse({ status: r.status, body: r.data });
      push('delete-class', r.status, cls !== 'failed', cls === 'already-gone', r.data);
      if (cls === 'failed') return res.status(502).json({ ok: false, error: 'Failed to delete event class (it may have events that block deletion)', steps });
    }

    // 4. Recreate the class with the full slot set.
    {
      const r = await axios.post(`${baseUrl}/events-service/api/v1.0/events/classes`, buildClassDefinition(), opts);
      const cls = classifyCreateResponse({ status: r.status, body: r.data });
      push('create-class', r.status, cls !== 'failed', cls === 'already-exists', r.data);
      if (cls === 'failed') return res.status(502).json({ ok: false, error: 'Failed to create event class', steps });
    }

    // 5. Recreate the correlation policy with the new title.
    {
      const r = await axios.post(`${baseUrl}/events-service/api/v1.0/event_policies`, buildCorrelationPolicy(), opts);
      const cls = classifyCreateResponse({ status: r.status, body: r.data });
      push('create-policy', r.status, cls !== 'failed', cls === 'already-exists', r.data);
      if (cls === 'failed') return res.status(502).json({ ok: false, error: 'Failed to create correlation policy', steps });
    }

    return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, policyName: CORRELATION_POLICY_NAME, steps });
  });
```

- [ ] **Step 5: Sanity-check the route loads (no syntax/wiring errors)**

Run: `cd backend && node -e "require('./routes/situations').register({ post(){}, get(){} }, { otelStore: {} }); console.log('register OK')"`
Expected: prints `register OK` (module parses and `register` runs without throwing).

- [ ] **Step 6: Run the full suite**

Run: `cd backend && npm test`
Expected: PASS — 0 failures (handler adds no unit tests; nothing regressed).

- [ ] **Step 7: Commit**

```bash
git add backend/routes/situations.js
git commit -m "feat(situations): reprovision endpoint recreates class + policy (delete->recreate, ordered)"
```

---

## Task 4: UI — danger "Recreate class + policy" button

**Files:**
- Modify: `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx`

- [ ] **Step 1: Add reprovision state + handler**

In `HelixConnectionSettingsDrawer.tsx`, after the `policyMsg` state (line 53) add:

```tsx
  const [reproState, setReproState] = React.useState<ProvState>('idle');
  const [reproMsg, setReproMsg] = React.useState('');

  const recreate = async () => {
    setReproState('running'); setReproMsg('');
    try {
      const res = await fetch('/api/situations/reprovision', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json().catch(() => ({}));
      const trail = Array.isArray(data.steps)
        ? data.steps.map((s: any) => `${s.step}: ${s.ok ? (s.soft ? 'skipped' : 'ok') : 'FAILED'} (${s.status})`).join(' · ')
        : '';
      if (res.ok && data.ok) { setReproState('done'); setReproMsg(`Recreated class + policy. ${trail}`); }
      else { setReproState('error'); setReproMsg(`${data.error || `Request failed (${res.status})`}${trail ? ` — ${trail}` : ''}`); }
    } catch (e: any) { setReproState('error'); setReproMsg(e.message || 'Network error'); }
  };
```

- [ ] **Step 2: Add the danger button below the two provision buttons**

In the "AIOps Provisioning" block, immediately after the `policyMsg` line (line 201, `{policyMsg && <span ...>{policyMsg}</span>}`) and before the closing `</div>` of `flex flex-col gap-2`, add:

```tsx
              <div className="pt-3 mt-1 border-t border-gray-800">
                <button
                  type="button"
                  onClick={recreate}
                  disabled={reproState === 'running'}
                  className="inline-flex items-center justify-center gap-2 w-full px-3 py-2 rounded border border-danger text-danger-text hover:bg-danger/10 text-sm font-semibold disabled:opacity-60"
                >
                  {reproState === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
                  Recreate class + policy
                </button>
                <p className="text-tiny text-gray-500 mt-1">
                  Destructive: deletes &amp; rebuilds the OTEL_TRACE_ANOMALY class (drops its events) and the
                  correlation policy — registers all RCA slots and the latest policy title. Use when slots are
                  missing or the Situation title is stale.
                </p>
                {reproMsg && <span className={`block mt-1 text-tiny ${reproState === 'error' ? 'text-danger-text' : 'text-gray-400'}`}>{reproMsg}</span>}
              </div>
```

- [ ] **Step 3: Type-check / build the frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS — no type errors. (If the project lacks a `tsc` script, this direct invocation still type-checks.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx
git commit -m "feat(situations): danger 'Recreate class + policy' button + step trail in settings drawer"
```

---

## Task 5: Build + live verification + memory update

The moment of truth — the destructive deletes run here, behind the button the user clicks.

**Files:** none (operational), then memory.

- [ ] **Step 1: Rebuild the container with the new code**

Run: `docker compose up -d --build helix-configurator`
Expected: builds and restarts; `docker ps` shows `helix-configurator` Up.

- [ ] **Step 2: User clicks "Recreate class + policy"**

In the app's Helix Connection Settings drawer → AIOps Provisioning → click the red **Recreate class + policy** button. Expected: green "Recreated class + policy." message with a step trail like `delete-policy: ok (200) · resolve-class: ok (200) · delete-class: ok (200) · create-class: ok (200) · create-policy: ok (200)`.
- If `delete-class` shows `FAILED` with a "has events" message → BHOM blocks deleting a class with events; capture the upstream text and adapt (force param / delete-events-first) before continuing.
- If `delete-policy` shows `FAILED` → the policy-delete shape is wrong; use the `id` captured in Task 1 to switch `buildPolicyDeleteUrl` to by-id, rebuild, retry.

- [ ] **Step 3: Re-run the read-only slot probe**

Recreate `data/_probe.mjs` from the spec's verification section (IMS login + `GET class ?idType=name`, diff against the 21 expected slots), then:
Run: `docker exec helix-configurator node /app/data/_probe.mjs`
Expected: `EXPECTED slots present (21/21)` and `MISSING slots (0): (none)`. Then `rm -f data/_probe.mjs`.

- [ ] **Step 4: Confirm the policy title refreshed**

Add a `GET …/event_policies/HelixConfigurator-OTel-Trace-Anomaly?idType=name` to the probe (or reuse Task 1's discovery probe). Expected: the aggregate `newEvent.msg` leads with `%service_name%`/`%error_message%`/`%probable_cause_operation%`/`%component_count%` (the new title), not `%error_type%`/`%anomaly_factor%`.

- [ ] **Step 5: Send a fresh errored trace and verify in BHOM**

Generate a new errored trace (new trace_id — dedup is on `helix_trace_id`), use the trace detail drawer's "convert to event" action, then in BHOM confirm: the 8 RCA slots render as first-class fields (not "Unmapped Data"), and the correlated Situation's title names the probable cause. (Old events do not backfill — expected.)

- [ ] **Step 6: Update memory**

Update `project_situations_rca_slice_progress.md`: mark the recreate path implemented + live-verified (21/21 slots, policy title refreshed), record the confirmed delete verbs/URLs, and clear the stale "branch mix-up" / "resume in fresh session" warnings (already resolved — work is on `main`). Update the `MEMORY.md` pointer line.

- [ ] **Step 7: Finalize the branch**

Per `superpowers:finishing-a-development-branch`: decide merge/PR/cleanup with the user. (The earlier slice landed on `main`; this work may follow the same path or a short-lived branch — confirm with the user.)

---

## Self-Review

**Spec coverage:**
- New endpoint `POST /api/situations/reprovision` → Task 3. ✓
- Ordered orchestration (policy→class→class→policy), resolve-UUID-by-name → Task 3 steps 4. ✓
- Delete-semantics unknown + read-only discovery + stop-on-hard-fail → Task 1 + Task 3 (classifier + early returns) + Task 5 step 2 contingencies. ✓
- Soft/hard failure semantics → `classifyDeleteResponse`/`classifyCreateResponse` (Task 2) wired in Task 3. ✓
- Pure unit-tested helpers → Task 2. ✓
- UI danger button + step trail, no confirm dialog → Task 4. ✓
- Live verification (21/21 slots, policy title, fresh trace) → Task 5. ✓
- Tenant-agnostic by construction (no hardcoded UUID) → Task 3 resolves by name. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type/name consistency:** `classifyDeleteResponse`, `classifyCreateResponse`, `buildClassByNameUrl`, `buildClassDeleteUrl`, `buildPolicyDeleteUrl` are defined in Task 2 and used by the same names in Task 3. Step record shape `{ step, status, ok, soft, upstream }` (Task 3) matches the UI's `s.step`/`s.ok`/`s.soft`/`s.status` reads (Task 4). Response `{ ok, steps }` matches the UI's `data.ok`/`data.steps`. ✓
