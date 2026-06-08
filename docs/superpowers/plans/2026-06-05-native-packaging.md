# Native Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Helix Configurator as a pre-built native package (bundled Node runtime + app) so it runs with no Docker Desktop, while teaching the configurator to create its own gateway container and splitting the demo AIOps page into a standalone project.

**Architecture:** Wrap (not rewrite) the existing Node/Express/React app. The configurator binds directly to port 8765, resolves its SQLite/state paths relative to the install dir, and — when the user picks the Docker onboarding target — creates and networks the `helix-gateway` collector itself via dockerode (replacing Docker Compose), with the local fan-out flipped to `host.docker.internal:8765`. A new GitHub Actions workflow builds per-platform zips published to GitHub Releases. A separate `helix-aiops-mock` project serves the tiny install script that downloads them.

**Tech Stack:** Node.js 22, Express 5, dockerode, better-sqlite3, js-yaml, Vite/React 19, GitHub Actions, vitest.

**Spec:** [`docs/superpowers/specs/2026-06-05-native-packaging-design.md`](../specs/2026-06-05-native-packaging-design.md)

---

## File Structure

**Configurator — modified:**
- `backend/index.js` — port binding (8765 default), native SQLite path resolution
- `backend/routes/lifecycle.js` — `createGatewayFromScratch()`, create-or-recreate entry, native `bridged-networks.json` path
- `backend/collectorFanout.js` *(new)* — shared `host.docker.internal` fan-out rewrite, reused by lifecycle.js and k8sChart
- `backend/k8sChart/transformCollectorConfig.js` — delegate its local-rewrite to `collectorFanout.js` (DRY)
- `frontend/src/main.tsx` — drop the `/aiops` route
- `Dockerfile` — set `PORT=3001` so the container keeps its `8765:3001` mapping

**Configurator — deleted:**
- `backend/routes/demo.js`, `frontend/src/components/AiopsPage.tsx`

**Configurator — new (packaging):**
- `packaging/start.command`, `packaging/start.sh`, `packaging/start.bat` — launchers
- `.github/workflows/native-release.yml` — per-platform build + GitHub Release upload
- `backend/routes/version.js` *(new)* — update-check endpoint
- `frontend/src/components/UpdateBanner.tsx` *(new)* — update banner

**New project — `helix-aiops-mock/`** (separate top-level dir or repo):
- `server.js`, `installScripts.js`, `public/index.html`, `package.json`, `__tests__/installScripts.test.mjs`

**Docs (final phase):**
- `docs/architecture/native-packaging-diagram.md` *(new)* — stakeholder diagram
- `README.md`, `docs/architecture/ARCHITECTURE.md`, `docs/COMPREHENSIVE-GUIDE.md` — reconciled

---

## Phase A — Native runtime adaptation

### Task A1: Bind to PORT (default 8765) with fail-fast on conflict

**Files:**
- Modify: `backend/index.js:18` (port const) and `backend/index.js:128-131` (listen)
- Test: `backend/__tests__/port-config.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/__tests__/port-config.test.mjs
import { describe, it, expect } from 'vitest';
import { resolvePort } from '../portConfig.js';

describe('resolvePort', () => {
  it('defaults to 8765 when PORT is unset', () => {
    expect(resolvePort({})).toBe(8765);
  });
  it('honors a numeric PORT', () => {
    expect(resolvePort({ PORT: '3001' })).toBe(3001);
  });
  it('falls back to 8765 when PORT is non-numeric', () => {
    expect(resolvePort({ PORT: 'nope' })).toBe(8765);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/port-config.test.mjs`
Expected: FAIL — `Cannot find module '../portConfig.js'`

- [ ] **Step 3: Create the implementation**

```javascript
// backend/portConfig.js
// Resolve the HTTP port. Native installs bind 8765 directly (no Docker port
// mapping); the Docker image sets PORT=3001 and keeps the host 8765:3001 map.
function resolvePort(env) {
  const raw = Number.parseInt(env.PORT, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8765;
}
module.exports = { resolvePort };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/port-config.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire it into index.js**

Replace `backend/index.js:18`:
```javascript
const { resolvePort } = require('./portConfig');
const port = resolvePort(process.env);
```

Replace the `server.listen` block at `backend/index.js:128-131` with:
```javascript
const server = app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
  console.log(`Helix Ingest Endpoint: ${process.env.HELIX_ENDPOINT || 'NOT CONFIGURED'}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is in use. Set PORT in .env to a free port and relaunch.\n`);
    process.exit(1);
  }
  throw e;
});
```

- [ ] **Step 6: Verify the full backend suite still passes**

Run: `cd backend && npx vitest run`
Expected: PASS (existing suite + new port tests)

- [ ] **Step 7: Commit**

```bash
git add backend/portConfig.js backend/__tests__/port-config.test.mjs backend/index.js
git commit -m "feat(native): bind PORT (default 8765) with fail-fast on EADDRINUSE"
```

---

### Task A2: Resolve SQLite + bridged-networks paths for the native install dir

**Files:**
- Create: `backend/statePaths.js`
- Modify: `backend/index.js:78-79`, `backend/routes/lifecycle.js:27-32`
- Test: `backend/__tests__/state-paths.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/__tests__/state-paths.test.mjs
import { describe, it, expect } from 'vitest';
import { resolveDataDir } from '../statePaths.js';

describe('resolveDataDir', () => {
  it('uses /app/data inside the container (when /app exists)', () => {
    expect(resolveDataDir({ appDirExists: true, backendDir: '/x/backend' })).toBe('/app/data');
  });
  it('uses <installRoot>/data natively (package root is backend/..)', () => {
    expect(resolveDataDir({ appDirExists: false, backendDir: '/opt/helix/backend' }))
      .toBe('/opt/helix/data');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/state-paths.test.mjs`
Expected: FAIL — `Cannot find module '../statePaths.js'`

- [ ] **Step 3: Create the implementation**

```javascript
// backend/statePaths.js
// Single source of truth for where mutable state lives. In the container the
// data/ volume is mounted at /app/data. Natively the package root is the
// parent of backend/, so state lands in <installRoot>/data alongside the binary.
const path = require('path');

function resolveDataDir({ appDirExists, backendDir }) {
  if (appDirExists) return '/app/data';
  return path.join(path.resolve(backendDir, '..'), 'data');
}
module.exports = { resolveDataDir };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/state-paths.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into index.js**

Replace `backend/index.js:78-79` with:
```javascript
const { resolveDataDir } = require('./statePaths');
const DATA_DIR = resolveDataDir({ appDirExists: fs.existsSync('/app'), backendDir: __dirname });
const OTEL_DB_PATH = process.env.OTEL_DB_PATH || path.join(DATA_DIR, 'otel-store.db');
```

- [ ] **Step 6: Wire into lifecycle.js**

Replace the `BRIDGED_NETWORKS_PATH` IIFE at `backend/routes/lifecycle.js:27-32` with:
```javascript
const { resolveDataDir } = require('../statePaths');
const BRIDGED_NETWORKS_PATH = path.join(
  resolveDataDir({ appDirExists: fs.existsSync('/app'), backendDir: path.join(__dirname, '..') }),
  'bridged-networks.json',
);
```

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/statePaths.js backend/__tests__/state-paths.test.mjs backend/index.js backend/routes/lifecycle.js
git commit -m "feat(native): resolve SQLite + state paths relative to install dir"
```

---

### Task A3: Extract the shared `host.docker.internal` fan-out rewrite

**Files:**
- Create: `backend/collectorFanout.js`
- Modify: `backend/k8sChart/transformCollectorConfig.js:48-55` (delegate)
- Test: `backend/__tests__/collector-fanout.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/__tests__/collector-fanout.test.mjs
import { describe, it, expect } from 'vitest';
import { rewriteLocalViewerToHost } from '../collectorFanout.js';

const SRC = `
exporters:
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
`;

describe('rewriteLocalViewerToHost', () => {
  it('rewrites every viewer endpoint host to host.docker.internal:8765', () => {
    const out = rewriteLocalViewerToHost(SRC);
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/traces');
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/logs');
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/metrics');
    expect(out).not.toContain('helix-configurator:3001');
  });
  it('leaves the bmchelix exporter untouched', () => {
    const out = rewriteLocalViewerToHost(SRC + '    \nexporters:\n  otlphttp/bmchelix:\n    endpoint: ${env:HELIX_ENDPOINT}\n');
    expect(out).toContain('${env:HELIX_ENDPOINT}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/collector-fanout.test.mjs`
Expected: FAIL — `Cannot find module '../collectorFanout.js'`

- [ ] **Step 3: Create the implementation**

```javascript
// backend/collectorFanout.js
// Shared rewrite: point the local-viewer exporter at the configurator running
// on the host. Used by BOTH the native-Docker gateway path (configurator on the
// host, gateway in a container) and the K8s local-cluster path. Operating on the
// parsed doc keeps it robust to formatting; callers pass YAML text in/out.
const yaml = require('js-yaml');

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';
const LOCAL_VIEWER_HOST = 'host.docker.internal:8765';

function rewriteLocalViewerToHost(yamlString) {
  const doc = yaml.load(yamlString);
  if (!doc || typeof doc !== 'object') return yamlString;
  const viewer = (doc.exporters || {})[VIEWER_EXPORTER_KEY];
  if (viewer) {
    for (const key of ['traces_endpoint', 'logs_endpoint', 'metrics_endpoint']) {
      if (typeof viewer[key] === 'string') {
        viewer[key] = viewer[key].replace(/^https?:\/\/[^/]+/, `http://${LOCAL_VIEWER_HOST}`);
      }
    }
  }
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}
module.exports = { rewriteLocalViewerToHost, VIEWER_EXPORTER_KEY, LOCAL_VIEWER_HOST };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/collector-fanout.test.mjs`
Expected: PASS

- [ ] **Step 5: DRY — delegate the k8s transform's local rewrite**

In `backend/k8sChart/transformCollectorConfig.js`, replace the inline `for` loop in the `target === 'local'` branch (lines 49-55) with a shared constant import. At the top, add:
```javascript
const { LOCAL_VIEWER_HOST } = require('../collectorFanout');
```
Replace the literal `const LOCAL_VIEWER_HOST = 'host.docker.internal:8765';` at line 13 with that import (delete the local const). The existing loop already uses `LOCAL_VIEWER_HOST`, so behavior is identical — this just removes the duplicated constant.

- [ ] **Step 6: Run the k8sChart suite to confirm no regression**

Run: `cd backend && npx vitest run __tests__/k8sChart-transform.test.mjs __tests__/collector-fanout.test.mjs`
Expected: PASS (both suites)

- [ ] **Step 7: Commit**

```bash
git add backend/collectorFanout.js backend/__tests__/collector-fanout.test.mjs backend/k8sChart/transformCollectorConfig.js
git commit -m "refactor(native): extract shared host.docker.internal fan-out rewrite"
```

---

## Phase B — Gateway creation (the real work)

### Task B1: Build the gateway container spec from `.env`

**Files:**
- Create: `backend/routes/gatewaySpec.js`
- Test: `backend/__tests__/gateway-spec.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/__tests__/gateway-spec.test.mjs
import { describe, it, expect } from 'vitest';
import { buildGatewayCreateSpec } from '../routes/gatewaySpec.js';

describe('buildGatewayCreateSpec', () => {
  const env = ['HELIX_ENDPOINT=https://t.onbmc.com', 'HELIX_API_KEY=k::a::s', 'X_SOURCE=svc'];
  const spec = buildGatewayCreateSpec({ name: 'helix-gateway', env, configHostPath: '/opt/helix/helix-otel-collector.yaml' });

  it('uses the contrib collector image', () => {
    expect(spec.Image).toBe('otel/opentelemetry-collector-contrib:latest');
  });
  it('publishes 4317, 4318, 8888 to the host', () => {
    expect(spec.HostConfig.PortBindings['4317/tcp']).toEqual([{ HostPort: '4317' }]);
    expect(spec.HostConfig.PortBindings['4318/tcp']).toEqual([{ HostPort: '4318' }]);
    expect(spec.HostConfig.PortBindings['8888/tcp']).toEqual([{ HostPort: '8888' }]);
  });
  it('mounts the collector yaml read-only at the contrib config path', () => {
    expect(spec.HostConfig.Binds).toContain('/opt/helix/helix-otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro');
  });
  it('passes the env array through', () => {
    expect(spec.Env).toEqual(env);
  });
  it('attaches the helix-bridge network', () => {
    expect(spec.HostConfig.NetworkMode).toBe('helix-bridge');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/gateway-spec.test.mjs`
Expected: FAIL — `Cannot find module '../routes/gatewaySpec.js'`

- [ ] **Step 3: Create the implementation**

```javascript
// backend/routes/gatewaySpec.js
// Pure builder for the dockerode createContainer spec that stands up the
// gateway from scratch — the job docker-compose.yml does in the container path.
// Mirrors docker-compose.yml: contrib collector, ports 4317/4318/8888 published,
// collector yaml mounted, env from .env, on the helix-bridge network.
const GATEWAY_IMAGE = 'otel/opentelemetry-collector-contrib:latest';

function buildGatewayCreateSpec({ name, env, configHostPath }) {
  return {
    name,
    Image: GATEWAY_IMAGE,
    Env: env,
    ExposedPorts: { '4317/tcp': {}, '4318/tcp': {}, '8888/tcp': {} },
    HostConfig: {
      NetworkMode: 'helix-bridge',
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: [`${configHostPath}:/etc/otelcol-contrib/config.yaml:ro`],
      PortBindings: {
        '4317/tcp': [{ HostPort: '4317' }],
        '4318/tcp': [{ HostPort: '4318' }],
        '8888/tcp': [{ HostPort: '8888' }],
      },
    },
  };
}
module.exports = { buildGatewayCreateSpec, GATEWAY_IMAGE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/gateway-spec.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/routes/gatewaySpec.js backend/__tests__/gateway-spec.test.mjs
git commit -m "feat(native): pure builder for from-scratch gateway container spec"
```

---

### Task B2: `createGatewayFromScratch()` — pull, network, create, start

**Files:**
- Modify: `backend/routes/lifecycle.js` (add the function + export for test)
- Test: `backend/__tests__/create-gateway.test.mjs`

- [ ] **Step 1: Write the failing test** (dockerode fully mocked)

```javascript
// backend/__tests__/create-gateway.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createGatewayFromScratch } from '../routes/lifecycle.js';

function mockDocker() {
  const calls = { pulled: false, networkCreated: false, started: false, createArgs: null };
  const fakeContainer = { start: vi.fn(async () => { calls.started = true; }) };
  return {
    calls,
    pull: vi.fn((img, cb) => { calls.pulled = img; cb(null, { resume() {} }); }),
    modem: { followProgress: (s, done) => done(null) },
    createNetwork: vi.fn(async () => { calls.networkCreated = true; }),
    createContainer: vi.fn(async (spec) => { calls.createArgs = spec; return fakeContainer; }),
    getImage: () => ({ inspect: vi.fn(async () => { throw { statusCode: 404 }; }) }),
  };
}

describe('createGatewayFromScratch', () => {
  it('pulls the image, ensures the network, creates and starts the gateway', async () => {
    const docker = mockDocker();
    await createGatewayFromScratch(docker, {
      name: 'helix-gateway',
      env: ['X_SOURCE=svc'],
      configHostPath: '/opt/helix/helix-otel-collector.yaml',
    });
    expect(docker.calls.pulled).toBe('otel/opentelemetry-collector-contrib:latest');
    expect(docker.calls.networkCreated).toBe(true);
    expect(docker.calls.createArgs.Image).toBe('otel/opentelemetry-collector-contrib:latest');
    expect(docker.calls.started).toBe(true);
  });

  it('tolerates an already-existing network (409)', async () => {
    const docker = mockDocker();
    docker.createNetwork = vi.fn(async () => { const e = new Error('exists'); e.statusCode = 409; throw e; });
    await expect(createGatewayFromScratch(docker, {
      name: 'helix-gateway', env: [], configHostPath: '/x.yaml',
    })).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/create-gateway.test.mjs`
Expected: FAIL — `createGatewayFromScratch is not a function`

- [ ] **Step 3: Implement in lifecycle.js**

Add near the top of `backend/routes/lifecycle.js` (after the existing requires):
```javascript
const { buildGatewayCreateSpec, GATEWAY_IMAGE } = require('./gatewaySpec');

// Pull an image and wait for completion. dockerode's pull is callback+stream
// based; followProgress resolves when the layered pull finishes.
function pullImage(docker, image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (doneErr) => doneErr ? reject(doneErr) : resolve());
    });
  });
}

// Create the gateway container from scratch — the job docker-compose does in
// the container path. Used on the first Docker-target commit when no gateway
// exists yet. After this, recreateGateway() handles subsequent env edits.
async function createGatewayFromScratch(docker, { name, env, configHostPath }) {
  // Pull only if absent (offline-friendly; image may already be local).
  try {
    await docker.getImage(GATEWAY_IMAGE).inspect();
  } catch (e) {
    if (e.statusCode === 404) await pullImage(docker, GATEWAY_IMAGE);
    else throw e;
  }
  try {
    await docker.createNetwork({ Name: 'helix-bridge' });
  } catch (e) {
    if (e.statusCode !== 409) throw e; // 409 = already exists
  }
  const spec = buildGatewayCreateSpec({ name, env, configHostPath });
  const container = await docker.createContainer(spec);
  await container.start();
}
```

Add to the `module.exports` at the bottom of the file:
```javascript
module.exports = { register, createGatewayFromScratch };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/create-gateway.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/routes/lifecycle.js backend/__tests__/create-gateway.test.mjs
git commit -m "feat(native): createGatewayFromScratch (pull, network, create, start)"
```

---

### Task B3: Make Step 1's commit create-or-recreate the gateway

**Files:**
- Modify: `backend/routes/lifecycle.js` — the `/api/lifecycle/bridge` handler (around line 263)
- Modify: `backend/routes/lifecycle.js` — `register(app, { docker })` to thread the config path
- Modify: `backend/index.js:120-125` — pass `configPath` into the lifecycle register call (currently lifecycle.register only gets `{ docker }`)
- Test: `backend/__tests__/bridge-create-or-recreate.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/__tests__/bridge-create-or-recreate.test.mjs
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import lifecycle from '../routes/lifecycle.js';

function makeApp({ gatewayExists }) {
  const created = { fromScratch: false };
  const docker = {
    getContainer: () => ({
      inspect: vi.fn(async () => {
        if (gatewayExists) return { Config: { Image: 'img', Env: [] }, HostConfig: {}, NetworkSettings: { Networks: {} } };
        const e = new Error('no such container'); e.statusCode = 404; throw e;
      }),
      stop: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    }),
    createContainer: vi.fn(async () => ({ start: vi.fn(async () => { created.fromScratch = true; }) })),
    createNetwork: vi.fn(async () => {}),
    getImage: () => ({ inspect: vi.fn(async () => ({})) }), // image present → no pull
    getNetwork: () => ({ connect: vi.fn(async () => {}) }),
  };
  const app = express();
  app.use(express.json());
  lifecycle.register(app, { docker, configPath: '/opt/helix/helix-otel-collector.yaml' });
  return { app, created };
}

describe('POST /api/lifecycle/bridge', () => {
  it('creates from scratch when no gateway exists', async () => {
    const { app, created } = makeApp({ gatewayExists: false });
    const res = await request(app).post('/api/lifecycle/bridge').send({});
    expect(res.status).toBe(200);
    expect(created.fromScratch).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/bridge-create-or-recreate.test.mjs`
Expected: FAIL — handler still calls `recreateGateway` unconditionally and throws on the 404 inspect.

- [ ] **Step 3: Update `register` signature and the bridge handler**

Change the register signature at `backend/routes/lifecycle.js:212`:
```javascript
function register(app, { docker, configPath }) {
```

Replace the body of the `/api/lifecycle/bridge` handler (the `try { await recreateGateway(...) }` block, lines ~274-282) with create-or-recreate logic:
```javascript
    // Create-or-recreate: native installs have no compose, so on the first
    // Docker-target commit there is no gateway to inspect — create it from
    // scratch. Subsequent commits hit recreateGateway (env refresh).
    let gatewayExists = true;
    try {
      await docker.getContainer(sidecarName).inspect();
    } catch (e) {
      if (e.statusCode === 404) gatewayExists = false;
      else return res.status(500).json({ error: 'Failed to inspect gateway', details: e.message });
    }
    try {
      if (gatewayExists) {
        await recreateGateway(docker, sidecarName);
      } else {
        const env = (await readEnvAsArray()) || [];
        await createGatewayFromScratch(docker, { name: sidecarName, env, configHostPath: configPath });
      }
    } catch (e) {
      return res.status(500).json({
        error: 'Gateway create/recreate failed — env changes may not have taken effect',
        details: e.message,
      });
    }
    res.json({ message: gatewayExists ? 'Gateway recreated with updated environment' : 'Gateway created' });
```

> Note: `createGatewayFromScratch` is defined in this same module (Task B2) — call it directly, no import needed. `sidecarName` is already in scope from the handler's first line.

- [ ] **Step 4: Thread `configPath` from index.js**

Replace `backend/index.js:120-125`'s lifecycle registration. The current line is:
```javascript
require('./routes/lifecycle').register(app, { docker });
```
Change to:
```javascript
require('./routes/lifecycle').register(app, { docker, configPath: CONFIG_PATH });
```
(`CONFIG_PATH` is already defined at index.js:24.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/bridge-create-or-recreate.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/routes/lifecycle.js backend/index.js backend/__tests__/bridge-create-or-recreate.test.mjs
git commit -m "feat(native): Step 1 commit creates the gateway when none exists"
```

---

### Task B4: Apply the host fan-out rewrite when creating the gateway natively

**Files:**
- Modify: `backend/routes/lifecycle.js` — `createGatewayFromScratch` writes the rewritten yaml
- Test: extend `backend/__tests__/create-gateway.test.mjs`

- [ ] **Step 1: Add a failing assertion**

Append to `backend/__tests__/create-gateway.test.mjs`:
```javascript
import { rewriteLocalViewerToHost } from '../collectorFanout.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('createGatewayFromScratch — host fan-out', () => {
  it('rewrites the on-disk collector yaml to host.docker.internal before create', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-cfg-'));
    const cfg = path.join(dir, 'helix-otel-collector.yaml');
    fs.writeFileSync(cfg, `exporters:\n  otlphttp/helix_local_viewer:\n    traces_endpoint: http://helix-configurator:3001/api/otlp/traces\n`);
    const docker = mockDocker();
    await createGatewayFromScratch(docker, { name: 'helix-gateway', env: [], configHostPath: cfg });
    expect(fs.readFileSync(cfg, 'utf8')).toContain('host.docker.internal:8765');
  });
});
```
> `mockDocker` is defined earlier in this file; vitest hoists `describe` blocks in-module so it is in scope.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/create-gateway.test.mjs`
Expected: FAIL — yaml still contains `helix-configurator:3001`.

- [ ] **Step 3: Rewrite the yaml inside `createGatewayFromScratch`**

In `backend/routes/lifecycle.js`, add the require near the top:
```javascript
const { rewriteLocalViewerToHost } = require('../collectorFanout');
```
In `createGatewayFromScratch`, immediately before building the spec, add:
```javascript
  // Configurator runs on the host, gateway in a container — flip the local
  // fan-out target to host.docker.internal so traces reach the host viewer.
  try {
    const current = await fsp.readFile(configHostPath, 'utf8');
    await fsp.writeFile(configHostPath, rewriteLocalViewerToHost(current));
  } catch (e) {
    console.warn('createGatewayFromScratch: yaml host-rewrite skipped:', e.message);
  }
```
(`fsp` is already required at lifecycle.js:9.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/create-gateway.test.mjs`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add backend/routes/lifecycle.js backend/__tests__/create-gateway.test.mjs
git commit -m "feat(native): rewrite collector fan-out to host.docker.internal on create"
```

---

## Phase C — Demo / tunnel cleanup

### Task C1: Remove the backend demo module and its registration

**Files:**
- Delete: `backend/routes/demo.js`
- Modify: `backend/index.js` — drop demo require/registration, `IS_DEMO_INSTALL`, `trust proxy`, and `computeInstallBaseUrl`
- Modify: `backend/util.js` — remove `computeInstallBaseUrl`
- Modify: `backend/package.json` — drop `marked`

- [ ] **Step 1: Confirm marked has no other consumer**

Run: `cd backend && grep -rn "require('marked')" . --include=*.js | grep -v node_modules`
Expected: only `routes/demo.js` (which we are deleting). If anything else appears, stop and keep `marked`.

- [ ] **Step 2: Delete demo.js**

```bash
git rm backend/routes/demo.js
```

- [ ] **Step 3: Excise demo wiring from index.js**

Remove these from `backend/index.js`:
- The `trust proxy` line (index.js:22) and its comment block (19-22).
- The `demoInstallEnabled` const (index.js:69) — replace `demoInstall: demoInstallEnabled` in the health payload (index.js:72) with `demoInstall: false`.
- The whole `if (demoInstallEnabled) { require('./routes/demo')... }` block (index.js:94-96).

- [ ] **Step 4: Remove computeInstallBaseUrl from util.js**

Run: `cd backend && grep -n "computeInstallBaseUrl" util.js` to find its definition + export, then delete the function body and its entry in `module.exports`.

- [ ] **Step 5: Drop the marked dependency**

Edit `backend/package.json` — remove the `"marked": "^18.0.5",` line from `dependencies`.

- [ ] **Step 6: Reinstall and run the suite**

Run: `cd backend && npm install && npx vitest run`
Expected: PASS. (If a test referenced demo routes, it will fail — note it for C3.)

- [ ] **Step 7: Boot the server to confirm clean startup**

Run: `cd backend && node -e "process.env.OTEL_DB_PATH=require('os').tmpdir()+'/t.db'; require('./index.js'); setTimeout(()=>process.exit(0), 800);"`
Expected: prints "Backend listening" with no demo references and no throw.

- [ ] **Step 8: Commit**

```bash
git add backend/index.js backend/util.js backend/package.json backend/package-lock.json
git commit -m "chore(native): remove demo routes, tunnel awareness, marked dep"
```

---

### Task C2: Remove the AiopsPage frontend and its route

**Files:**
- Delete: `frontend/src/components/AiopsPage.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `backend/index.js` — drop the `/aiops` SPA fallback (index.js:41-43)

- [ ] **Step 1: Delete the component**

```bash
git rm frontend/src/components/AiopsPage.tsx
```

- [ ] **Step 2: Drop the route from main.tsx**

Edit `frontend/src/main.tsx` to remove the `AiopsPage` import (line 4), the `isAiops` const (line 11), and the `isAiops ? <AiopsPage /> :` branch (line 18). Result:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { OtelDataPage } from './components/OtelDataPage'
import { StepZero } from './components/step-zero/StepZero'
import { DashboardMockup } from './components/dashboard/DashboardMockup'
import './index.css'

const path = window.location.pathname
const isOtelData = path.startsWith('/otel-data')
const isStepZero = path.startsWith('/step-zero')
const isDashboardMockup = path.startsWith('/dashboard-mockup')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOtelData ? <OtelDataPage /> :
     isStepZero ? <StepZero /> :
     isDashboardMockup ? <DashboardMockup /> :
     <App />}
  </React.StrictMode>,
)
```

- [ ] **Step 3: Drop the backend `/aiops` SPA fallback**

Remove the `app.get(/^\/aiops(\/.*)?$/, ...)` block at `backend/index.js:41-43`.

- [ ] **Step 4: Grep for stray AiopsPage references**

Run: `grep -rn "AiopsPage\|/aiops" frontend/src backend --include=*.ts --include=*.tsx --include=*.js | grep -v node_modules`
Expected: no results.

- [ ] **Step 5: Type-check the frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/main.tsx backend/index.js
git commit -m "chore(native): remove /aiops page and route"
```

---

### Task C3: Remove demo-coupled tests and assertions

**Files:**
- Delete/adjust: any test under `backend/__tests__/` that imports demo.js or asserts demo behavior

- [ ] **Step 1: Find demo-coupled tests**

Run: `grep -rln "demo\|_demo/aiops\|computeInstallBaseUrl" backend/__tests__ backend/*.test.js`
Expected: a list (may be empty). For each hit, open it and decide: delete if the file is wholly about demo install; otherwise remove only the demo-specific cases.

- [ ] **Step 2: Remove them**

For wholly-demo test files: `git rm <file>`. For mixed files: delete the demo `it(...)`/`describe(...)` blocks only.

- [ ] **Step 3: Run the full suite**

Run: `cd backend && npx vitest run`
Expected: PASS with no demo references.

- [ ] **Step 4: Commit**

```bash
git add -A backend/__tests__
git commit -m "test(native): drop demo-coupled tests"
```

---

## Phase D — Build, launchers & release

### Task D1: Native launcher scripts

**Files:**
- Create: `packaging/start.command`, `packaging/start.sh`, `packaging/start.bat`

- [ ] **Step 1: Create the macOS/Linux launchers**

`packaging/start.sh` and `packaging/start.command` share this body (the `.command` extension is what lets Finder run it on double-click):
```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Starting Helix OTel Configurator..."
./node backend/index.js &
SERVER_PID=$!
deadline=$(( $(date +%s) + 30 ))
URL="http://localhost:${PORT:-8765}"
while [ $(date +%s) -lt $deadline ]; do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    if [ "$(uname)" = "Darwin" ]; then open "$URL?view=onboarding"
    elif [ -n "$DISPLAY" ] && command -v xdg-open >/dev/null 2>&1; then (xdg-open "$URL?view=onboarding" >/dev/null 2>&1 &)
    fi
    break
  fi
  sleep 1
done
echo "Configurator UI: $URL"
wait $SERVER_PID
```

- [ ] **Step 2: Create the Windows launcher**

`packaging/start.bat`:
```bat
@echo off
setlocal
cd /d "%~dp0"
echo Starting Helix OTel Configurator...
start "" /b node.exe backend\index.js
set "URL=http://localhost:8765"
set /a "_w=0"
:wait
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 ( start "" "%URL%?view=onboarding" & goto :ready )
set /a "_w+=1"
if %_w% geq 30 goto :ready
timeout /t 1 /nobreak >nul
goto :wait
:ready
echo Configurator UI: %URL%
```

- [ ] **Step 3: Mark the shell scripts executable**

```bash
chmod +x packaging/start.sh packaging/start.command
```

- [ ] **Step 4: Smoke-test the Unix launcher against the local backend**

Run (from a checkout with `backend/node_modules` present): copy the launcher logic by hand — `cd backend && node index.js &` then `curl -fsS http://localhost:8765/api/health`.
Expected: `{"ok":true,...}`.

- [ ] **Step 5: Commit**

```bash
git add packaging/
git commit -m "feat(native): platform launcher scripts"
```

---

### Task D2: GitHub Actions native-release workflow

**Files:**
- Create: `.github/workflows/native-release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/native-release.yml
name: Native release
on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: write   # create releases + upload assets

jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: macos-latest,   platform: darwin-arm64, nodearch: arm64 }
          - { os: macos-13,       platform: darwin-amd64, nodearch: x64   }
          - { os: ubuntu-latest,  platform: linux-amd64,  nodearch: x64   }
          - { os: windows-latest, platform: windows-amd64, nodearch: x64  }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v4
        with: { node-version: '22' }

      - name: Build frontend
        run: cd frontend && npm ci && npm run build

      - name: Install backend prod deps (native addons)
        run: cd backend && npm ci --omit=dev

      - name: Stage package
        shell: bash
        run: |
          set -e
          STAGE="helix-configurator"
          rm -rf "$STAGE" && mkdir -p "$STAGE/data"
          cp -R backend "$STAGE/backend"
          cp -R frontend/dist "$STAGE/frontend-dist"
          cp -R templates "$STAGE/templates"
          cp -R helix-otel "$STAGE/helix-otel"
          cp helix-otel-collector.yaml "$STAGE/helix-otel-collector.yaml"
          # Bundle the matching Node runtime
          node -e "const v=process.version;console.log(v)"
          NODE_DIR="$(dirname "$(command -v node)")"
          if [ "${{ runner.os }}" = "Windows" ]; then cp "$NODE_DIR/node.exe" "$STAGE/node.exe";
          else cp "$NODE_DIR/node" "$STAGE/node"; fi
          # Launchers
          cp packaging/start.sh "$STAGE/" 2>/dev/null || true
          cp packaging/start.command "$STAGE/" 2>/dev/null || true
          cp packaging/start.bat "$STAGE/" 2>/dev/null || true
          chmod +x "$STAGE/start.sh" "$STAGE/start.command" 2>/dev/null || true

      - name: Zip
        shell: bash
        run: |
          ZIP="helix-configurator-${{ matrix.platform }}.zip"
          if [ "${{ runner.os }}" = "Windows" ]; then 7z a "$ZIP" helix-configurator > /dev/null;
          else zip -ry "$ZIP" helix-configurator > /dev/null; fi

      - name: Upload to release
        uses: softprops/action-gh-release@v2
        with:
          files: helix-configurator-${{ matrix.platform }}.zip
          fail_on_unmatched_files: true
          prerelease: false   # latest/download/ must resolve to this release
```

- [ ] **Step 2: Lint the YAML locally**

Run: `cd /Users/jammicha/dev/HelixConfigurator/.worktrees/brainstorm-native-packaging && node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/native-release.yml','utf8')); console.log('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/native-release.yml
git commit -m "ci(native): per-platform build + GitHub Release upload"
```

> **Manual validation (post-merge, can't be unit-tested):** push a `v*` tag, confirm four assets attach to the Release, download one on a Docker-free machine, extract, run the launcher → configurator answers on `:8765`. Confirm `better-sqlite3` loads on each platform.

---

### Task D3: Keep the Docker image binding container port 3001

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Pin PORT in the image**

The native default is 8765, but the published Docker image relies on a `8765:3001` host mapping (docker-compose.yml:18). Add to `Dockerfile` just before `EXPOSE 3001`:
```dockerfile
ENV PORT=3001
```

- [ ] **Step 2: Build the image to confirm it still boots**

Run: `docker build -t helix-configurator:porttest . && docker run --rm -e OTEL_DB_PATH=/tmp/t.db -p 8765:3001 -d --name pt helix-configurator:porttest && sleep 3 && curl -fsS http://localhost:8765/api/health && docker rm -f pt`
Expected: `{"ok":true,...}`

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "fix(docker): pin PORT=3001 so the image keeps its 8765:3001 mapping"
```

---

## Phase E — Mock AIOps project

### Task E1: Scaffold `helix-aiops-mock`

**Files:**
- Create: `helix-aiops-mock/package.json`, `helix-aiops-mock/server.js`

- [ ] **Step 1: package.json**

```json
{
  "name": "helix-aiops-mock",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": { "start": "node server.js", "test": "vitest run" },
  "dependencies": { "express": "^5.2.1" },
  "devDependencies": { "vitest": "^4.1.8", "supertest": "^7.2.2" }
}
```

- [ ] **Step 2: server.js (session store + routes)**

```javascript
// helix-aiops-mock/server.js
// Standalone local mock of the BMC Helix "Manage OTel" page. Mints a demo
// session and serves a tiny install script that downloads the pre-built native
// package from GitHub Releases. Hosts no packages itself. No tunnel.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { renderBashInstaller, renderPowerShellInstaller } = require('./installScripts');

const PORT = Number.parseInt(process.env.PORT, 10) || 9000;
const REPO = process.env.RELEASES_REPO || 'jammicha/HelixConfigurator';
const SIMULATED_ENDPOINT = 'https://your-tenant.onbmc.com';
const TTL_MS = 60 * 60 * 1000;

const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.createdAt > TTL_MS) sessions.delete(t);
}, 10 * 60 * 1000).unref();

const fakeKey = () => `FAKE-KEY-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/configure', (req, res) => {
  const xSource = (req.body && req.body.xSource || '').trim();
  if (!xSource) return res.status(400).json({ error: 'xSource is required' });
  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { xSource, apiKey: fakeKey(), endpoint: SIMULATED_ENDPOINT, createdAt: Date.now() });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    token,
    sh: `curl -fsSL ${base}/install/${token}.sh | bash`,
    ps1: `iwr ${base}/install/${token}.ps1 | iex`,
  });
});

app.get('/install/:token.sh', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s) return res.status(404).type('text/plain').send('# session expired\nexit 1\n');
  res.type('text/x-shellscript').send(renderBashInstaller({ session: s, repo: REPO }));
});

app.get('/install/:token.ps1', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s) return res.status(404).type('text/plain').send('# session expired\nexit 1\n');
  res.type('text/plain').send(renderPowerShellInstaller({ session: s, repo: REPO }));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`helix-aiops-mock on http://localhost:${PORT}`));
}
module.exports = { app, sessions };
```

- [ ] **Step 3: Install deps**

Run: `cd helix-aiops-mock && npm install`
Expected: installs express + dev deps.

- [ ] **Step 4: Commit**

```bash
git add helix-aiops-mock/package.json helix-aiops-mock/server.js helix-aiops-mock/package-lock.json
git commit -m "feat(mock): scaffold helix-aiops-mock server + session store"
```

---

### Task E2: Install-script renderers (TDD)

**Files:**
- Create: `helix-aiops-mock/installScripts.js`
- Test: `helix-aiops-mock/__tests__/installScripts.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// helix-aiops-mock/__tests__/installScripts.test.mjs
import { describe, it, expect } from 'vitest';
import { renderBashInstaller, renderPowerShellInstaller } from '../installScripts.js';

const session = { xSource: 'cart svc', apiKey: 'FAKE-KEY-AB', endpoint: 'https://t.onbmc.com' };
const repo = 'jammicha/HelixConfigurator';

describe('renderBashInstaller', () => {
  const sh = renderBashInstaller({ session, repo });
  it('detects platform and builds the latest/download URL', () => {
    expect(sh).toContain('releases/latest/download/helix-configurator-');
    expect(sh).toContain('github.com/jammicha/HelixConfigurator');
  });
  it('templates a sanitized X_SOURCE and the api key into .env', () => {
    expect(sh).toContain('X_SOURCE=cart-svc');           // spaces sanitized
    expect(sh).toContain('HELIX_API_KEY=FAKE-KEY-AB');
    expect(sh).toContain('HELIX_ENDPOINT=https://t.onbmc.com');
  });
  it('does NOT require docker', () => {
    expect(sh).not.toMatch(/docker (info|compose)/);
  });
});

describe('renderPowerShellInstaller', () => {
  const ps = renderPowerShellInstaller({ session, repo });
  it('maps arch to the windows-amd64 asset', () => {
    expect(ps).toContain('helix-configurator-windows-amd64.zip');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd helix-aiops-mock && npx vitest run __tests__/installScripts.test.mjs`
Expected: FAIL — `Cannot find module '../installScripts.js'`

- [ ] **Step 3: Implement the renderers**

```javascript
// helix-aiops-mock/installScripts.js
// Render the platform install one-liners. They detect the platform, download
// the matching pre-built zip from GitHub Releases (static latest/download URL),
// write the templated .env, and launch — no Docker required.
const sanitize = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-');
const base = (repo) => `https://github.com/${repo}/releases/latest/download`;

function renderBashInstaller({ session, repo }) {
  const x = sanitize(session.xSource);
  return `#!/usr/bin/env bash
set -e
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac
PLATFORM="$OS-$ARCH"
TARGET="$(pwd)/helix-configurator-${x}"
echo "Installing Helix Configurator ($PLATFORM) into $TARGET"
mkdir -p "$TARGET" && cd "$TARGET"
curl -fsSL "${base(repo)}/helix-configurator-$PLATFORM.zip" -o pkg.zip
unzip -oq pkg.zip && rm pkg.zip
cd helix-configurator
# Write templated config only on first install (preserve real creds on re-run).
if [ ! -s .env ] || grep -q 'placeholder' .env 2>/dev/null; then
cat > .env <<'ENVEOF'
HELIX_ENDPOINT=${session.endpoint}
HELIX_API_KEY=${session.apiKey}
X_SOURCE=${x}
BUSINESS_SERVICE_KEY=
PORT=8765
ENVEOF
fi
chmod +x ./node ./start.sh ./start.command 2>/dev/null || true
[ "$(uname)" = "Darwin" ] && ./start.command || ./start.sh
`;
}

function renderPowerShellInstaller({ session, repo }) {
  const x = sanitize(session.xSource);
  return `$ErrorActionPreference='Stop'
$Platform='windows-amd64'
$Target=Join-Path $PWD.Path "helix-configurator-${x}"
Write-Host "Installing Helix Configurator ($Platform) into $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null; Set-Location $Target
Invoke-WebRequest -UseBasicParsing -Uri "${base(repo)}/helix-configurator-$Platform.zip" -OutFile pkg.zip
Expand-Archive -Force -Path pkg.zip -DestinationPath .; Remove-Item pkg.zip
Set-Location helix-configurator
if (-not (Test-Path .env) -or (Select-String -Path .env -Pattern 'placeholder' -Quiet)) {
@"
HELIX_ENDPOINT=${session.endpoint}
HELIX_API_KEY=${session.apiKey}
X_SOURCE=${x}
BUSINESS_SERVICE_KEY=
PORT=8765
"@ | Set-Content .env
}
.\\start.bat
`;
}
module.exports = { renderBashInstaller, renderPowerShellInstaller };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd helix-aiops-mock && npx vitest run __tests__/installScripts.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add helix-aiops-mock/installScripts.js helix-aiops-mock/__tests__/installScripts.test.mjs
git commit -m "feat(mock): install-script renderers pointing at GitHub Releases latest"
```

---

### Task E3: Mock UI page

**Files:**
- Create: `helix-aiops-mock/public/index.html`

- [ ] **Step 1: Minimal "Manage OTel" form**

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Manage OpenTelemetry — Helix AIOps (mock)</title>
<style>body{font:15px/1.5 system-ui;max-width:680px;margin:40px auto;padding:0 16px;background:#10141c;color:#e6e8ee}
input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #2a3140;background:#1b1f29;color:inherit}
button{background:#3759d8;border-color:#3759d8;cursor:pointer}pre{background:#0b0e14;padding:12px;border-radius:8px;overflow:auto}
.card{background:#161b24;border:1px solid #2a3140;border-radius:10px;padding:20px;margin-top:16px}</style></head>
<body>
<h1>Manage OpenTelemetry <span style="opacity:.5">(mock)</span></h1>
<p>Enter your service name to generate an API key and install command.</p>
<div class="card">
  <label>Service / source name<br><input id="x" placeholder="my-service" style="width:100%"></label>
  <p><button id="go">Generate install command</button></p>
  <div id="out" hidden>
    <p><b>macOS / Linux</b></p><pre id="sh"></pre>
    <p><b>Windows (PowerShell)</b></p><pre id="ps"></pre>
  </div>
</div>
<script>
document.getElementById('go').onclick = async () => {
  const xSource = document.getElementById('x').value.trim(); if(!xSource) return;
  const r = await fetch('/configure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({xSource})});
  const j = await r.json(); document.getElementById('sh').textContent=j.sh;
  document.getElementById('ps').textContent=j.ps1; document.getElementById('out').hidden=false;
};
</script></body></html>
```

- [ ] **Step 2: Manually verify the flow**

Run: `cd helix-aiops-mock && node server.js` then open `http://localhost:9000`, enter a name, click Generate.
Expected: two install one-liners render, the `.sh` URL contains `/install/<token>.sh`.

- [ ] **Step 3: Commit**

```bash
git add helix-aiops-mock/public/index.html
git commit -m "feat(mock): Manage OTel form UI"
```

---

## Phase F — Update banner

### Task F1: Backend update-check endpoint

**Files:**
- Create: `backend/routes/version.js`
- Modify: `backend/index.js` — register it (public, before the auth gate)
- Test: `backend/__tests__/version-route.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// backend/__tests__/version-route.test.mjs
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import version from '../routes/version.js';

describe('GET /api/version', () => {
  it('reports current vs latest and whether an update exists', async () => {
    const app = express();
    version.register(app, { current: '1.0.5', fetchLatestTag: vi.fn(async () => 'v1.1.0') });
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('1.0.5');
    expect(res.body.latest).toBe('1.1.0');
    expect(res.body.updateAvailable).toBe(true);
  });
  it('degrades to updateAvailable=false when the check fails', async () => {
    const app = express();
    version.register(app, { current: '1.0.5', fetchLatestTag: vi.fn(async () => { throw new Error('offline'); }) });
    const res = await request(app).get('/api/version');
    expect(res.body.updateAvailable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run __tests__/version-route.test.mjs`
Expected: FAIL — `Cannot find module '../routes/version.js'`

- [ ] **Step 3: Implement**

```javascript
// backend/routes/version.js
// Public update-check. Compares the embedded version to the latest GitHub
// release tag. Best-effort: any failure → updateAvailable:false (offline-safe).
const REPO = process.env.RELEASES_REPO || 'jammicha/HelixConfigurator';

async function defaultFetchLatestTag() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'accept': 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`github ${r.status}`);
  const j = await r.json();
  return j.tag_name;
}

const normalize = (t) => String(t || '').replace(/^v/, '');

function register(app, { current, fetchLatestTag = defaultFetchLatestTag } = {}) {
  app.get('/api/version', async (req, res) => {
    let latest = null, updateAvailable = false;
    try {
      latest = normalize(await fetchLatestTag());
      updateAvailable = !!latest && latest !== normalize(current);
    } catch { /* offline-safe */ }
    res.json({ current: normalize(current), latest, updateAvailable });
  });
}
module.exports = { register };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run __tests__/version-route.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Register it in index.js (public, before the auth gate)**

After the `/api/health` route (index.js:73), add:
```javascript
require('./routes/version').register(app, { current: VERSION });
```
(`VERSION` is already defined at index.js:10.)

- [ ] **Step 6: Run the full suite**

Run: `cd backend && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/routes/version.js backend/__tests__/version-route.test.mjs backend/index.js
git commit -m "feat(native): public /api/version update-check endpoint"
```

---

### Task F2: Frontend update banner

**Files:**
- Create: `frontend/src/components/UpdateBanner.tsx`
- Modify: `frontend/src/App.tsx` — render `<UpdateBanner />` near the top

- [ ] **Step 1: Component**

```tsx
// frontend/src/components/UpdateBanner.tsx
import { useEffect, useState } from 'react'

type V = { current: string; latest: string | null; updateAvailable: boolean }

export function UpdateBanner() {
  const [v, setV] = useState<V | null>(null)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(setV).catch(() => {})
  }, [])
  if (!v?.updateAvailable || dismissed) return null
  return (
    <div style={{ background: '#3759d8', color: '#fff', padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>Update available: v{v.latest} (you have v{v.current}). Re-run your install command to update.</span>
      <button onClick={() => setDismissed(true)} style={{ background: 'transparent', border: '1px solid #fff', color: '#fff', borderRadius: 6, padding: '2px 10px', cursor: 'pointer' }}>Dismiss</button>
    </div>
  )
}
```

- [ ] **Step 2: Render it in App.tsx**

Add the import at the top of `frontend/src/App.tsx`:
```tsx
import { UpdateBanner } from './components/UpdateBanner'
```
Render `<UpdateBanner />` as the first child of the App's top-level returned element (above the header).

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/UpdateBanner.tsx frontend/src/App.tsx
git commit -m "feat(native): update-available banner"
```

---

## Phase G — Documentation & stakeholder artifacts

> These are communication deliverables, not TDD. Each task produces complete content + a review step.

### Task G1: Stakeholder architecture diagram

**Files:**
- Create: `docs/architecture/native-packaging-diagram.md`

- [ ] **Step 1:** Author a Mermaid diagram doc covering (a) the e2e flow — mock AIOps page → install script → GitHub Releases → native package → configurator on :8765 → Docker/K8s target → gateway → Helix + local viewer; and (b) the codebase makeup — configurator (backend/frontend/packaging), the mock project, and CI. Use two Mermaid diagrams (`flowchart` for e2e, `graph` for codebase). Render-check at https://mermaid.live or via the preview tooling.
- [ ] **Step 2:** Export a PNG/SVG for stakeholders who don't render Markdown, and `SendUserFile` it.
- [ ] **Step 3: Commit**

```bash
git add docs/architecture/native-packaging-diagram.md
git commit -m "docs: stakeholder architecture diagram for native packaging"
```

### Task G2: Reconcile README + key docs

**Files:**
- Modify: `README.md`, `docs/architecture/ARCHITECTURE.md`, `docs/COMPREHENSIVE-GUIDE.md`

- [ ] **Step 1:** Update the "Prerequisites" / quickstart to lead with the native install (no Docker Desktop) and present Docker as the secondary path. Update the two-container component map to show the configurator as a **host process** that creates the gateway container (Docker target) or generates a chart (K8s target), with `host.docker.internal` fan-out.
- [ ] **Step 2:** Remove/replace references to the in-app `/aiops` demo page and `IS_DEMO_INSTALL`; point at the standalone `helix-aiops-mock` project instead.
- [ ] **Step 3:** Cross-check every changed claim against the code (port, paths, gateway creation). Run a docs-vs-code consistency pass.
- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture/ARCHITECTURE.md docs/COMPREHENSIVE-GUIDE.md
git commit -m "docs: reconcile README + key docs with native packaging"
```

---

## Self-Review notes (for the implementer)

- **better-sqlite3 is the one cross-platform risk.** If a platform's prebuilt addon is missing at `npm ci --omit=dev` time, the matrix job for that platform fails loudly — do not paper over it; pin a `better-sqlite3` version with prebuilds for all four targets.
- **dockerode laziness is verified** (constructor does not touch the socket). The only startup Docker call is `reconcileBridgedNetworks`, which already catches the gateway-absent case.
- **`archiver` stays** — k8s.js depends on it. Only `marked` is removed.
- **Order matters:** Phase A and C are independent; Phase B depends on A3 (the fan-out helper). Phase E (mock) is fully independent and can run in parallel. Phase G runs last.
