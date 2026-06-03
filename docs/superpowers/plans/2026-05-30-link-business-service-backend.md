# Link OTel namespace → Business Service — Backend Plan (GUIDED-ONLY v1, Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the small backend for the guided "link OTel namespace → Business Service" flow — namespace detection, a guided-instructions builder, and `.env` key capture — on `feat/link-business-service`.

**Architecture:** Guided-only (the Task 0 spike proved the OTel ingest key cannot reach CMDB/service-model APIs — see spec Status). So the backend makes **no authenticated Helix calls**: it reads local telemetry (`otelStore`), builds a pure deep-link + checklist, and writes only its own `.env`. Three thin routes; everything testable with no network.

**Tech Stack:** Node + Express 5 (CommonJS), better-sqlite3, vitest + supertest. Tests are `.test.mjs` using `createRequire` for CJS modules.

> **Spec:** `docs/superpowers/specs/2026-05-30-link-business-service-design.md`. Plan 2 (frontend: `LinkBusinessService` component, wizard Step 5, dashboard card) follows once this backend is green. **`docs/` is gitignored** — the `git add` commands add only tracked `backend/**` files, never `docs/`. **No SPIKE-CONFIRM unknowns remain** (the spike resolved them).

---

## File Structure

| File | New? | Responsibility |
|---|---|---|
| `backend/otelStore.js` | Modify | Add `listNamespaces()` — distinct `service.namespace`s seen, with counts. |
| `backend/envFile.js` | Create | `upsertEnvVar(envPath, key, value)` — generalized `.env` line writer. |
| `backend/business-service-payloads.js` | Create | Pure: `buildBindInstructions(...)` (deep-link + checklist + dashboard URL) and `extractServiceKey(...)` (port of the frontend helper). No network. |
| `backend/routes/business-service.js` | Create | Thin handlers: `GET /namespaces`, `GET /bind-instructions`, `POST /persist-key`. No Helix calls, no auth. |
| `backend/index.js` | Modify | Register the new route module after the `/api` auth gate. |
| `backend/__tests__/otelStore-namespaces.test.mjs` | Create | `listNamespaces()` (seeded `:memory:` db). |
| `backend/__tests__/envFile.test.mjs` | Create | `upsertEnvVar` (temp file). |
| `backend/__tests__/business-service-payloads.test.mjs` | Create | `buildBindInstructions` + `extractServiceKey` (pure). |
| `backend/__tests__/business-service-routes.test.mjs` | Create | supertest, no network — fake `otelStore` + temp `.env`. |

---

## Task 1: `otelStore.listNamespaces()`

**Files:**
- Modify: `backend/otelStore.js` (add one method to the `OtelStore` class)
- Create: `backend/__tests__/otelStore-namespaces.test.mjs`

- [ ] **Step 1: Write the failing test**

`backend/__tests__/otelStore-namespaces.test.mjs`:
```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OtelStore } = require('../otelStore');

describe('OtelStore.listNamespaces', () => {
  let store;
  beforeEach(() => { vi.useFakeTimers(); store = new OtelStore({ dbPath: ':memory:' }); });
  afterEach(() => { store.stopMaintenance(); store.db.close(); vi.useRealTimers(); });

  // Seed traces directly — all columns are nullable except the trace_id PK.
  const seed = (trace_id, service_namespace, received_at) =>
    store.db.prepare(
      `INSERT INTO traces (trace_id, service_name, service_namespace, root_operation,
         start_time_ns, end_time_ns, duration_ms, span_count, has_error, received_at)
       VALUES (?, 'svc', ?, 'op', 1, 2, 1, 1, 0, ?)`,
    ).run(trace_id, service_namespace, received_at);

  it('returns distinct namespaces with trace counts, newest-seen first', () => {
    seed('t1', 'checkout', 100);
    seed('t2', 'payments', 300);
    seed('t3', 'checkout', 200);
    expect(store.listNamespaces()).toEqual([
      { namespace: 'payments', traceCount: 1, lastSeen: 300 },
      { namespace: 'checkout', traceCount: 2, lastSeen: 300 },
    ]);
  });
  it('reports null namespace for un-namespaced traces (caller maps to X_SOURCE)', () => {
    seed('t9', null, 50);
    expect(store.listNamespaces()).toEqual([{ namespace: null, traceCount: 1, lastSeen: 50 }]);
  });
  it('returns [] for an empty store', () => {
    expect(store.listNamespaces()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend && npx vitest run __tests__/otelStore-namespaces.test.mjs`
Expected: FAIL — `store.listNamespaces is not a function`.

- [ ] **Step 3: Implement the method**

In `backend/otelStore.js`, add to the `OtelStore` class (e.g. after `ingestLogs(...)`; keep `process.env` out of the store — the route maps null → X_SOURCE):
```js
  // Distinct OTel namespaces seen in stored traces, with trace counts and the
  // most-recent receipt time. Null namespace = un-namespaced traces (the route
  // maps those to X_SOURCE). Ordered newest-seen first for the Detect UI.
  listNamespaces() {
    const rows = this.db.prepare(`
      SELECT service_namespace AS namespace,
             COUNT(*)          AS traceCount,
             MAX(received_at)  AS lastSeen
      FROM traces
      GROUP BY service_namespace
      ORDER BY lastSeen DESC, namespace ASC
    `).all();
    return rows.map((r) => ({ namespace: r.namespace == null ? null : String(r.namespace), traceCount: r.traceCount, lastSeen: r.lastSeen }));
  }
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd backend && npx vitest run __tests__/otelStore-namespaces.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/otelStore.js backend/__tests__/otelStore-namespaces.test.mjs
git commit -m "feat(otelStore): listNamespaces() for the Detect step"
```

---

## Task 2: `envFile.js` — generalized `.env` writer

**Files:**
- Create: `backend/envFile.js`
- Create: `backend/__tests__/envFile.test.mjs`

> New code only. `auth.js`'s `persistUiPasswordToEnv` is left untouched (no tests; out of scope). A future cleanup can adopt this util.

- [ ] **Step 1: Write the failing test**

`backend/__tests__/envFile.test.mjs`:
```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { upsertEnvVar } = require('../envFile');

describe('upsertEnvVar', () => {
  let file;
  beforeEach(() => { file = path.join(os.tmpdir(), `env-test-${process.pid}-${Math.floor(performance.now())}`); });
  afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

  it('replaces an existing line, preserving the rest verbatim', () => {
    fs.writeFileSync(file, 'A=1\nBUSINESS_SERVICE_KEY=old\nB=2\n');
    upsertEnvVar(file, 'BUSINESS_SERVICE_KEY', 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nBUSINESS_SERVICE_KEY=new\nB=2\n');
  });
  it('appends when the key is absent', () => {
    fs.writeFileSync(file, 'A=1\n');
    upsertEnvVar(file, 'BUSINESS_SERVICE_KEY', 'k');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nBUSINESS_SERVICE_KEY=k');
  });
  it('creates the file when missing', () => {
    upsertEnvVar(file, 'BUSINESS_SERVICE_KEY', 'k');
    expect(fs.readFileSync(file, 'utf8')).toBe('BUSINESS_SERVICE_KEY=k');
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend && npx vitest run __tests__/envFile.test.mjs` — Expected: FAIL — `Cannot find module '../envFile'`.

- [ ] **Step 3: Implement `backend/envFile.js`**

```js
// Idempotently set KEY=value in a .env file: replace the existing line or append.
// Preserves all other lines verbatim. Creates the file if missing. Generalizes
// the pattern in auth.js so feature code can persist single env vars.
const fs = require('fs');

function upsertEnvVar(envPath, key, value) {
  let lines = [];
  try {
    lines = fs.readFileSync(envPath, 'utf8').split('\n');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // file absent → start fresh
  }
  let found = false;
  lines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

module.exports = { upsertEnvVar };
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd backend && npx vitest run __tests__/envFile.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/envFile.js backend/__tests__/envFile.test.mjs
git commit -m "feat(envFile): generalized upsertEnvVar for persisting single env vars"
```

---

## Task 3: Pure payloads — `business-service-payloads.js`

**Files:**
- Create: `backend/business-service-payloads.js`
- Create: `backend/__tests__/business-service-payloads.test.mjs`

- [ ] **Step 1: Write the failing test**

`backend/__tests__/business-service-payloads.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildBindInstructions, extractServiceKey } = require('../business-service-payloads');

describe('buildBindInstructions', () => {
  it('builds the AIOps link, namespace-overview dashboard URL, and a 5-step checklist', () => {
    const r = buildBindInstructions({ endpoint: 'https://acme.onbmc.com/', namespace: 'checkout', xSource: 'src', tenantId: 'T1' });
    expect(r.aiopsUrl).toBe('https://acme.onbmc.com/aiops/');
    const d = new URL(r.dashboardUrl);
    expect(d.pathname).toBe('/dashboards/d/OTelNamespaceOverview/otel-namespace-overview');
    expect(d.searchParams.get('var-OTelNamespace')).toBe('checkout');
    expect(d.searchParams.get('orgId')).toBe('T1');
    expect(r.steps).toHaveLength(5);
    expect(r.steps[2]).toContain('Default Blueprint for OTel Service');
    expect(r.steps[3]).toContain('checkout');
    expect(r.steps[4]).toContain('paste it back');
  });
  it('falls back to X_SOURCE when namespace is empty', () => {
    const r = buildBindInstructions({ endpoint: 'https://acme.onbmc.com', namespace: '', xSource: 'fallback-src' });
    expect(r.namespace).toBe('fallback-src');
    expect(new URL(r.dashboardUrl).searchParams.get('var-OTelNamespace')).toBe('fallback-src');
  });
  it('returns empty links (steps still present) for the placeholder/empty endpoint', () => {
    const r = buildBindInstructions({ endpoint: 'https://your-tenant.onbmc.com', namespace: 'shop' });
    expect(r.aiopsUrl).toBe('');
    expect(r.dashboardUrl).toBe('');
    expect(r.steps).toHaveLength(5);
  });
});

describe('extractServiceKey', () => {
  it('pulls the key from a full AIOps entity URL', () => {
    expect(extractServiceKey('https://acme.onbmc.com/aiops/#/entities/service/RE-9?type=key')).toBe('RE-9');
  });
  it('returns a bare key untouched and trims query/whitespace', () => {
    expect(extractServiceKey('  RE-9  ')).toBe('RE-9');
    expect(extractServiceKey('RE-9?type=key')).toBe('RE-9');
    expect(extractServiceKey('')).toBe('');
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend && npx vitest run __tests__/business-service-payloads.test.mjs` — Expected: FAIL — `Cannot find module '../business-service-payloads'`.

- [ ] **Step 3: Implement `backend/business-service-payloads.js`**

```js
// Pure builders for the guided "link to Business Service" flow. No network, no
// process.env — all inputs passed in, unit-tested in isolation.

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const isPlaceholder = (url) => /\/\/your-tenant\.onbmc\.com\b/i.test(url || '');

// Guided-bind payload: where to go in AIOps, the namespace-overview dashboard to
// eyeball the rollup afterward, and the exact click-path. The dashboard URL
// mirrors the existing OTelNamespaceOverview pattern (helix-link.js / App.tsx).
// Links are '' for the install-bundle placeholder so the UI hides them.
function buildBindInstructions({ endpoint, namespace, xSource = '', tenantId = '' }) {
  const base = stripSlash(endpoint);
  const real = !!base && !isPlaceholder(base);
  const ns = namespace || xSource || '';
  const aiopsUrl = real ? `${base}/aiops/` : '';
  let dashboardUrl = '';
  if (real && ns) {
    const params = new URLSearchParams({
      'var-BusinessService': ns,
      'var-OTelNamespace': ns,
      from: 'now-3h',
      to: 'now',
      timezone: 'browser',
    });
    if (tenantId) params.set('orgId', tenantId);
    dashboardUrl = `${base}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?${params.toString()}`;
  }
  const steps = [
    `Open BMC Helix AIOps${aiopsUrl ? ' (link below)' : ''} and go to Services.`,
    `Create a new Business Service, or open the one this app belongs under. (If X-Source "${xSource}" already auto-created a service, open that one.)`,
    `Edit the service → Add Dynamic content → "Default Blueprint for OTel Service".`,
    `Select the OpenTelemetry namespace "${ns}" (add others if needed), then Save.`,
    `Copy the Business Service's URL from your browser and paste it back here to capture its key.`,
  ];
  return { namespace: ns, steps, aiopsUrl, dashboardUrl };
}

// Accept a bare key, a URL fragment, or a full AIOps URL → the opaque key.
// Mirrors frontend extractServiceKey (otel-data/utils.ts) so paste-back is robust.
function extractServiceKey(input) {
  if (!input) return '';
  const trimmed = String(input).trim();
  const m = trimmed.match(/\/entities\/service\/([^/?#\s]+)/);
  if (m) return m[1];
  return trimmed.split(/[?#\s]/)[0];
}

module.exports = { buildBindInstructions, extractServiceKey };
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd backend && npx vitest run __tests__/business-service-payloads.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/business-service-payloads.js backend/__tests__/business-service-payloads.test.mjs
git commit -m "feat(business-service): pure guided-bind instructions + key extraction"
```

---

## Task 4: Routes `routes/business-service.js` + wire-up

**Files:**
- Create: `backend/routes/business-service.js`
- Create: `backend/__tests__/business-service-routes.test.mjs`
- Modify: `backend/index.js`

- [ ] **Step 1: Write the failing test**

`backend/__tests__/business-service-routes.test.mjs`:
```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import request from 'supertest';
import express from 'express';
const require = createRequire(import.meta.url);
const { register } = require('../routes/business-service');

const ENV = { HELIX_ENDPOINT: 'https://acme.onbmc.com', HELIX_API_KEY: 'T1::AK::SK', X_SOURCE: 'fallback-src' };

function makeApp({ otelStore = { listNamespaces: () => [] }, env = ENV, envPath } = {}) {
  const app = express();
  app.use(express.json());
  register(app, { otelStore, env, envPath });
  return app;
}

describe('GET /api/business-service/namespaces', () => {
  it('lists namespaces, mapping null → X_SOURCE with a fallback flag', async () => {
    const otelStore = { listNamespaces: () => [{ namespace: 'shop', traceCount: 3, lastSeen: 2 }, { namespace: null, traceCount: 1, lastSeen: 1 }] };
    const res = await request(makeApp({ otelStore })).get('/api/business-service/namespaces');
    expect(res.status).toBe(200);
    expect(res.body.namespaces).toEqual([
      { namespace: 'shop', traceCount: 3, lastSeen: 2, fallback: false },
      { namespace: 'fallback-src', traceCount: 1, lastSeen: 1, fallback: true },
    ]);
  });
});

describe('GET /api/business-service/bind-instructions', () => {
  it('returns the AIOps link, dashboard URL, and steps for the namespace', async () => {
    const res = await request(makeApp()).get('/api/business-service/bind-instructions?namespace=shop');
    expect(res.status).toBe(200);
    expect(res.body.aiopsUrl).toBe('https://acme.onbmc.com/aiops/');
    expect(res.body.namespace).toBe('shop');
    expect(new URL(res.body.dashboardUrl).searchParams.get('orgId')).toBe('T1');
    expect(res.body.steps).toHaveLength(5);
  });
});

describe('POST /api/business-service/persist-key', () => {
  let file;
  beforeEach(() => { file = path.join(os.tmpdir(), `bs-env-${process.pid}-${Math.floor(performance.now())}`); fs.writeFileSync(file, 'A=1\n'); });
  afterEach(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

  it('extracts the key from a pasted AIOps URL, writes .env + in-memory env (no restart)', async () => {
    const env = { ...ENV };
    const res = await request(makeApp({ env, envPath: file }))
      .post('/api/business-service/persist-key')
      .send({ key: 'https://acme.onbmc.com/aiops/#/entities/service/RE-7?type=key' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, businessServiceKey: 'RE-7' });
    expect(env.BUSINESS_SERVICE_KEY).toBe('RE-7');
    expect(fs.readFileSync(file, 'utf8')).toContain('BUSINESS_SERVICE_KEY=RE-7');
  });
  it('400 on an empty key', async () => {
    const res = await request(makeApp({ envPath: file })).post('/api/business-service/persist-key').send({ key: '' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend && npx vitest run __tests__/business-service-routes.test.mjs` — Expected: FAIL — `Cannot find module '../routes/business-service'`.

- [ ] **Step 3: Implement `backend/routes/business-service.js`**

```js
// Guided "link OTel namespace → Business Service" API. The OTel ingest key can't
// reach CMDB/service-model APIs (Task 0 spike), so this makes NO authenticated
// Helix calls — it reads local telemetry, builds a guided checklist + deep-links,
// and persists BUSINESS_SERVICE_KEY to its own .env. Collaborators injectable.
const path = require('path');
const { buildBindInstructions, extractServiceKey } = require('../business-service-payloads');
const { upsertEnvVar } = require('../envFile');

function register(app, {
  otelStore,
  env = process.env,
  envPath = path.join(__dirname, '..', '..', '.env'),
} = {}) {
  const tenantId = () => String((env.HELIX_API_KEY || '').split('::')[0] || '').trim();

  // OTel namespaces currently arriving (local otelStore). null → X_SOURCE.
  app.get('/api/business-service/namespaces', (req, res) => {
    const fallback = (env.X_SOURCE || '').trim();
    const namespaces = (otelStore.listNamespaces() || []).map((n) => (n.namespace
      ? { ...n, fallback: false }
      : { ...n, namespace: fallback, fallback: true }));
    res.json({ namespaces });
  });

  // Guided-bind checklist + deep-links (pure; no write).
  app.get('/api/business-service/bind-instructions', (req, res) => {
    res.json(buildBindInstructions({
      endpoint: env.HELIX_ENDPOINT || '',
      namespace: (req.query.namespace || '').toString(),
      xSource: env.X_SOURCE || '',
      tenantId: tenantId(),
    }));
  });

  // Capture: extract the key (tolerates a pasted AIOps URL), persist to .env AND
  // process.env so it applies with no restart (read per-request elsewhere).
  app.post('/api/business-service/persist-key', (req, res) => {
    const key = extractServiceKey(((req.body || {}).key || '').toString());
    if (!key) return res.status(400).json({ error: 'key is required' });
    try {
      upsertEnvVar(envPath, 'BUSINESS_SERVICE_KEY', key);
      env.BUSINESS_SERVICE_KEY = key;
      return res.json({ ok: true, businessServiceKey: key });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to persist key', details: e.message });
    }
  });
}

module.exports = { register };
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd backend && npx vitest run __tests__/business-service-routes.test.mjs` — Expected: PASS.

- [ ] **Step 5: Wire it into `index.js`**

In `backend/index.js`, after `require('./routes/situations').register(app, { otelStore });` (below `app.use('/api', requireAuth)`), add:
```js
require('./routes/business-service').register(app, { otelStore });
```

- [ ] **Step 6: Full suite + boot smoke**

Run: `cd backend && npm test` — Expected: PASS (all suites).
Run: `cd backend && node -e "require('./routes/business-service'); require('./business-service-payloads'); require('./envFile'); console.log('modules load OK')"` — Expected: `modules load OK`.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/business-service.js backend/__tests__/business-service-routes.test.mjs backend/index.js
git commit -m "feat(business-service): guided namespaces/bind-instructions/persist-key routes"
```

---

## Self-Review

**1. Spec coverage**

| Spec element | Task |
|---|---|
| Detect (namespaces + X_SOURCE fallback) | Task 1 + Task 4 |
| Guide (checklist + AIOps/dashboard deep-links) | Task 3 + Task 4 |
| Capture (extract key, .env + process.env, no restart) | Task 2 + Task 3 + Task 4 |
| Confirm (dashboard URL) | Task 3 (`dashboardUrl`) — surfaced by Plan 2 UI |
| No authenticated Helix calls | Whole plan (no helixRest/CMDB anywhere) |
| Frontend flow (component, Step 5, card) | **Plan 2 — out of scope here** |

**2. Placeholder scan:** none — every code/test step is complete.

**3. Type/name consistency:** `listNamespaces()` returns `{ namespace, traceCount, lastSeen }` — consistent across Task 1 and the `/namespaces` handler. `buildBindInstructions(...)` returns `{ namespace, steps, aiopsUrl, dashboardUrl }` — consistent across Task 3 and Task 4. `extractServiceKey` + `upsertEnvVar` signatures match their definitions and callers.

---

## Execution Handoff

Plan complete (guided-only, no live-tenant dependencies). Tasks are independent and ordered by dependency (1–3 feed Task 4). Ready for subagent-driven execution. Plan 2 (frontend) follows once this is green.
