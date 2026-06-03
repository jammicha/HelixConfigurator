# Step 0 — Layer 1 Agentless (MVP: hostmetrics + dockerstats) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/step-zero` SPA route with a Layer 1 panel that lets a user with zero OTel in place click two buttons — "Enable host metrics" and "Enable container stats" — and within ~30s see real telemetry flowing into Helix.

**Architecture:** New `backend/routes/step-zero/` module with auth-gated REST endpoints that mutate `helix-otel-collector.yaml` via `js-yaml` load/dump (the same pattern `diagnostics.js#revertDebugMode` already uses for the gateway's own config), then trigger the existing gateway restart. New `frontend/src/components/step-zero/` page with a `StepZero` shell and a `Layer1Agentless` panel containing two cards. The Helix Gateway container gets three new read-only bind mounts (`/proc`, `/sys`, `/var/run/docker.sock`) added to `docker-compose.yml` so the receivers can scrape host metrics and docker stats without further container surgery.

**Tech Stack:** Node 20 + Express + js-yaml + dockerode (backend); React 18 + Vite + TypeScript + Tailwind + lucide-react (frontend); vitest for tests.

**Scope boundaries:**
- IN: infrastructure mounts, agentless route module, hostmetrics endpoint, dockerstats endpoint, per-receiver live counter, `/step-zero` SPA route, StepZero shell, Layer1Agentless panel with hostmetrics + dockerstats cards, sidebar link on Steps 1–4, "New to OTel?" banner on Step 1.
- OUT (future plans): filelog receiver, prometheus receiver, Layer 2 (synthetic scenario), Layer 3 (auto-instrumentation detection), "Continue to Step 1" CTA that carries state forward (sidebar link is enough for MVP), progress strip at top of `/step-zero` (one panel can't have meaningful progress).

---

## File Structure

**New files:**
- `backend/routes/step-zero/agentless.js` — Express route module: `GET status`, `POST hostmetrics/enable`, `POST dockerstats/enable`. ~150 lines.
- `backend/routes/step-zero/yaml-helpers.js` — Pure functions for mutating the gateway's own YAML (add receiver, wire pipeline). Reused by future Step 0 plans. ~80 lines.
- `backend/__tests__/step-zero-yaml-helpers.test.mjs` — Unit tests for the helpers. ~120 lines.
- `backend/__tests__/step-zero-agentless.test.mjs` — Route handler tests with stubbed docker + fs. ~150 lines.
- `frontend/src/components/step-zero/StepZero.tsx` — Page shell, fetches status, renders panels. ~80 lines.
- `frontend/src/components/step-zero/Layer1Agentless.tsx` — Panel with two cards. ~180 lines.
- `frontend/src/components/step-zero/types.ts` — Shared TypeScript types matching backend response shapes. ~30 lines.

**Modified files:**
- `docker-compose.yml` — Add three read-only mounts under the `helix-gateway` service.
- `backend/index.js` — Register the agentless route module after the `requireAuth` gate; add SPA fallback for `/step-zero`.
- `frontend/src/main.tsx` — Add `/step-zero` to the path-based route switch.
- `frontend/src/App.tsx` — Add "Starting from zero? →" link below the Stepper on Steps 1–4.
- `frontend/src/components/wizard/Step1.tsx` — Add "New to OTel?" banner above the form when `HELIX_API_KEY` is blank.

**Reused (do NOT duplicate):**
- `backend/util.js` — `withDockerTimeout`, `sendDockerTimeoutResponse`.
- `backend/routes/diagnostics.js` — Pattern for loading/dumping the gateway YAML (`revertDebugMode`, `toggle-debug`), `fetchCounters` for Prometheus scrape (not exported today — Task 6 either exports it or copies the parser).
- `backend/routes/config.js` — Pattern for atomic save + restart + rollback (`waitForGatewaySettle`, `extractCollectorError`). Task 4 imports these.

---

## Task 1: Add helix-gateway pre-mounts to docker-compose.yml

This is a one-time infrastructure change. Without these mounts, the receivers added in Tasks 4–5 will start but produce zero data. No test — verified at end of Task 4's smoke check.

**Security note for reviewers:** mounting `/var/run/docker.sock` into the gateway container is an elevation. The configurator container already has it (line 14). The gateway is the official `otel/opentelemetry-collector-contrib` image and only reads from the socket via `dockerstatsreceiver`. Mount is read-only.

**Files:**
- Modify: `docker-compose.yml` (helix-gateway service block, around line 37)

- [ ] **Step 1: Edit docker-compose.yml**

Open `docker-compose.yml`. The `helix-gateway` service currently has one volume mount (line 38). Replace its `volumes:` block with:

```yaml
    volumes:
      - ./helix-otel-collector.yaml:/etc/otelcol-contrib/config.yaml
      # Step 0 Layer 1 pre-mounts — let hostmetrics + dockerstats receivers
      # scrape host telemetry without per-receiver container surgery.
      - /proc:/hostfs/proc:ro
      - /sys:/hostfs/sys:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

- [ ] **Step 2: Recreate the helix-gateway container**

Run: `docker compose up -d helix-gateway --force-recreate`
Expected: `helix-gateway` container restarts cleanly. `docker ps` shows it `Up X seconds`.

- [ ] **Step 3: Verify mounts are visible inside the container**

Run: `docker exec helix-gateway ls /hostfs/proc/1 /var/run/docker.sock`
Expected: lists `/proc/1/...` contents (cmdline, status, etc.) and shows `/var/run/docker.sock` as a socket. If either is missing, the mount didn't land — re-check the YAML indentation.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(step-zero): pre-mount /proc, /sys, docker.sock on helix-gateway

Enables Step 0 Layer 1 hostmetrics and dockerstats receivers to scrape
host telemetry. All three mounts are read-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Create yaml-helpers.js — pure functions for receiver/pipeline edits

These helpers mutate the gateway's own YAML using `js-yaml` load/dump (matching the pattern in `diagnostics.js#revertDebugMode`). Pure functions for easy testing. Comments in `helix-otel-collector.yaml` will be lost on save — acceptable because the file currently has none.

**Files:**
- Create: `backend/routes/step-zero/yaml-helpers.js`
- Test: `backend/__tests__/step-zero-yaml-helpers.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `backend/__tests__/step-zero-yaml-helpers.test.mjs`:

```javascript
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  addReceiverAndPipeline,
  hasReceiver,
} from '../routes/step-zero/yaml-helpers.js';

const BASE_YAML = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
service:
  pipelines:
    metrics:
      receivers:
        - otlp
      exporters:
        - otlphttp/bmchelix
`;

describe('hasReceiver', () => {
  it('returns false when receiver is absent', () => {
    expect(hasReceiver(BASE_YAML, 'hostmetrics')).toBe(false);
  });

  it('returns true when receiver is present', () => {
    const withReceiver = BASE_YAML.replace('receivers:', 'receivers:\n  hostmetrics:\n    collection_interval: 30s');
    expect(hasReceiver(withReceiver, 'hostmetrics')).toBe(true);
  });
});

describe('addReceiverAndPipeline', () => {
  it('adds the receiver under receivers:', () => {
    const out = addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: { collection_interval: '30s', root_path: '/hostfs' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const parsed = yaml.load(out);
    expect(parsed.receivers.hostmetrics).toEqual({
      collection_interval: '30s',
      root_path: '/hostfs',
    });
  });

  it('wires the receiver into a new pipeline under the requested signal', () => {
    const out = addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: { collection_interval: '30s' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const parsed = yaml.load(out);
    expect(parsed.service.pipelines['metrics/host']).toEqual({
      receivers: ['hostmetrics'],
      exporters: ['otlphttp/bmchelix'],
    });
  });

  it('preserves the existing default metrics pipeline', () => {
    const out = addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: {},
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const parsed = yaml.load(out);
    expect(parsed.service.pipelines.metrics.receivers).toEqual(['otlp']);
  });

  it('is idempotent — adding the same receiver twice produces the same result', () => {
    const opts = {
      receiverName: 'hostmetrics',
      receiverConfig: { collection_interval: '30s' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    };
    const once = addReceiverAndPipeline(BASE_YAML, opts);
    const twice = addReceiverAndPipeline(once, opts);
    // Parse both — equality on parsed structures, not strings (dump order
    // may vary). Idempotency means receivers.hostmetrics is single-valued
    // and the pipeline's receivers array has exactly one entry.
    const p1 = yaml.load(once);
    const p2 = yaml.load(twice);
    expect(p2).toEqual(p1);
    expect(p2.service.pipelines['metrics/host'].receivers).toEqual(['hostmetrics']);
  });

  it('throws if pipelineSignal is not one of traces/metrics/logs', () => {
    expect(() => addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: {},
      pipelineName: 'bogus/host',
      pipelineSignal: 'bogus',
      exporters: ['otlphttp/bmchelix'],
    })).toThrow(/pipelineSignal/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-yaml-helpers.test.mjs`
Expected: FAIL with `Cannot find module '../routes/step-zero/yaml-helpers.js'` (or similar import error).

- [ ] **Step 3: Write the implementation**

Create `backend/routes/step-zero/yaml-helpers.js`:

```javascript
// Pure helpers for editing the helix-gateway's OWN OTel collector config
// (helix-otel-collector.yaml). Uses js-yaml load/dump — comments will not
// be preserved across edits. This is acceptable for our config (which has
// no comments today); for CUSTOMER configs we use the text-level patcher in
// backend/routes/discovery.js instead.
const yaml = require('js-yaml');

const VALID_SIGNALS = new Set(['traces', 'metrics', 'logs']);

const hasReceiver = (yamlText, receiverName) => {
  const parsed = yaml.load(yamlText);
  return !!(parsed && parsed.receivers && parsed.receivers[receiverName]);
};

// Add a receiver block under receivers: and wire it into a new pipeline.
// If the receiver or pipeline already exists, the operation is a no-op for
// that piece (idempotent) — callers can re-invoke safely.
const addReceiverAndPipeline = (yamlText, opts) => {
  const {
    receiverName,
    receiverConfig,
    pipelineName,
    pipelineSignal,
    exporters,
  } = opts;
  if (!VALID_SIGNALS.has(pipelineSignal)) {
    throw new Error(
      `addReceiverAndPipeline: pipelineSignal must be one of traces/metrics/logs, got ${JSON.stringify(pipelineSignal)}`
    );
  }
  const parsed = yaml.load(yamlText) || {};
  parsed.receivers = parsed.receivers || {};
  parsed.service = parsed.service || {};
  parsed.service.pipelines = parsed.service.pipelines || {};

  // Receiver: overwrite if present so config drift (e.g. collection_interval
  // change) re-applies cleanly. The toggle is "enabled / not enabled" — there's
  // no half-state we need to merge.
  parsed.receivers[receiverName] = receiverConfig;

  // Pipeline: ensure it exists with the requested receiver list. Don't merge
  // existing arbitrary pipelines named the same — names like "metrics/host"
  // are ours, so overwriting is the intended behavior.
  parsed.service.pipelines[pipelineName] = {
    receivers: [receiverName],
    exporters: [...exporters],
  };

  // dump with -1 line width so long URLs and headers don't wrap (matches
  // diagnostics.js#revertDebugMode style).
  return yaml.dump(parsed, { lineWidth: -1 });
};

module.exports = { addReceiverAndPipeline, hasReceiver };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-yaml-helpers.test.mjs`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/step-zero/yaml-helpers.js backend/__tests__/step-zero-yaml-helpers.test.mjs
git commit -m "feat(step-zero): add yaml-helpers for gateway config receiver edits

Pure functions for idempotently adding a receiver + pipeline to the
gateway's own collector YAML. Uses js-yaml load/dump (no comment
preservation — fine for our config).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create agentless.js route module with status endpoint, mounted in index.js

Scaffold the new module and register it after the auth gate. The status endpoint returns enabled-state per receiver — UI polls this every 5s.

**Files:**
- Create: `backend/routes/step-zero/agentless.js`
- Modify: `backend/index.js` (add `require('./routes/step-zero/agentless').register(...)` after line 97)
- Modify: `backend/package.json` (add `supertest` to devDependencies)
- Test: `backend/__tests__/step-zero-agentless.test.mjs`

- [ ] **Step 1: Install supertest**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npm install --save-dev supertest@^7.0.0`
Expected: `package.json` gets `"supertest": "^7.0.0"` under `devDependencies`; `node_modules/supertest` installed; no other dependency changes.

- [ ] **Step 2: Write the failing tests**

Create `backend/__tests__/step-zero-agentless.test.mjs`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from '../routes/step-zero/agentless.js';

export const BASE_YAML = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
service:
  pipelines:
    metrics:
      receivers:
        - otlp
      exporters:
        - otlphttp/bmchelix
`;

export const makeApp = (deps) => {
  const app = express();
  app.use(express.json());
  register(app, deps);
  return app;
};

export const tmpConfig = (yamlText = BASE_YAML) => {
  const p = path.join(os.tmpdir(), `step-zero-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, yamlText, 'utf8');
  return p;
};

describe('GET /api/step-zero/agentless/status', () => {
  it('returns enabled=false for hostmetrics and dockerstats when base config', async () => {
    const configPath = tmpConfig();
    const app = makeApp({ docker: { listContainers: vi.fn().mockResolvedValue([]) }, configPath });
    const r = await request(app).get('/api/step-zero/agentless/status');
    expect(r.status).toBe(200);
    expect(r.body.hostmetrics.enabled).toBe(false);
    expect(r.body.dockerstats.enabled).toBe(false);
  });

  it('returns enabled=true after the receiver is added to YAML', async () => {
    const configPath = tmpConfig(BASE_YAML.replace('receivers:', 'receivers:\n  hostmetrics:\n    root_path: /hostfs'));
    const app = makeApp({ docker: { listContainers: vi.fn().mockResolvedValue([]) }, configPath });
    const r = await request(app).get('/api/step-zero/agentless/status');
    expect(r.body.hostmetrics.enabled).toBe(true);
    expect(r.body.dockerstats.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: FAIL with `Cannot find module '../routes/step-zero/agentless.js'`.

- [ ] **Step 3: Write the implementation**

Create `backend/routes/step-zero/agentless.js`:

```javascript
// Step 0 Layer 1 — agentless collection. Each receiver here is enabled by
// a button click in the Step 0 SPA panel; the endpoint mutates the gateway's
// own collector YAML and restarts the container. The pre-mounts that make
// these receivers actually produce data (/proc, /sys, docker.sock) are added
// to docker-compose.yml separately — without them, the receivers start but
// scrape zero metrics.
const fs = require('fs');
const { hasReceiver } = require('./yaml-helpers');

function register(app, { docker, configPath }) {
  // GET enabled-state per receiver. UI polls every 5s to flip cards green
  // once enable completes.
  app.get('/api/step-zero/agentless/status', async (req, res) => {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      res.json({
        hostmetrics: { enabled: hasReceiver(text, 'hostmetrics') },
        dockerstats: { enabled: hasReceiver(text, 'docker_stats') },
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read gateway config', details: e.message });
    }
  });
}

module.exports = { register };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: PASS — both tests green.

- [ ] **Step 5: Mount the route in index.js**

Open `backend/index.js`. After line 97 (`require('./routes/lifecycle').register(app, { docker });`), insert:

```javascript
require('./routes/step-zero/agentless').register(app, { docker, configPath: CONFIG_PATH });
```

Verify by starting the backend (`cd backend && npm run start`) and hitting `curl http://localhost:3001/api/step-zero/agentless/status` (with auth cookie or auth disabled). Expected JSON body: `{"hostmetrics":{"enabled":false},"dockerstats":{"enabled":false}}` if you reverted Task 2's hostmetrics edit, else `enabled:true`.

- [ ] **Step 6: Add SPA fallback for /step-zero**

Open `backend/index.js`. After line 48 (the `/otel-data` SPA fallback), insert:

```javascript
// SPA fallback for the Step 0 zero-to-OTel onboarding route.
app.get(/^\/step-zero(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend-dist/index.html'));
});
```

- [ ] **Step 7: Commit**

```bash
git add backend/routes/step-zero/agentless.js backend/__tests__/step-zero-agentless.test.mjs backend/index.js
git commit -m "feat(step-zero): scaffold agentless route module + SPA fallback

Adds GET /api/step-zero/agentless/status returning per-receiver enabled
state, mounts the module after the requireAuth gate, and adds the SPA
fallback so the /step-zero client-side route is reachable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: hostmetrics enable endpoint + atomic save-restart-rollback

This endpoint mutates the gateway YAML, restarts the container, and rolls back if the new config crashes the collector. Reuses `waitForGatewaySettle` + `extractCollectorError` from `config.js`.

**Files:**
- Modify: `backend/routes/step-zero/agentless.js`
- Modify: `backend/routes/config.js` (export the two helpers so agentless.js can import them)
- Modify: `backend/__tests__/step-zero-agentless.test.mjs` (add hostmetrics test)

- [ ] **Step 1: Export the helpers from config.js**

Open `backend/routes/config.js`. At the bottom, change:

```javascript
module.exports = { register };
```

to:

```javascript
module.exports = { register, waitForGatewaySettle, extractCollectorError };
```

- [ ] **Step 2: Write the failing test**

Open `backend/__tests__/step-zero-agentless.test.mjs`. Append:

```javascript
describe('POST /api/step-zero/agentless/hostmetrics/enable', () => {
  it('writes hostmetrics receiver into the YAML and reports success', async () => {
    const configPath = tmpConfig();
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn().mockReturnValue({
        restart: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({ State: { Status: 'running', StartedAt: new Date(Date.now() - 3000).toISOString() } }),
      }),
    };
    const containerLogs = vi.fn().mockResolvedValue('');
    const app = makeApp({ docker, configPath, containerLogs });
    const r = await request(app).post('/api/step-zero/agentless/hostmetrics/enable').send({});
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const newYaml = fs.readFileSync(configPath, 'utf8');
    expect(newYaml).toMatch(/hostmetrics:/);
    expect(newYaml).toMatch(/root_path: \/hostfs/);
    expect(newYaml).toMatch(/metrics\/host:/);
  });

  it('rolls back the YAML if the gateway fails to come back up', async () => {
    const configPath = tmpConfig();
    const originalYaml = fs.readFileSync(configPath, 'utf8');
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn().mockReturnValue({
        restart: vi.fn().mockResolvedValue(undefined),
        // Container exits — waitForGatewaySettle returns running:false.
        inspect: vi.fn().mockResolvedValue({ State: { Status: 'exited', ExitCode: 1, StartedAt: new Date().toISOString() } }),
      }),
    };
    const containerLogs = vi.fn().mockResolvedValue('Error: invalid receiver config');
    const app = makeApp({ docker, configPath, containerLogs });
    const r = await request(app).post('/api/step-zero/agentless/hostmetrics/enable').send({});
    expect(r.status).toBe(500);
    expect(r.body.rolledBack).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(originalYaml);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: FAIL with 404 (no route registered for the POST) on both new tests.

- [ ] **Step 4: Write the implementation**

Open `backend/routes/step-zero/agentless.js`. Replace the entire file with:

```javascript
// Step 0 Layer 1 — agentless collection. Each receiver here is enabled by
// a button click in the Step 0 SPA panel; the endpoint mutates the gateway's
// own collector YAML and restarts the container. The pre-mounts that make
// these receivers actually produce data (/proc, /sys, docker.sock) are added
// to docker-compose.yml separately — without them, the receivers start but
// scrape zero metrics.
const fs = require('fs');
const { addReceiverAndPipeline, hasReceiver } = require('./yaml-helpers');
const { waitForGatewaySettle, extractCollectorError } = require('../config');
const { withDockerTimeout, sendDockerTimeoutResponse } = require('../../util');

const TARGET_CONTAINER = () => process.env.TARGET_CONTAINER_NAME || 'helix-gateway';

// Shared atomic write-restart-rollback. Returns the route's response object
// directly so handlers stay one-liners.
const applyReceiverEdit = async ({ res, docker, containerLogs, configPath, receiverName, receiverConfig, pipelineName, pipelineSignal, exporters }) => {
  let previous;
  try {
    previous = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read gateway config', details: e.message });
  }

  let newYaml;
  try {
    newYaml = addReceiverAndPipeline(previous, {
      receiverName, receiverConfig, pipelineName, pipelineSignal, exporters,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to compute new YAML', details: e.message });
  }

  try {
    fs.writeFileSync(configPath, newYaml, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write gateway config', details: e.message });
  }

  const targetContainer = TARGET_CONTAINER();
  try {
    await withDockerTimeout(docker.getContainer(targetContainer).restart(), 'container.restart', 30_000);
  } catch (e) {
    if (sendDockerTimeoutResponse(res, e)) return;
    // Restart failed — try to roll back so we don't leave a half-applied state.
    try { fs.writeFileSync(configPath, previous, 'utf8'); } catch { /* best effort */ }
    return res.status(500).json({ error: 'Gateway restart failed; YAML rolled back', details: e.message, rolledBack: true });
  }

  // Did the gateway come back up cleanly?
  const settled = await waitForGatewaySettle(docker, containerLogs, targetContainer);
  if (!settled.running) {
    try {
      fs.writeFileSync(configPath, previous, 'utf8');
      await docker.getContainer(targetContainer).restart().catch(() => {});
    } catch { /* best effort */ }
    return res.status(500).json({
      error: `Collector rejected the new config — rolled back`,
      details: extractCollectorError(settled.recentLogs) || `Collector exited (code ${settled.exitCode})`,
      rolledBack: true,
    });
  }

  res.json({ enabled: true, receiverName, pipelineName });
};

function register(app, { docker, containerLogs, configPath }) {
  // GET enabled-state per receiver.
  app.get('/api/step-zero/agentless/status', async (req, res) => {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      res.json({
        hostmetrics: { enabled: hasReceiver(text, 'hostmetrics') },
        dockerstats: { enabled: hasReceiver(text, 'docker_stats') },
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read gateway config', details: e.message });
    }
  });

  // POST enable hostmetrics — one-click. Pre-mounts in docker-compose.yml
  // are a prereq; without /hostfs the scrapers will run but find no data.
  app.post('/api/step-zero/agentless/hostmetrics/enable', async (req, res) => {
    await applyReceiverEdit({
      res, docker, containerLogs, configPath,
      receiverName: 'hostmetrics',
      receiverConfig: {
        collection_interval: '30s',
        root_path: '/hostfs',
        scrapers: {
          cpu: null,
          memory: null,
          disk: null,
          network: null,
          load: null,
          filesystem: null,
        },
      },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
  });
}

module.exports = { register };
```

- [ ] **Step 5: Update the index.js wiring to pass containerLogs**

Open `backend/index.js`. Find the agentless `require` line added in Task 3 Step 5 and replace with:

```javascript
require('./routes/step-zero/agentless').register(app, { docker, containerLogs, configPath: CONFIG_PATH });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: PASS — all 4 tests green (2 status + 2 hostmetrics).

- [ ] **Step 7: Live smoke verify against a running gateway**

With `docker compose up -d` running, hit the endpoint:

Run: `curl -X POST http://localhost:8765/api/step-zero/agentless/hostmetrics/enable -H 'Content-Type: application/json' -d '{}' --cookie-jar /tmp/cj --cookie /tmp/cj`
(Use an authenticated session; if auth is off via `UI_AUTH_PASSWORD` blank, the cookie isn't required.)
Expected: `{"enabled":true,"receiverName":"hostmetrics","pipelineName":"metrics/host"}` and the gateway container restarts cleanly within ~5s.

Then: `docker exec helix-gateway curl -s http://localhost:8888/metrics | grep -c 'hostmetrics'`
Expected: returns a positive integer within 30s — the hostmetrics receiver is emitting self-metrics now.

If the gateway exits or rolls back, check `docker logs helix-gateway --tail 50` for the Error: line.

- [ ] **Step 8: Commit**

```bash
git add backend/routes/step-zero/agentless.js backend/__tests__/step-zero-agentless.test.mjs backend/routes/config.js backend/index.js
git commit -m "feat(step-zero): POST /agentless/hostmetrics/enable

One-click endpoint to add hostmetrics receiver + metrics/host pipeline
to the gateway YAML, restart the container, and roll back if the
collector rejects the new config. Reuses waitForGatewaySettle and
extractCollectorError from routes/config.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: dockerstats enable endpoint

Mirrors Task 4's pattern with a different receiver config.

**Files:**
- Modify: `backend/routes/step-zero/agentless.js`
- Modify: `backend/__tests__/step-zero-agentless.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `backend/__tests__/step-zero-agentless.test.mjs`:

```javascript
describe('POST /api/step-zero/agentless/dockerstats/enable', () => {
  it('writes docker_stats receiver into the YAML and reports success', async () => {
    const configPath = tmpConfig();
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn().mockReturnValue({
        restart: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({ State: { Status: 'running', StartedAt: new Date(Date.now() - 3000).toISOString() } }),
      }),
    };
    const containerLogs = vi.fn().mockResolvedValue('');
    const app = makeApp({ docker, configPath, containerLogs });
    const r = await request(app).post('/api/step-zero/agentless/dockerstats/enable').send({});
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const newYaml = fs.readFileSync(configPath, 'utf8');
    expect(newYaml).toMatch(/docker_stats:/);
    expect(newYaml).toMatch(/endpoint: unix:\/\/\/var\/run\/docker\.sock/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: the new dockerstats test FAILs with 404 (no route registered).

- [ ] **Step 3: Add the endpoint**

Open `backend/routes/step-zero/agentless.js`. Inside the `register` function, after the hostmetrics handler, add:

```javascript
  // POST enable docker_stats — one-click. Requires /var/run/docker.sock to
  // be mounted into the gateway container (see docker-compose.yml).
  app.post('/api/step-zero/agentless/dockerstats/enable', async (req, res) => {
    await applyReceiverEdit({
      res, docker, containerLogs, configPath,
      receiverName: 'docker_stats',
      receiverConfig: {
        endpoint: 'unix:///var/run/docker.sock',
        collection_interval: '30s',
      },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Live smoke verify**

Run: `curl -X POST http://localhost:8765/api/step-zero/agentless/dockerstats/enable -H 'Content-Type: application/json' -d '{}'`
Expected: `{"enabled":true,...}` and the gateway restarts cleanly.

Then: `docker exec helix-gateway curl -s http://localhost:8888/metrics | grep -c 'docker_stats'`
Expected: positive integer within 30s.

**Note on the shared pipeline:** Both hostmetrics and docker_stats wire into `metrics/host`. The Task 2 helper currently overwrites the pipeline's `receivers:` array on each call. After Task 5, enabling docker_stats SECOND will leave the pipeline with `receivers: [docker_stats]` and drop hostmetrics. Fix this in Step 6 below before committing.

- [ ] **Step 6: Fix the pipeline-merge bug**

Open `backend/routes/step-zero/yaml-helpers.js`. Change the pipeline-write block (currently overwrites):

```javascript
  parsed.service.pipelines[pipelineName] = {
    receivers: [receiverName],
    exporters: [...exporters],
  };
```

to merge with existing receivers:

```javascript
  const existing = parsed.service.pipelines[pipelineName] || { receivers: [], exporters: [...exporters] };
  const mergedReceivers = Array.from(new Set([...(existing.receivers || []), receiverName]));
  parsed.service.pipelines[pipelineName] = {
    receivers: mergedReceivers,
    exporters: [...exporters],
  };
```

Add a regression test to `backend/__tests__/step-zero-yaml-helpers.test.mjs`:

```javascript
  it('appends to an existing pipeline rather than overwriting its receivers', () => {
    const once = addReceiverAndPipeline(BASE_YAML, {
      receiverName: 'hostmetrics',
      receiverConfig: { collection_interval: '30s' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const twice = addReceiverAndPipeline(once, {
      receiverName: 'docker_stats',
      receiverConfig: { endpoint: 'unix:///var/run/docker.sock' },
      pipelineName: 'metrics/host',
      pipelineSignal: 'metrics',
      exporters: ['otlphttp/bmchelix'],
    });
    const parsed = yaml.load(twice);
    expect(parsed.service.pipelines['metrics/host'].receivers.sort()).toEqual(['docker_stats', 'hostmetrics']);
  });
```

Run all tests: `npx vitest run __tests__/step-zero-yaml-helpers.test.mjs __tests__/step-zero-agentless.test.mjs`
Expected: all 7 + 5 = green.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/step-zero/agentless.js backend/routes/step-zero/yaml-helpers.js backend/__tests__/step-zero-agentless.test.mjs backend/__tests__/step-zero-yaml-helpers.test.mjs
git commit -m "feat(step-zero): POST /agentless/dockerstats/enable + merge fix

Adds the docker_stats receiver endpoint and fixes addReceiverAndPipeline
to APPEND to an existing pipeline's receivers list instead of overwriting
— so enabling hostmetrics then dockerstats keeps both in metrics/host.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add per-receiver live counts to the status endpoint

UI flips cards to green and shows "receiving N metrics/min" — needs the count broken down by receiver. Reads the gateway's Prometheus metrics endpoint (same source `diagnostics.js#fetchCounters` uses).

**Files:**
- Modify: `backend/routes/step-zero/agentless.js`
- Modify: `backend/__tests__/step-zero-agentless.test.mjs`

- [ ] **Step 1: Write the failing test**

Open `backend/__tests__/step-zero-agentless.test.mjs`. Add this import at the TOP of the file alongside the existing imports:

```javascript
import axios from 'axios';
vi.mock('axios');
```

(ESM hoists imports and vitest hoists `vi.mock` above them — order between the two doesn't matter, but both must precede the first describe.)

Then APPEND this new describe block to the bottom of the file:

```javascript
describe('GET /api/step-zero/agentless/status with live counts', () => {
  it('includes acceptedMetricPoints for hostmetrics when receiver is present', async () => {
    const configPath = tmpConfig(BASE_YAML.replace('receivers:', 'receivers:\n  hostmetrics:\n    root_path: /hostfs'));
    // Mock the gateway /metrics scrape via axios's default export. Vitest hoists
    // vi.mock above the imports, so this affects the route module's `require('axios')`.
    axios.get.mockResolvedValue({
      data: `otelcol_receiver_accepted_metric_points_total{receiver="hostmetrics"} 600
otelcol_receiver_accepted_metric_points_total{receiver="docker_stats"} 0
otelcol_receiver_accepted_metric_points_total{receiver="otlp"} 0`,
    });
    const app = makeApp({ docker: { listContainers: vi.fn().mockResolvedValue([]) }, configPath });
    const r = await request(app).get('/api/step-zero/agentless/status');
    expect(r.body.hostmetrics.enabled).toBe(true);
    expect(r.body.hostmetrics.acceptedMetricPoints).toBe(600);
    expect(r.body.dockerstats.acceptedMetricPoints).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: the new test FAILs because `acceptedMetricPoints` isn't on the response yet.

- [ ] **Step 3: Implement the per-receiver scraper**

Open `backend/routes/step-zero/agentless.js`. At the top of the file (after the `require` lines), add:

```javascript
const axios = require('axios');

// Sum the receiver_accepted_metric_points counter for a specific receiver
// label, scraped from the gateway's Prometheus self-metrics. Returns 0 when
// the receiver hasn't emitted anything yet or the scrape fails.
const fetchAcceptedForReceiver = async (targetContainer, receiverName) => {
  try {
    const { data } = await axios.get(`http://${targetContainer}:8888/metrics`, { timeout: 2000 });
    const needle = `receiver="${receiverName}"`;
    let sum = 0;
    for (const line of String(data).split('\n')) {
      if (!line.startsWith('otelcol_receiver_accepted_metric_points_total')) continue;
      if (!line.includes(needle)) continue;
      const parts = line.trim().split(/\s+/);
      const v = parseFloat(parts[parts.length - 1]);
      if (!isNaN(v)) sum += v;
    }
    return Math.round(sum);
  } catch { return 0; }
};
```

Replace the existing `app.get('/api/step-zero/agentless/status', ...)` handler with:

```javascript
  app.get('/api/step-zero/agentless/status', async (req, res) => {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      const hostmetricsEnabled = hasReceiver(text, 'hostmetrics');
      const dockerstatsEnabled = hasReceiver(text, 'docker_stats');
      const target = TARGET_CONTAINER();
      // Only scrape live counts for receivers that are configured — saves a
      // round-trip per call when nothing's enabled yet.
      const [hmCount, dsCount] = await Promise.all([
        hostmetricsEnabled ? fetchAcceptedForReceiver(target, 'hostmetrics') : Promise.resolve(0),
        dockerstatsEnabled ? fetchAcceptedForReceiver(target, 'docker_stats') : Promise.resolve(0),
      ]);
      res.json({
        hostmetrics: { enabled: hostmetricsEnabled, acceptedMetricPoints: hmCount },
        dockerstats: { enabled: dockerstatsEnabled, acceptedMetricPoints: dsCount },
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read gateway config', details: e.message });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-agentless.test.mjs`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/step-zero/agentless.js backend/__tests__/step-zero-agentless.test.mjs
git commit -m "feat(step-zero): include live acceptedMetricPoints in status

Status endpoint now scrapes the gateway's Prometheus self-metrics and
breaks accepted counts down by receiver label, so the UI can flip
cards to green and show 'receiving N metrics/min'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Frontend — register /step-zero route in main.tsx

Tiny change — the SPA already does path-based routing.

**Files:**
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Edit main.tsx**

Open `frontend/src/main.tsx`. Replace the file with:

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AiopsPage } from './components/AiopsPage'
import { OtelDataPage } from './components/OtelDataPage'
import { StepZero } from './components/step-zero/StepZero'
import './index.css'

const path = window.location.pathname
const isAiops = path.startsWith('/aiops')
const isOtelData = path.startsWith('/otel-data')
const isStepZero = path.startsWith('/step-zero')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAiops ? <AiopsPage /> :
     isOtelData ? <OtelDataPage /> :
     isStepZero ? <StepZero /> :
     <App />}
  </React.StrictMode>,
)
```

The build will fail until Task 8 creates the StepZero component. No commit yet.

---

## Task 8: Create StepZero page shell + types

Page header, "Continue to wizard →" link back to `/`, and a slot for Layer 1.

**Files:**
- Create: `frontend/src/components/step-zero/types.ts`
- Create: `frontend/src/components/step-zero/StepZero.tsx`
- Create: `frontend/src/components/step-zero/Layer1Agentless.tsx` (stub — populated in Tasks 9–10)

- [ ] **Step 1: Create types.ts**

Create `frontend/src/components/step-zero/types.ts`:

```typescript
// Response shape for GET /api/step-zero/agentless/status.
// Mirrors backend/routes/step-zero/agentless.js return value.
export type ReceiverStatus = {
  enabled: boolean;
  acceptedMetricPoints: number;
};

export type AgentlessStatus = {
  hostmetrics: ReceiverStatus;
  dockerstats: ReceiverStatus;
};
```

- [ ] **Step 2: Create a stub Layer1Agentless component**

Create `frontend/src/components/step-zero/Layer1Agentless.tsx`:

```tsx
import React from 'react';
import type { AgentlessStatus } from './types';

type Props = {
  status: AgentlessStatus | null;
  onEnable: (receiver: 'hostmetrics' | 'dockerstats') => Promise<void>;
};

export const Layer1Agentless: React.FC<Props> = () => (
  <section className="rounded-lg border border-gray-800 bg-gray-1000 p-6">
    <h2 className="text-lg font-semibold text-gray-100 mb-1">
      Layer 1 — Collect what's already there
    </h2>
    <p className="text-sm text-gray-400 mb-4">
      Two zero-code receivers running inside the Helix Gateway. No changes to your apps.
    </p>
    <div className="text-gray-500 text-sm">(Cards added in Tasks 9–10.)</div>
  </section>
);
```

- [ ] **Step 3: Create StepZero shell**

Create `frontend/src/components/step-zero/StepZero.tsx`:

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import { Layer1Agentless } from './Layer1Agentless';
import type { AgentlessStatus } from './types';

export const StepZero: React.FC = () => {
  const [status, setStatus] = useState<AgentlessStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/step-zero/agentless/status', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as AgentlessStatus;
      setStatus(data);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Initial fetch + 5s poll. Hidden-tab pauses to save battery.
  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, 5000);
    const onVis = () => { if (document.visibilityState !== 'hidden') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  const enable = useCallback(async (receiver: 'hostmetrics' | 'dockerstats') => {
    const r = await fetch(`/api/step-zero/agentless/${receiver}/enable`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || body.details || `HTTP ${r.status}`);
    }
    await refresh();
  }, [refresh]);

  return (
    <div className="min-h-screen bg-gray-1100 text-gray-100">
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Start from zero</h1>
          <p className="text-sm text-gray-400">
            Get telemetry flowing into Helix without instrumenting your apps. Click a button below
            and the Helix Gateway will start scraping data on your behalf.
          </p>
        </header>

        {err && (
          <div className="rounded border border-red-900 bg-red-950/40 text-red-200 text-sm p-3">
            Failed to load status: {err}
          </div>
        )}

        <Layer1Agentless status={status} onEnable={enable} />

        <footer className="pt-4 border-t border-gray-800">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100"
          >
            Continue to the full wizard <ArrowRight className="w-4 h-4" />
          </a>
        </footer>
      </main>
    </div>
  );
};
```

- [ ] **Step 4: Build and verify the route loads**

Run: `cd /Users/jammicha/dev/HelixConfigurator/frontend && npm run build`
Expected: `tsc && vite build` succeeds with no errors.

Then verify the SPA fallback serves the route: `curl -I http://localhost:8765/step-zero` should return 200 with HTML content-type. Open `http://localhost:8765/step-zero` in a browser — you should see "Start from zero" with the empty Layer 1 panel.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/main.tsx frontend/src/components/step-zero/
git commit -m "feat(step-zero): StepZero page shell + /step-zero SPA route

Adds the /step-zero route, page header with intro, polled status hook,
and an empty Layer 1 panel slot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Hostmetrics card UI

Card with enable button, transitions to green with live count after enable.

**Files:**
- Modify: `frontend/src/components/step-zero/Layer1Agentless.tsx`

- [ ] **Step 1: Replace Layer1Agentless.tsx**

Open `frontend/src/components/step-zero/Layer1Agentless.tsx`. Replace the file with:

```tsx
import React, { useState } from 'react';
import { Cpu, CheckCircle, Loader2 } from 'lucide-react';
import type { AgentlessStatus, ReceiverStatus } from './types';

type Props = {
  status: AgentlessStatus | null;
  onEnable: (receiver: 'hostmetrics' | 'dockerstats') => Promise<void>;
};

// One row in the panel. Reused by both receiver cards.
const ReceiverCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  status: ReceiverStatus | undefined;
  onEnable: () => Promise<void>;
  loading: boolean;
  error: string | null;
}> = ({ icon, title, description, status, onEnable, loading, error }) => {
  const enabled = !!status?.enabled;
  const flowing = enabled && (status?.acceptedMetricPoints ?? 0) > 0;
  return (
    <div className={`rounded border p-4 ${flowing ? 'border-green-800 bg-green-950/20' : 'border-gray-800 bg-gray-1100'}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 ${flowing ? 'text-green-400' : 'text-gray-400'}`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
            {flowing && (
              <span className="inline-flex items-center gap-1 text-tiny text-green-300">
                <CheckCircle className="w-3.5 h-3.5" />
                {status!.acceptedMetricPoints.toLocaleString()} metrics accepted
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-1">{description}</p>
          {error && (
            <p className="text-tiny text-red-300 mt-2">{error}</p>
          )}
          <div className="mt-3">
            {enabled ? (
              <span className="text-tiny text-gray-500">
                {flowing ? 'Active — flowing to Helix.' : 'Enabled — waiting for first scrape (up to 30s).'}
              </span>
            ) : (
              <button
                onClick={onEnable}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-tiny font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
              >
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Enable {title.toLowerCase()}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const Layer1Agentless: React.FC<Props> = ({ status, onEnable }) => {
  const [loading, setLoading] = useState<{ hostmetrics: boolean; dockerstats: boolean }>({ hostmetrics: false, dockerstats: false });
  const [error, setError] = useState<{ hostmetrics: string | null; dockerstats: string | null }>({ hostmetrics: null, dockerstats: null });

  const click = async (receiver: 'hostmetrics' | 'dockerstats') => {
    setLoading((s) => ({ ...s, [receiver]: true }));
    setError((s) => ({ ...s, [receiver]: null }));
    try {
      await onEnable(receiver);
    } catch (e) {
      setError((s) => ({ ...s, [receiver]: (e as Error).message }));
    } finally {
      setLoading((s) => ({ ...s, [receiver]: false }));
    }
  };

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-1000 p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">
        Layer 1 — Collect what's already there
      </h2>
      <p className="text-sm text-gray-400 mb-4">
        Two zero-code receivers running inside the Helix Gateway. No changes to your apps.
      </p>
      <div className="space-y-3">
        <ReceiverCard
          icon={<Cpu className="w-5 h-5" />}
          title="Host metrics"
          description="CPU, memory, disk, network, load, and filesystem from the machine running Helix."
          status={status?.hostmetrics}
          onEnable={() => click('hostmetrics')}
          loading={loading.hostmetrics}
          error={error.hostmetrics}
        />
        {/* dockerstats card added in Task 10 */}
      </div>
    </section>
  );
};
```

- [ ] **Step 2: Build and smoke-test the hostmetrics flow end-to-end**

Run: `cd /Users/jammicha/dev/HelixConfigurator/frontend && npm run build`
Expected: build succeeds.

In a browser at `http://localhost:8765/step-zero`:
1. The Host metrics card should show with an "Enable host metrics" button.
2. Click it. Within ~10s the gateway restarts; the card flips to gray "Enabled — waiting for first scrape".
3. Within ~30s, polled status returns `acceptedMetricPoints > 0` — card turns green and shows "N metrics accepted".

If the gateway fails to come back up, the button click returns an error inline ("Collector rejected the new config — rolled back") and the YAML is reverted.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/step-zero/Layer1Agentless.tsx
git commit -m "feat(step-zero): hostmetrics card UI with enable button + live count

Card transitions: idle → loading → enabled-no-data → green-with-count.
Errors from the backend are surfaced inline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Dockerstats card UI

Adds the second card. Same component, different copy and icon.

**Files:**
- Modify: `frontend/src/components/step-zero/Layer1Agentless.tsx`

- [ ] **Step 1: Add the second ReceiverCard**

Open `frontend/src/components/step-zero/Layer1Agentless.tsx`. At the top, change the icon import:

```tsx
import { Cpu, Container, CheckCircle, Loader2 } from 'lucide-react';
```

Inside the `<div className="space-y-3">` block, after the hostmetrics card, add:

```tsx
        <ReceiverCard
          icon={<Container className="w-5 h-5" />}
          title="Container stats"
          description="Per-container CPU, memory, network, and block I/O from every container running on this Docker host."
          status={status?.dockerstats}
          onEnable={() => click('dockerstats')}
          loading={loading.dockerstats}
          error={error.dockerstats}
        />
```

Also delete the `{/* dockerstats card added in Task 10 */}` placeholder comment.

- [ ] **Step 2: Build and smoke-test**

Run: `cd /Users/jammicha/dev/HelixConfigurator/frontend && npm run build`
Expected: build succeeds.

In the browser at `/step-zero`, click both buttons. Both cards should turn green with positive metric counts within 30s after enable. Verify in Helix (or `/otel-data`) that both `hostmetrics` and `docker_stats` receivers are emitting.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/step-zero/Layer1Agentless.tsx
git commit -m "feat(step-zero): dockerstats card UI

Second receiver card in the Layer 1 panel. Same component shape as
hostmetrics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Add "Starting from zero?" link to the wizard sidebar (Steps 1–4)

Surfaces /step-zero from inside the wizard so users mid-flow can discover it.

**Files:**
- Modify: `frontend/src/App.tsx` (around line 1644 — the existing Reset link block)

- [ ] **Step 1: Edit App.tsx**

Open `frontend/src/App.tsx`. Find the block at lines 1644–1653 (the existing "Reset onboarding" link). Replace it with:

```tsx
              <div className="flex justify-between items-center -mt-2">
                <a
                  href="/step-zero"
                  className="text-tiny text-gray-400 hover:text-gray-200 underline"
                  title="No OTel collector or instrumented apps yet? Start here to get data flowing without touching your apps."
                >
                  Starting from zero? →
                </a>
                <button
                  onClick={requestResetOnboarding}
                  disabled={resetting}
                  className="text-tiny text-gray-500 hover:text-gray-300 underline disabled:opacity-60"
                  title="Clear .env (endpoint, API key, X-Source, App URL, business-service key), drop bridged networks, and restart from Step 1"
                >
                  {resetting ? 'Resetting…' : 'Reset onboarding and start over'}
                </button>
              </div>
```

- [ ] **Step 2: Build and smoke-test**

Run: `cd /Users/jammicha/dev/HelixConfigurator/frontend && npm run build`
Expected: build succeeds.

In the browser, navigate to the wizard (`/?view=onboarding` or clear `helix-configurator.onboarded` localStorage). On every step (1–4), confirm the "Starting from zero? →" link appears next to "Reset onboarding". Click it — should navigate to `/step-zero`. Clicking "Continue to the full wizard" in the footer should return to the wizard.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(step-zero): link from wizard sidebar to /step-zero

Adds 'Starting from zero? →' link next to the Reset link below the
Stepper. Visible on every wizard step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: "New to OTel?" banner on Step 1 when no API key configured

First-time users get a more prominent nudge into Step 0.

**Files:**
- Modify: `frontend/src/components/wizard/Step1.tsx`

- [ ] **Step 1: Add the banner above the existing Step 1 header**

Open `frontend/src/components/wizard/Step1.tsx`. The component's return starts at line 71 with `<div className="adapt-card">`, and the first child is the `<h2>` at line 73. Insert the banner as a new first child, immediately AFTER the opening `<div className="adapt-card">` and BEFORE the `<h2>` line.

Find this exact section (around lines 71–74):

```tsx
  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 1: Configure helix-gateway</h2>
```

Replace it with:

```tsx
  return (
    <div className="adapt-card">
      {!envVars.HELIX_API_KEY && (
        <a
          href="/step-zero"
          className="block rounded border border-blue-900 bg-blue-950/30 p-3 text-tiny hover:bg-blue-950/50 transition-colors mb-4"
        >
          <span className="font-semibold text-blue-200">New to OpenTelemetry?</span>{' '}
          <span className="text-blue-300/80">
            Take the Step 0 detour first — get host and container metrics flowing in two clicks, no app changes needed.
          </span>
          <span className="text-blue-200 ml-1">→</span>
        </a>
      )}
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 1: Configure helix-gateway</h2>
```

The `envVars` prop is already in Step1's Props type (line 15) — no type changes needed.

- [ ] **Step 2: Build and smoke-test**

Run: `cd /Users/jammicha/dev/HelixConfigurator/frontend && npm run build`
Expected: build succeeds.

Clear localStorage and the `.env` `HELIX_API_KEY` value. Reload the wizard. Step 1 should now show the blue banner above the form. The banner re-evaluates on every keystroke (`!envVars.HELIX_API_KEY`), so it disappears live as the user starts typing the key.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/wizard/Step1.tsx
git commit -m "feat(step-zero): 'New to OTel?' banner on Step 1

Shows a clickable banner linking to /step-zero when HELIX_API_KEY is
blank. Hides once the user starts filling Step 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: End-to-end smoke verification on a fresh install

Final acceptance check. Pretend you're a user with zero OTel installed.

**Files:**
- None. Manual verification.

- [ ] **Step 1: Fresh setup**

```bash
cd /Users/jammicha/dev/HelixConfigurator
docker compose down -v
docker compose up -d --build
```

Wait for both containers to be healthy: `docker ps` shows `helix-configurator` and `helix-gateway` Up.

- [ ] **Step 2: Walk the user flow**

In a browser:

1. Navigate to `http://localhost:8765/`. Confirm the wizard loads at Step 1.
2. Confirm the blue "New to OTel?" banner is visible.
3. Click it → land on `/step-zero`. Confirm page header and Layer 1 panel render.
4. Click "Enable host metrics". Confirm:
   - Button shows spinner for 3–10s while the gateway restarts.
   - Card flips to "Enabled — waiting for first scrape".
   - Within 30s, card turns green and shows "N metrics accepted" with N > 0.
5. Click "Enable container stats". Same observations.
6. Verify in `helix-otel-collector.yaml`:
   - `hostmetrics:` and `docker_stats:` blocks present under `receivers:`.
   - `metrics/host:` pipeline present under `service.pipelines:` with both receivers in its array.
7. Verify in `/otel-data` (or directly in Helix if a real tenant is configured) that host metrics and container metrics are visible.
8. Click "Continue to the full wizard" in the footer. Lands at `/`.
9. Confirm the wizard's "Starting from zero? →" link is visible alongside "Reset onboarding".

- [ ] **Step 3: Regression check — existing wizard untouched**

Walk Steps 1 → 2 → 3 → 4 of the existing wizard. Confirm:
- Step 1 credentials entry still works.
- Step 2 Smart-add still detects collectors and applies merges.
- Step 3 network bridging still works.
- Step 4 Send Test Trace still injects + verifies a trace successfully.

The Layer 1 receivers added in Step 0 should NOT interfere with Step 2/3/4 because they share the gateway YAML with the existing OTLP receiver — the helix-gateway just has more receivers in its config now.

- [ ] **Step 4: Failure-mode check — rollback works**

To exercise rollback, manually break the receiver config by editing `backend/routes/step-zero/yaml-helpers.js` to write an intentionally invalid value (e.g. set `collection_interval` to the empty string), rebuild the backend, click Enable on a fresh gateway. Confirm the request returns 500 with `rolledBack: true` AND the YAML on disk is unchanged. Revert the test edit before continuing.

- [ ] **Step 5: Final commit if there are leftover changes**

Run: `git status`
Expected: working tree clean (all tasks committed individually).

If anything is uncommitted, decide whether it's a fix-forward or a revert, and either commit or `git checkout --` it.

---

## Self-review checklist

Before declaring done:

- [ ] All 12 task commits land in `git log` in order.
- [ ] `cd backend && npx vitest run` passes with 0 failures.
- [ ] `cd frontend && npm run build` succeeds with 0 errors.
- [ ] `docker compose up -d` brings the stack up cleanly.
- [ ] Browser flow in Task 13 Step 2 succeeds end-to-end.
- [ ] No new files outside the paths listed in "File Structure" above.
