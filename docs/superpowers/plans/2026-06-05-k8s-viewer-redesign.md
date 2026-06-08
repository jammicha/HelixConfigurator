# K8s Viewer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the bundled in-cluster viewer from the K8s Helm chart, replacing it with host-loopback (`host.docker.internal:8765`) for local clusters and Helix-only for remote clusters.

**Architecture:** The gateway's `otlphttp/helix_local_viewer` exporter gets rewritten to target `host.docker.internal:8765` (local) or stripped entirely (remote). The frontend's viewer checkbox becomes a `local`/`remote` radio. All viewer Deployment/Service/PVC templates are deleted. Values.yaml drops the entire `viewer:` block.

**Tech Stack:** Node.js backend (Express, js-yaml, archiver), React/TypeScript frontend, Helm chart templates (Go templating), Vitest test suite.

**Spec:** `docs/superpowers/specs/2026-06-05-k8s-viewer-redesign-design.md`

---

### Task 1: Update `transformCollectorConfig` — replace `viewerEnabled` with `target`

**Files:**
- Modify: `backend/k8sChart/transformCollectorConfig.js`
- Test: `backend/__tests__/k8sChart-transform.test.mjs`

This is the core logic change. The function currently takes `{ viewerEnabled, viewerServiceName }` and either rewrites endpoints to an in-cluster service or strips the exporter. The new signature takes `{ target }` (`'local'` or `'remote'`) and rewrites to `host.docker.internal:8765` for local or strips for remote.

- [ ] **Step 1: Rewrite the test file**

Replace the entire test file with the new `target`-based tests. The BASE fixture and utility tests (health_check, malformed YAML, missing exporter) stay structurally identical — only the call signatures and assertions change.

```js
// backend/__tests__/k8sChart-transform.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { transformCollectorConfig, VIEWER_EXPORTER_KEY } from '../k8sChart/transformCollectorConfig.js';

const BASE = `
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  batch: { timeout: 1s }
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
    headers:
      X-Api-Key: \${env:HELIX_API_KEY}
      X-Source: \${env:X_SOURCE}
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
    tls: { insecure: true }
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    logs:    { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

describe('transformCollectorConfig', () => {
  it('target=local: rewrites viewer endpoints to host.docker.internal:8765', () => {
    const out = yaml.load(transformCollectorConfig(BASE, { target: 'local' }));
    const v = out.exporters[VIEWER_EXPORTER_KEY];
    expect(v.traces_endpoint).toBe('http://host.docker.internal:8765/api/otlp/traces');
    expect(v.logs_endpoint).toBe('http://host.docker.internal:8765/api/otlp/logs');
    expect(v.metrics_endpoint).toBe('http://host.docker.internal:8765/api/otlp/metrics');
    // Helix exporter and pipelines untouched.
    expect(out.exporters['otlphttp/bmchelix'].endpoint).toBe('${env:HELIX_ENDPOINT}');
    expect(out.service.pipelines.traces.exporters).toContain(VIEWER_EXPORTER_KEY);
  });

  it('target=remote: removes the viewer exporter and its pipeline refs, keeps bmchelix', () => {
    const out = yaml.load(transformCollectorConfig(BASE, { target: 'remote' }));
    expect(out.exporters[VIEWER_EXPORTER_KEY]).toBeUndefined();
    expect(out.service.pipelines.traces.exporters).toEqual(['otlphttp/bmchelix']);
    expect(out.service.pipelines.logs.exporters).toEqual(['otlphttp/bmchelix']);
    expect(out.service.pipelines.metrics.exporters).toEqual(['otlphttp/bmchelix']);
  });

  it('always injects a health_check extension wired into the service', () => {
    const on = yaml.load(transformCollectorConfig(BASE, { target: 'local' }));
    expect(on.extensions.health_check.endpoint).toBe('0.0.0.0:13133');
    expect(on.service.extensions).toContain('health_check');
  });

  it('does not duplicate an existing health_check extension', () => {
    const withHc = BASE + '\nextensions:\n  health_check: { endpoint: 0.0.0.0:13133 }\n';
    const out = yaml.load(transformCollectorConfig(withHc, { target: 'local' }));
    expect(out.service.extensions.filter(e => e === 'health_check')).toHaveLength(1);
  });

  it('viewer exporter already absent: no throw, bmchelix intact', () => {
    const noViewer = `
exporters: { otlphttp/bmchelix: { endpoint: x } }
service: { pipelines: { traces: { exporters: [otlphttp/bmchelix] } } }
`;
    const out = yaml.load(transformCollectorConfig(noViewer, { target: 'remote' }));
    expect(out.exporters['otlphttp/bmchelix']).toBeDefined();
    expect(out.service.pipelines.traces.exporters).toEqual(['otlphttp/bmchelix']);
  });

  it('malformed YAML throws a typed INVALID_COLLECTOR_YAML error', () => {
    const capture = (s) => {
      try { transformCollectorConfig(s, { target: 'local' }); }
      catch (e) { return e; }
      throw new Error('expected transformCollectorConfig to throw, but it did not');
    };
    expect(capture('a: b:\n  - [unclosed').message).toMatch(/collector/i);
    expect(capture(':\n::').code).toBe('INVALID_COLLECTOR_YAML');
  });

  it('target=local but exporter absent: no throw, viewer stays absent, health_check added', () => {
    const noViewer = `
exporters: { otlphttp/bmchelix: { endpoint: x } }
service: { pipelines: { traces: { exporters: [otlphttp/bmchelix] } } }
`;
    const out = yaml.load(transformCollectorConfig(noViewer, { target: 'local' }));
    expect(out.exporters[VIEWER_EXPORTER_KEY]).toBeUndefined();
    expect(out.exporters['otlphttp/bmchelix']).toBeDefined();
    expect(out.extensions.health_check).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-transform.test.mjs`

Expected: FAIL — `transformCollectorConfig` still expects `{ viewerEnabled }`, not `{ target }`.

- [ ] **Step 3: Update the implementation**

Replace the contents of `backend/k8sChart/transformCollectorConfig.js`:

```js
// backend/k8sChart/transformCollectorConfig.js
// PURE: transform the live collector config into the gateway ConfigMap payload.
// - target='local': rewrites the local-viewer exporter to host.docker.internal:8765
//   so telemetry flows back to the configurator running on the host.
// - target='remote': strips the viewer exporter entirely (Helix-only).
// - Ensures a health_check extension so the gateway Deployment can use httpGet probes.
// The Helix exporter's ${env:...} substitutions are left untouched — the values
// arrive via the pod's env (Secret + values), and the ConfigMap embeds this file
// via `.Files.Get` (raw bytes), so no Helm/Go templating touches them.
const yaml = require('js-yaml');

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';
const LOCAL_VIEWER_HOST = 'host.docker.internal:8765';

function invalid(message, cause) {
  const err = new Error(message);
  err.code = 'INVALID_COLLECTOR_YAML';
  if (cause) {
    err.cause = cause;
    if (cause.mark) err.mark = { line: cause.mark.line, column: cause.mark.column, message: cause.reason };
  }
  return err;
}

function ensureHealthCheckExtension(doc) {
  doc.extensions = doc.extensions || {};
  if (!doc.extensions.health_check) {
    doc.extensions.health_check = { endpoint: '0.0.0.0:13133' };
  }
  doc.service = doc.service || {};
  const exts = Array.isArray(doc.service.extensions) ? doc.service.extensions : [];
  if (!exts.includes('health_check')) exts.push('health_check');
  doc.service.extensions = exts;
}

function transformCollectorConfig(yamlString, { target = 'local' } = {}) {
  let doc;
  try {
    doc = yaml.load(yamlString);
  } catch (e) {
    throw invalid('Invalid collector YAML', e);
  }
  if (!doc || typeof doc !== 'object') throw invalid('Collector config is empty or not a mapping');

  doc.exporters = doc.exporters || {};
  const viewer = doc.exporters[VIEWER_EXPORTER_KEY];

  if (target === 'local') {
    if (viewer) {
      for (const key of ['traces_endpoint', 'logs_endpoint', 'metrics_endpoint']) {
        if (typeof viewer[key] === 'string') {
          // Replace scheme + host:port, preserve the /api/otlp/* path.
          viewer[key] = viewer[key].replace(/^https?:\/\/[^/]+/, `http://${LOCAL_VIEWER_HOST}`);
        }
      }
    }
  } else {
    // target === 'remote': strip the viewer exporter entirely.
    delete doc.exporters[VIEWER_EXPORTER_KEY];
    const pipelines = (doc.service && doc.service.pipelines) || {};
    for (const name of Object.keys(pipelines)) {
      const p = pipelines[name];
      if (p && Array.isArray(p.exporters)) {
        p.exporters = p.exporters.filter(e => e !== VIEWER_EXPORTER_KEY);
      }
    }
  }

  ensureHealthCheckExtension(doc);
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

module.exports = { transformCollectorConfig, ensureHealthCheckExtension, VIEWER_EXPORTER_KEY };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-transform.test.mjs`

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/transformCollectorConfig.js backend/__tests__/k8sChart-transform.test.mjs
git commit -m "refactor: replace viewerEnabled with target in transformCollectorConfig

target='local' rewrites to host.docker.internal:8765; target='remote' strips
the viewer exporter. Drops the viewerServiceName param (no in-cluster viewer)."
```

---

### Task 2: Update `renderValues` — remove all viewer config

**Files:**
- Modify: `backend/k8sChart/renderValues.js`
- Test: `backend/__tests__/k8sChart-values.test.mjs`

Strip the `viewer:` block from generated values and remove viewer-related DEFAULTS. The function no longer takes `viewerEnabled`.

- [ ] **Step 1: Rewrite the test file**

```js
// backend/__tests__/k8sChart-values.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { renderValues, DEFAULTS } from '../k8sChart/renderValues.js';

describe('renderValues', () => {
  it('bakes live endpoint + xSource and never bakes the apiKey', () => {
    const v = yaml.load(renderValues({ endpoint: 'https://helix.example/otlp', xSource: 'acme-otel' }));
    expect(v.helix.endpoint).toBe('https://helix.example/otlp');
    expect(v.helix.xSource).toBe('acme-otel');
    expect(v.helix.apiKey).toBe('');
    expect(v.helix.existingSecret).toBe('');
    expect(v.helix.existingSecretKey).toBe('HELIX_API_KEY');
  });

  it('does not emit a viewer section', () => {
    const v = yaml.load(renderValues({}));
    expect(v.viewer).toBeUndefined();
  });

  it('emits stable gateway name and a pinned gateway image', () => {
    const v = yaml.load(renderValues({}));
    expect(v.gateway.name).toBe('helix-gateway');
    expect(v.gateway.image.repository).toBe('otel/opentelemetry-collector-contrib');
    expect(v.gateway.image.tag).toBe(DEFAULTS.collectorTag);
  });

  it('produces valid YAML with empty defaults when no live env is supplied', () => {
    const v = yaml.load(renderValues({}));
    expect(v.helix.endpoint).toBe('');
    expect(v.gateway.replicas).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-values.test.mjs`

Expected: FAIL — `renderValues()` still emits a `viewer` section; the "does not emit a viewer section" test fails.

- [ ] **Step 3: Update the implementation**

Replace `backend/k8sChart/renderValues.js`:

```js
// backend/k8sChart/renderValues.js
// PURE: render the chart's values.yaml from live state. Non-secret values
// (endpoint, xSource) are baked; the apiKey is ALWAYS empty. At install the user
// either references a pre-created Secret (helix.existingSecret — recommended) or
// passes --set helix.apiKey (quick demo). Resource names are stable for Docker-parity DNS.
const yaml = require('js-yaml');

const DEFAULTS = {
  gatewayName: 'helix-gateway',
  collectorImage: 'otel/opentelemetry-collector-contrib',
  collectorTag: '0.119.0', // pinned; verify/bump to a validated contrib release
};

function renderValues({ endpoint = '', xSource = '' } = {}) {
  const rl = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  const values = {
    helix: { endpoint, xSource, apiKey: '', existingSecret: '', existingSecretKey: 'HELIX_API_KEY' },
    gateway: {
      name: DEFAULTS.gatewayName,
      image: { repository: DEFAULTS.collectorImage, tag: DEFAULTS.collectorTag, pullPolicy: 'IfNotPresent' },
      replicas: 1,
      resources: rl,
      service: { type: 'ClusterIP' },
    },
  };
  return yaml.dump(values, { lineWidth: -1, noRefs: true });
}

module.exports = { renderValues, DEFAULTS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-values.test.mjs`

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/renderValues.js backend/__tests__/k8sChart-values.test.mjs
git commit -m "refactor: remove viewer section from renderValues

Values now contain only helix: and gateway: blocks. viewerEnabled param and
viewer DEFAULTS (viewerName, viewerImage, viewerTag) removed."
```

---

### Task 3: Update `buildChart` and its tests — wire `target` through

**Files:**
- Modify: `backend/k8sChart/buildChart.js`
- Test: `backend/__tests__/k8sChart-build.test.mjs`

Update `buildChartFiles()` to accept `{ target }` instead of `{ viewerEnabled, viewerServiceName }`.

- [ ] **Step 1: Rewrite the test file**

```js
// backend/__tests__/k8sChart-build.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { buildChartFiles } from '../k8sChart/index.js';

const COLLECTOR = `
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
service:
  pipelines:
    traces: { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    logs:   { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

describe('buildChartFiles', () => {
  it('target=local: rewrites viewer exporter to host.docker.internal:8765, no viewer in values', () => {
    const { values, gatewayConfig } = buildChartFiles({
      collectorYaml: COLLECTOR, endpoint: 'https://h/otlp', xSource: 'acme', target: 'local',
    });
    const v = yaml.load(values);
    const g = yaml.load(gatewayConfig);
    expect(v.viewer).toBeUndefined();
    expect(v.helix.endpoint).toBe('https://h/otlp');
    expect(g.exporters['otlphttp/helix_local_viewer'].traces_endpoint).toBe('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('target=remote: strips the viewer exporter, no viewer in values', () => {
    const { values, gatewayConfig } = buildChartFiles({ collectorYaml: COLLECTOR, target: 'remote' });
    expect(yaml.load(values).viewer).toBeUndefined();
    expect(yaml.load(gatewayConfig).exporters['otlphttp/helix_local_viewer']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-build.test.mjs`

Expected: FAIL — `buildChartFiles` still passes `viewerEnabled` through to the transform, not `target`.

- [ ] **Step 3: Update the implementation**

Replace `backend/k8sChart/buildChart.js`:

```js
// backend/k8sChart/buildChart.js
// Assembles the chart: the two generated files (from live state) + a streamer
// that globs the static skeleton and appends the generated files under the
// single `helix-otel/` chart directory. Mirrors demo.js's writePackageToArchive.
const { transformCollectorConfig } = require('./transformCollectorConfig');
const { renderValues } = require('./renderValues');

const CHART_DIR_NAME = 'helix-otel';

function buildChartFiles({ collectorYaml, endpoint = '', xSource = '', target = 'local' }) {
  const gatewayConfig = transformCollectorConfig(collectorYaml, { target });
  const values = renderValues({ endpoint, xSource });
  return { values, gatewayConfig };
}

// `archive` is an archiver('zip') instance; `projectRoot` is the repo root that
// contains the `helix-otel/` skeleton. `files` is the buildChartFiles() result.
function streamChartArchive(archive, { projectRoot, files }) {
  archive.glob(`${CHART_DIR_NAME}/**`, { cwd: projectRoot, dot: true });
  archive.append(files.values, { name: `${CHART_DIR_NAME}/values.yaml` });
  archive.append(files.gatewayConfig, { name: `${CHART_DIR_NAME}/config/gateway-collector.yaml` });
}

module.exports = { buildChartFiles, streamChartArchive, CHART_DIR_NAME };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-build.test.mjs`

Expected: All 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/buildChart.js backend/__tests__/k8sChart-build.test.mjs
git commit -m "refactor: wire target param through buildChartFiles

Replaces viewerEnabled/viewerServiceName with target ('local'|'remote').
renderValues no longer receives any viewer-related param."
```

---

### Task 4: Update the backend route — `target` query param

**Files:**
- Modify: `backend/routes/k8s.js`
- Test: `backend/__tests__/k8s-routes.test.mjs`

Replace `wantsViewer(req)` with `getTarget(req)` and update the preview response shape.

- [ ] **Step 1: Rewrite the test file**

```js
// backend/__tests__/k8s-routes.test.mjs
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..'); // worktree root (contains helix-otel/)

const FIXTURE = `
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
service:
  pipelines:
    traces: { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    logs:   { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

let tmpDir, configPath;
function makeApp() {
  const app = express();
  const { register } = require('../routes/k8s.js');
  register(app, { configPath, projectRoot: PROJECT_ROOT });
  return app;
}
// supertest binary collector
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', c => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

let origApiKey;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-route-'));
  configPath = path.join(tmpDir, 'helix-otel-collector.yaml');
  fs.writeFileSync(configPath, FIXTURE);
  process.env.HELIX_ENDPOINT = 'https://helix.example/otlp';
  process.env.X_SOURCE = 'acme-otel';
  origApiKey = process.env.HELIX_API_KEY;
  process.env.HELIX_API_KEY = 'TENANT::ACCESS::SECRET';
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origApiKey === undefined) delete process.env.HELIX_API_KEY;
  else process.env.HELIX_API_KEY = origApiKey;
});

describe('GET /api/k8s/chart/preview', () => {
  it('target=local: rewrites viewer to host.docker.internal:8765, returns install commands', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?target=local');
    expect(res.status).toBe(200);
    expect(res.body.target).toBe('local');
    expect(yaml.load(res.body.values).helix.endpoint).toBe('https://helix.example/otlp');
    expect(yaml.load(res.body.gatewayConfig).exporters['otlphttp/helix_local_viewer'].traces_endpoint)
      .toBe('http://host.docker.internal:8765/api/otlp/traces');
    expect(res.body.installCommand).toMatch(/helm install helix \.\/helix-otel/);
    expect(res.body.installCommand).toMatch(/existingSecret/);
    expect(res.body.secretCommand).toContain("HELIX_API_KEY='TENANT::ACCESS::SECRET'");
    expect(res.body.keyEmbedded).toBe(true);
    expect(res.body.files).toContain('helix-otel/templates/gateway-deployment.yaml');
    // No viewer values in the output
    expect(yaml.load(res.body.values).viewer).toBeUndefined();
  });

  it('target=remote: strips the viewer exporter from gateway config', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?target=remote');
    expect(res.body.target).toBe('remote');
    expect(yaml.load(res.body.gatewayConfig).exporters['otlphttp/helix_local_viewer']).toBeUndefined();
  });

  it('defaults to target=local when no target param is provided', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview');
    expect(res.body.target).toBe('local');
    expect(yaml.load(res.body.gatewayConfig).exporters['otlphttp/helix_local_viewer'].traces_endpoint)
      .toBe('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('returns 400 on malformed live collector YAML', async () => {
    fs.writeFileSync(configPath, ':\n::');
    const res = await request(makeApp()).get('/api/k8s/chart/preview');
    expect(res.status).toBe(400);
    fs.writeFileSync(configPath, FIXTURE); // restore
  });

  it('handoff mode omits the real key (placeholder only)', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?handoff=true');
    expect(res.status).toBe(200);
    expect(res.body.keyEmbedded).toBe(false);
    expect(res.body.secretCommand).toContain('<TenantID::AccessKey::SecretKey>');
    expect(res.body.secretCommand).not.toContain('TENANT::ACCESS::SECRET');
  });

  it('does not crash at register or preview when the chart skeleton is missing', async () => {
    const app = express();
    const { register } = require('../routes/k8s.js');
    expect(() => register(app, { configPath, projectRoot: '/no/such/dir' })).not.toThrow();
    const res = await request(app).get('/api/k8s/chart/preview?target=local');
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual(expect.arrayContaining([
      'helix-otel/values.yaml',
      'helix-otel/config/gateway-collector.yaml',
    ]));
  });
});

describe('GET /api/k8s/chart', () => {
  it('streams a zip containing the full chart with the generated files', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart?target=local')
      .buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/helix-otel-chart\.zip/);

    const names = new AdmZip(res.body).getEntries().map(e => e.entryName);
    for (const f of [
      'helix-otel/Chart.yaml',
      'helix-otel/values.yaml',
      'helix-otel/config/gateway-collector.yaml',
      'helix-otel/templates/gateway-deployment.yaml',
      'helix-otel/templates/secret.yaml',
    ]) expect(names).toContain(f);

    // Viewer templates must NOT be in the zip.
    expect(names).not.toContain('helix-otel/templates/viewer-deployment.yaml');
    expect(names).not.toContain('helix-otel/templates/viewer-service.yaml');
    expect(names).not.toContain('helix-otel/templates/viewer-pvc.yaml');

    // Non-template generated files parse as YAML.
    const zip = new AdmZip(res.body);
    expect(yaml.load(zip.getEntry('helix-otel/values.yaml').getData().toString())).toBeTruthy();
    expect(yaml.load(zip.getEntry('helix-otel/config/gateway-collector.yaml').getData().toString())).toBeTruthy();
    expect(yaml.load(zip.getEntry('helix-otel/Chart.yaml').getData().toString()).name).toBe('helix-otel');

    // Preview file list must match the zip's file entries exactly.
    const fileEntries = new AdmZip(res.body).getEntries()
      .filter(e => !e.isDirectory)
      .map(e => e.entryName)
      .sort();
    const preview = await request(makeApp()).get('/api/k8s/chart/preview?target=local');
    expect(preview.body.files).toContain('helix-otel/templates/gateway-deployment.yaml');
    expect(preview.body.files.slice().sort()).toEqual(fileEntries);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8s-routes.test.mjs`

Expected: FAIL — route still reads `viewer` param and passes `viewerEnabled`, response still has `viewerEnabled` key not `target`.

- [ ] **Step 3: Update the implementation**

Replace `backend/routes/k8s.js`:

```js
// backend/routes/k8s.js
// Phase 1 "Generate K8s chart": stream a self-contained Helm chart (or preview
// it as JSON) built from live configurator state. Generate-only — no cluster calls.
// Reuses the archiver streaming pattern from routes/demo.js. Registered under
// requireAuth (an authed dashboard action).
const fsPromises = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const { buildChartFiles, streamChartArchive } = require('../k8sChart');

const KEY_PLACEHOLDER = '<TenantID::AccessKey::SecretKey>';

function buildCommands({ handoff }) {
  const key = handoff ? KEY_PLACEHOLDER : (process.env.HELIX_API_KEY || KEY_PLACEHOLDER);
  return {
    secretCommand: `kubectl create secret generic helix-key --from-literal=HELIX_API_KEY='${key}'`,
    installCommand: 'helm install helix ./helix-otel --set helix.existingSecret=helix-key',
  };
}

const chartFilesCache = new Map();
function listChartFiles(projectRoot) {
  if (chartFilesCache.has(projectRoot)) return chartFilesCache.get(projectRoot);
  const generated = [
    'helix-otel/values.yaml',
    'helix-otel/config/gateway-collector.yaml',
  ];
  let skeletonFiles = [];
  try {
    const skeletonRoot = path.join(projectRoot, 'helix-otel');
    skeletonFiles = fsSync.readdirSync(skeletonRoot, { recursive: true })
      .map(e => path.join('helix-otel', e).replace(/\\/g, '/'))
      .filter(p => {
        try { return fsSync.statSync(path.join(projectRoot, p)).isFile(); }
        catch { return false; }
      });
  } catch (e) {
    console.warn(`k8s: chart skeleton missing at ${path.join(projectRoot, 'helix-otel')} (${e.code || e.message}); chart generation will be unavailable.`);
  }
  const result = [...new Set([...skeletonFiles, ...generated])].sort();
  chartFilesCache.set(projectRoot, result);
  return result;
}

const getTarget = (req) => String(req.query.target || 'local') === 'remote' ? 'remote' : 'local';
const wantsHandoff = (req) => String(req.query.handoff) === 'true';

function register(app, { configPath, projectRoot }) {
  async function generate(req, res) {
    let collectorYaml;
    try {
      collectorYaml = await fsPromises.readFile(configPath, 'utf8');
    } catch {
      res.status(500).json({ error: 'Failed to read gateway config' });
      return null;
    }
    try {
      return buildChartFiles({
        collectorYaml,
        endpoint: process.env.HELIX_ENDPOINT || '',
        xSource: process.env.X_SOURCE || '',
        target: getTarget(req),
      });
    } catch (e) {
      if (e.code === 'INVALID_COLLECTOR_YAML') {
        res.status(400).json({ error: 'Invalid collector YAML', mark: e.mark });
      } else {
        res.status(500).json({ error: 'Failed to build chart', details: e.message });
      }
      return null;
    }
  }

  app.get('/api/k8s/chart/preview', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    const handoff = wantsHandoff(req);
    const { secretCommand, installCommand } = buildCommands({ handoff });
    res.json({
      target: getTarget(req),
      values: files.values,
      gatewayConfig: files.gatewayConfig,
      secretCommand,
      installCommand,
      keyEmbedded: !handoff && !!process.env.HELIX_API_KEY,
      files: listChartFiles(projectRoot),
    });
  });

  app.get('/api/k8s/chart', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="helix-otel-chart.zip"');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('k8s chart archive error:', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    archive.pipe(res);
    streamChartArchive(archive, { projectRoot, files });
    archive.finalize();
  });
}

module.exports = { register };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8s-routes.test.mjs`

Expected: All tests PASS. Note: the zip test that checks for viewer templates being absent will depend on Task 5 (deleting the skeleton files). If it fails on the `not.toContain` assertions, that's expected until Task 5 is complete — the skeleton files still exist on disk. The rest of the tests should pass now.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/k8s.js backend/__tests__/k8s-routes.test.mjs
git commit -m "refactor: replace viewer param with target in k8s route

Preview and download now accept ?target=local|remote (default: local).
Response shape returns target instead of viewerEnabled."
```

---

### Task 5: Delete viewer Helm templates and update skeleton

**Files:**
- Delete: `helix-otel/templates/viewer-deployment.yaml`
- Delete: `helix-otel/templates/viewer-service.yaml`
- Delete: `helix-otel/templates/viewer-pvc.yaml`
- Modify: `helix-otel/templates/NOTES.txt`
- Modify: `helix-otel/templates/_helpers.tpl`

- [ ] **Step 1: Delete the three viewer template files**

```bash
cd /Users/jammicha/dev/HelixConfigurator
git rm helix-otel/templates/viewer-deployment.yaml
git rm helix-otel/templates/viewer-service.yaml
git rm helix-otel/templates/viewer-pvc.yaml
```

- [ ] **Step 2: Replace NOTES.txt**

Replace the contents of `helix-otel/templates/NOTES.txt` with:

```
Helix OTel gateway installed as release "{{ .Release.Name }}" in namespace "{{ .Release.Namespace }}".

1) Point your apps at the gateway (in-cluster):
     OTEL_EXPORTER_OTLP_ENDPOINT=http://{{ .Values.gateway.name }}:4318
   (gRPC on :4317, Prometheus metrics on :8888)

2) Telemetry is flowing to Helix.
   If running on a local cluster (Docker Desktop k8s), telemetry also flows
   to http://localhost:8765/otel-data automatically.
```

- [ ] **Step 3: Remove the viewer selector labels helper from `_helpers.tpl`**

Remove the `helix-otel.viewer.selectorLabels` block from `helix-otel/templates/_helpers.tpl`. The file should become:

```
{{/* Common labels applied to every object. */}}
{{- define "helix-otel.labels" -}}
app.kubernetes.io/managed-by: helix-configurator
app.kubernetes.io/part-of: helix-otel
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Gateway selector labels. */}}
{{- define "helix-otel.gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ .Values.gateway.name }}
app.kubernetes.io/component: gateway
{{- end -}}
```

- [ ] **Step 4: Run the full backend test suite to check nothing is broken**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-transform.test.mjs backend/__tests__/k8sChart-values.test.mjs backend/__tests__/k8sChart-build.test.mjs backend/__tests__/k8s-routes.test.mjs`

Expected: All tests PASS. The route zip test should now correctly see no viewer template files in the archive.

- [ ] **Step 5: Commit**

```bash
git add -A helix-otel/
git commit -m "chore: delete viewer Helm templates and update NOTES.txt

Removes viewer-deployment.yaml, viewer-service.yaml, viewer-pvc.yaml.
Strips viewer selector labels from _helpers.tpl. NOTES.txt now shows a
static local-viewer hint instead of LoadBalancer/ClusterIP branching."
```

---

### Task 6: Update helm smoke test

**Files:**
- Modify: `backend/__tests__/k8s-helm-smoke.test.mjs`

The smoke test currently iterates `viewer=true/false` and asserts PVC presence. Update to iterate `target='local'/'remote'`, drop PVC assertions, and confirm only gateway resources render.

- [ ] **Step 1: Rewrite the test file**

```js
// backend/__tests__/k8s-helm-smoke.test.mjs
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { buildChartFiles } from '../k8sChart/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SKELETON = path.join(PROJECT_ROOT, 'helix-otel');

function helmAvailable() {
  try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function assembleChart(destRoot, target) {
  const dest = path.join(destRoot, 'helix-otel');
  fs.cpSync(SKELETON, dest, { recursive: true });
  const collectorYaml = fs.readFileSync(path.join(PROJECT_ROOT, 'helix-otel-collector.yaml'), 'utf8');
  const { values, gatewayConfig } = buildChartFiles({ collectorYaml, endpoint: 'https://h/otlp', xSource: 'acme', target });
  fs.writeFileSync(path.join(dest, 'values.yaml'), values);
  fs.mkdirSync(path.join(dest, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'config', 'gateway-collector.yaml'), gatewayConfig);
  return dest;
}

describe.skipIf(!helmAvailable())('helm smoke', () => {
  for (const target of ['local', 'remote']) {
    it(`renders valid manifests (target=${target})`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-smoke-'));
      try {
        const chart = assembleChart(tmp, target);
        execFileSync('helm', ['lint', chart, '--set', 'helix.apiKey=dummy'], { stdio: 'pipe' });
        const out = execFileSync('helm', ['template', 'helix', chart, '--set', 'helix.apiKey=dummy'], { encoding: 'utf8' });
        const docs = yaml.loadAll(out).filter(Boolean);
        const kinds = docs.map(d => d.kind);
        expect(kinds).toContain('Deployment');
        expect(kinds).toContain('ConfigMap');
        expect(kinds).toContain('Secret');
        // No viewer resources for either target.
        expect(kinds).not.toContain('PersistentVolumeClaim');
        // Only one Deployment (the gateway).
        expect(kinds.filter(k => k === 'Deployment')).toHaveLength(1);
        // Gateway ConfigMap embeds the collector config.
        const cm = docs.find(d => d.kind === 'ConfigMap');
        expect(cm.data['config.yaml']).toMatch(/otlphttp\/bmchelix/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it('existingSecret mode: no chart-managed Secret, gateway refs the external one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-smoke-es-'));
    try {
      const chart = assembleChart(tmp, 'local');
      execFileSync('helm', ['lint', chart, '--set', 'helix.existingSecret=my-helix-key'], { stdio: 'pipe' });
      const out = execFileSync('helm', ['template', 'helix', chart, '--set', 'helix.existingSecret=my-helix-key'], { encoding: 'utf8' });
      const docs = yaml.loadAll(out).filter(Boolean);
      expect(docs.map(d => d.kind)).not.toContain('Secret');
      const dep = docs.find(d => d.kind === 'Deployment' && d.metadata.name === 'helix-gateway');
      const apiKeyEnv = dep.spec.template.spec.containers[0].env.find(e => e.name === 'HELIX_API_KEY');
      expect(apiKeyEnv.valueFrom.secretKeyRef.name).toBe('my-helix-key');
      expect(apiKeyEnv.valueFrom.secretKeyRef.key).toBe('HELIX_API_KEY');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8s-helm-smoke.test.mjs`

Expected: All tests PASS (assuming `helm` is installed — the suite self-skips if not).

- [ ] **Step 3: Commit**

```bash
git add backend/__tests__/k8s-helm-smoke.test.mjs
git commit -m "test: update helm smoke tests for target param, drop viewer assertions

Iterates target=local/remote instead of viewer=true/false. Asserts no PVC
and only one Deployment (gateway) for both targets."
```

---

### Task 7: Update frontend modal — viewer checkbox to target radio

**Files:**
- Modify: `frontend/src/components/K8sChartModal.tsx`

Replace `viewerEnabled` state (boolean checkbox) with `clusterTarget` state (radio: `'local'` | `'remote'`). Update fetch URL and download link.

- [ ] **Step 1: Replace the component**

Replace the full contents of `frontend/src/components/K8sChartModal.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';
import { SnippetBlock } from './SnippetBlock';

type Target = 'local' | 'remote';
type Preview = { target: Target; values: string; gatewayConfig: string; secretCommand: string; installCommand: string; files: string[]; keyEmbedded: boolean };
type Props = { isOpen: boolean; onClose: () => void };

// "Generate Kubernetes deployment" — previews and downloads a self-contained
// Helm chart (gateway only), pre-wired to Helix from live state.
// Local clusters send telemetry back to the host's configurator at localhost:8765.
// Remote clusters send to Helix only.
export const K8sChartModal: React.FC<Props> = ({ isOpen, onClose }) => {
  useEscClose(isOpen, onClose);
  const [clusterTarget, setClusterTarget] = useState<Target>('local');
  const [handoff, setHandoff] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/k8s/chart/preview?target=${clusterTarget}&handoff=${handoff}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) setPreview(d); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, clusterTarget, handoff]);

  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="k8s-modal-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 id="k8s-modal-title" className="text-lg font-semibold text-gray-200">Generate Kubernetes deployment</h2>
            <p className="text-tiny text-gray-500">A self-contained Helm chart, pre-wired to Helix from your current config.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close dialog">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-tiny uppercase tracking-wide text-gray-500 mb-1">Cluster target</legend>
            <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
              <input type="radio" name="clusterTarget" value="local" checked={clusterTarget === 'local'} onChange={() => setClusterTarget('local')} className="accent-primary mt-0.5" />
              <span>
                <span className="font-medium text-gray-200">Local cluster (Docker Desktop)</span>
                <span className="block text-tiny text-gray-500 mt-0.5">Telemetry flows back to this app at localhost:8765/otel-data — same view as Docker.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
              <input type="radio" name="clusterTarget" value="remote" checked={clusterTarget === 'remote'} onChange={() => setClusterTarget('remote')} className="accent-primary mt-0.5" />
              <span>
                <span className="font-medium text-gray-200">Remote / cloud cluster</span>
                <span className="block text-tiny text-gray-500 mt-0.5">View your telemetry in BMC Helix. The local viewer isn't reachable from a remote cluster.</span>
              </span>
            </label>
          </fieldset>

          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={handoff} onChange={e => setHandoff(e.target.checked)} className="accent-primary w-4 h-4" />
            Generating this for someone else (omit my key)
          </label>

          <div className="flex items-center gap-3 text-sm text-gray-500">
            <input type="checkbox" checked={false} disabled className="w-4 h-4" />
            Use the OpenTelemetry Operator <span className="text-tiny px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700">coming soon</span>
          </div>

          {error && <div className="text-xs text-error-text bg-error/10 border border-error/40 rounded p-3">{error}</div>}
          {loading && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Generating preview…</div>}

          {preview && !loading && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-tiny uppercase tracking-wide text-gray-500">Install steps</p>
                <a
                  href="https://github.com/jammicha/HelixConfigurator#generate-a-kubernetes-chart"
                  target="_blank" rel="noopener noreferrer"
                  className="text-tiny text-[#8b7cf6] hover:underline"
                >Full walkthrough ↗</a>
              </div>
              <div>
                <p className="text-sm text-gray-300">
                  <span className="text-gray-500">1 ·</span> Download &amp; unzip the chart — click <span className="text-gray-200">Download chart (.zip)</span> below, then <code className="text-tiny bg-gray-1000 px-1 py-0.5 rounded">unzip helix-otel-chart.zip</code>. Run the next steps from the folder that now holds <code className="text-tiny bg-gray-1000 px-1 py-0.5 rounded">helix-otel/</code>.
                </p>
              </div>
              <div>
                <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">2 · Create the secret</p>
                <SnippetBlock text={preview.secretCommand} />
                {preview.keyEmbedded && (
                  <p className="text-tiny text-[#fcd34d] mb-2">
                    ⚠ Contains your live Helix key — it runs locally and is never written into the downloaded chart.
                  </p>
                )}
              </div>
              <div>
                <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">3 · Install the chart</p>
                <SnippetBlock text={preview.installCommand} />
              </div>
              <details>
                <summary className="text-sm text-gray-300 cursor-pointer select-none">Preview values.yaml</summary>
                <SnippetBlock text={preview.values} />
              </details>
              <details>
                <summary className="text-sm text-gray-300 cursor-pointer select-none">Preview gateway collector config</summary>
                <SnippetBlock text={preview.gatewayConfig} />
              </details>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-700 flex-shrink-0">
          <a
            href={`/api/k8s/chart?target=${clusterTarget}`}
            className="bg-primary hover:bg-[#3006c2] text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download chart (.zip)
          </a>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/jammicha/dev/HelixConfigurator && npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/K8sChartModal.tsx
git commit -m "feat: replace viewer checkbox with local/remote cluster target radio

The modal now asks whether the cluster is local (Docker Desktop) or remote.
Local: telemetry flows back to localhost:8765. Remote: Helix only.
Fetch URL uses ?target= instead of ?viewer=."
```

---

### Task 8: Update documentation

**Files:**
- Modify: `README.md` (lines ~178-204, ~282)
- Modify: `docs/architecture/ARCHITECTURE.md` (viewer references)
- Modify: `docs/COMPREHENSIVE-GUIDE.md` (viewer references)

Documentation updates are text-only changes. The `frontend/public/k8s-walkthrough.html` was checked and contains no viewer references (empty grep result) so it needs no changes.

- [ ] **Step 1: Update README.md — replace the "Verify & view" section (lines 178-204)**

Replace lines 178-204 (the "**4. Verify & view**" block through the end of the viewer image admonition) with:

```markdown
**4. Verify** — wait for the gateway pod and point your apps at it:
```bash
kubectl get pods                                 # wait for helix-gateway = Running
# apps in-cluster send to:  http://helix-gateway:4318
```

> **Local clusters (Docker Desktop k8s):** telemetry automatically flows back to
> `localhost:8765/otel-data` — the same built-in viewer you use in Docker mode. No
> port-forward needed; the gateway sends a copy to `host.docker.internal:8765`.
>
> **Remote / cloud clusters:** view your telemetry in BMC Helix. The local viewer is
> not reachable from a remote cluster, so the gateway sends to Helix only.
```

- [ ] **Step 2: Update README.md line ~282 — clarify the fan-out exporter note**

Find the line containing "The fan-out `otlphttp/helix_local_viewer` exporter" and replace it with:

```markdown
- The fan-out `otlphttp/helix_local_viewer` exporter in `helix-otel-collector.yaml` (which feeds the local View OTel Data page) is **not** demo plumbing — it ships in Docker mode and in local-cluster K8s mode (rewritten to `host.docker.internal:8765` by the chart generator). Remote K8s deployments strip it.
```

- [ ] **Step 3: Update docs/architecture/ARCHITECTURE.md — add a K8s note near the pipeline section**

Find the line "traces and logs to the configurator for the local viewer" (around line 34) and append to the end of that sentence:

```
 (in Docker mode via `helix-configurator:3001`; in K8s local mode via `host.docker.internal:8765`).
```

- [ ] **Step 4: Update docs/COMPREHENSIVE-GUIDE.md — add K8s context to the fan-out description**

The COMPREHENSIVE-GUIDE has the same fan-out pipeline description as ARCHITECTURE.md. Find the line near line 184 that reads `otlphttp/bmchelix` (out to Helix) and `otlphttp/helix_local_viewer` (HTTP to the` and append to the end of that paragraph:

```
In K8s local-cluster mode, the chart generator rewrites the viewer exporter to target `host.docker.internal:8765` (the host's configurator); in remote mode, the exporter is stripped entirely.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture/ARCHITECTURE.md docs/COMPREHENSIVE-GUIDE.md
git commit -m "docs: update K8s viewer docs for host-loopback redesign

README: replaces port-forward/image-load instructions with local/remote
cluster explanation. ARCHITECTURE + COMPREHENSIVE-GUIDE: adds K8s
host.docker.internal note to fan-out descriptions."
```

---

### Task 9: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run the full k8s-related test suite**

```bash
cd /Users/jammicha/dev/HelixConfigurator && npx vitest run backend/__tests__/k8sChart-transform.test.mjs backend/__tests__/k8sChart-values.test.mjs backend/__tests__/k8sChart-build.test.mjs backend/__tests__/k8s-routes.test.mjs backend/__tests__/k8s-helm-smoke.test.mjs
```

Expected: All tests PASS.

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/jammicha/dev/HelixConfigurator && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run the full project test suite**

```bash
cd /Users/jammicha/dev/HelixConfigurator && npx vitest run
```

Expected: All tests PASS. If any non-k8s tests reference viewer-related imports from k8sChart (e.g. `DEFAULTS.viewerName`), they'll fail here and need fixing. Check for:
- Any test importing `DEFAULTS` that accesses `viewerName`, `viewerImage`, or `viewerTag`
- Any test passing `viewerEnabled` to `buildChartFiles` or `transformCollectorConfig`

- [ ] **Step 4: Verify the generated chart works end-to-end (quick manual check)**

If the dev server is running (`docker compose up -d --build`), open `http://localhost:8765`, click "Generate Kubernetes deployment", verify:
- Radio group shows "Local cluster (Docker Desktop)" selected by default
- Preview shows `host.docker.internal:8765` in the gateway config
- Switching to "Remote" strips the viewer exporter from preview
- Download link works
