# Generate K8s Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurator action that emits a self-contained, Operator-free Helm chart (Helix OTel gateway + optional local viewer), pre-wired to Helix from live state, downloaded as a `.zip`.

**Architecture:** A static Helm chart skeleton lives in the repo at `helix-otel/`. A thin `backend/k8sChart/` module generates the two live-derived files — `values.yaml` (baked `HELIX_ENDPOINT`/`X_SOURCE` + viewer toggle) and `config/gateway-collector.yaml` (the live collector config, transformed so the local-viewer exporter points at the in-cluster viewer Service or is stripped). A new route streams the skeleton + the two generated files as a zip, reusing `demo.js`'s `archiver` plumbing. A `K8sChartModal` drives it. Generate-only — no cluster calls.

**Tech Stack:** Node + Express 5 (backend), `js-yaml`, `archiver`, `vitest` + `supertest` (+ `adm-zip` devDep for zip assertions), React + Vite + Tailwind (frontend), Helm chart YAML.

**Spec:** [`docs/superpowers/specs/2026-06-03-generate-k8s-chart-design.md`](../specs/2026-06-03-generate-k8s-chart-design.md)

**Commit convention:** end every commit message with a trailer line `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. All commands assume the working directory is the worktree root (`.worktrees/generate-k8s-chart`); tests run via `npm --prefix backend test`.

---

## File Structure

**New — backend generator (one responsibility each):**
- `backend/k8sChart/transformCollectorConfig.js` — PURE: live collector YAML + opts → gateway config YAML (viewer-exporter rewrite/strip + health_check).
- `backend/k8sChart/renderValues.js` — PURE: live env + toggle → `values.yaml` string.
- `backend/k8sChart/buildChart.js` — `buildChartFiles()` (the two generated files) + `streamChartArchive()` (skeleton glob + appends).
- `backend/k8sChart/index.js` — façade re-exporting the three (the Phase-2 seam).
- `backend/routes/k8s.js` — `GET /api/k8s/chart` (zip) + `GET /api/k8s/chart/preview` (JSON).

**New — chart skeleton (static, committed):**
- `helix-otel/Chart.yaml`, `helix-otel/.helmignore`
- `helix-otel/templates/{_helpers.tpl, NOTES.txt, gateway-configmap.yaml, gateway-deployment.yaml, gateway-service.yaml, secret.yaml, viewer-deployment.yaml, viewer-service.yaml, viewer-pvc.yaml}`
- The skeleton **omits** `values.yaml` and `config/` — those are generated.

**New — frontend:** `frontend/src/components/K8sChartModal.tsx`

**New — tests:** `backend/__tests__/{k8sChart-transform,k8sChart-values,k8sChart-build,k8s-routes}.test.mjs`, `backend/__tests__/k8s-helm-smoke.test.mjs`

**Modified:** `backend/index.js` (register route), `backend/package.json` (adm-zip devDep), `frontend/src/App.tsx` (button + modal), `README.md` (short section).

---

## Task 1: Collector-config transform (the heart)

**Files:**
- Create: `backend/k8sChart/transformCollectorConfig.js`
- Test: `backend/__tests__/k8sChart-transform.test.mjs`

- [ ] **Step 1: Write the failing test**

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
    headers: { X-Api-Key: \${env:HELIX_API_KEY}, X-Source: \${env:X_SOURCE} }
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    tls: { insecure: true }
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix] }
    logs:    { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

describe('transformCollectorConfig', () => {
  it('viewer ON: rewrites the viewer endpoints to the in-cluster Service, preserves paths', () => {
    const out = yaml.load(transformCollectorConfig(BASE, { viewerEnabled: true }));
    const v = out.exporters[VIEWER_EXPORTER_KEY];
    expect(v.traces_endpoint).toBe('http://helix-viewer:3001/api/otlp/traces');
    expect(v.logs_endpoint).toBe('http://helix-viewer:3001/api/otlp/logs');
    // Helix exporter and pipelines untouched.
    expect(out.exporters['otlphttp/bmchelix'].endpoint).toBe('${env:HELIX_ENDPOINT}');
    expect(out.service.pipelines.traces.exporters).toContain(VIEWER_EXPORTER_KEY);
  });

  it('viewer ON: honors a custom viewerServiceName', () => {
    const out = yaml.load(transformCollectorConfig(BASE, { viewerEnabled: true, viewerServiceName: 'vw' }));
    expect(out.exporters[VIEWER_EXPORTER_KEY].traces_endpoint).toBe('http://vw:3001/api/otlp/traces');
  });

  it('viewer OFF: removes the viewer exporter and its pipeline refs, keeps bmchelix', () => {
    const out = yaml.load(transformCollectorConfig(BASE, { viewerEnabled: false }));
    expect(out.exporters[VIEWER_EXPORTER_KEY]).toBeUndefined();
    expect(out.service.pipelines.traces.exporters).toEqual(['otlphttp/bmchelix']);
    expect(out.service.pipelines.logs.exporters).toEqual(['otlphttp/bmchelix']);
    expect(out.service.pipelines.metrics.exporters).toEqual(['otlphttp/bmchelix']);
  });

  it('always injects a health_check extension wired into the service', () => {
    const on = yaml.load(transformCollectorConfig(BASE, { viewerEnabled: true }));
    expect(on.extensions.health_check.endpoint).toBe('0.0.0.0:13133');
    expect(on.service.extensions).toContain('health_check');
  });

  it('does not duplicate an existing health_check extension', () => {
    const withHc = BASE + '\nextensions:\n  health_check: { endpoint: 0.0.0.0:13133 }\n';
    const out = yaml.load(transformCollectorConfig(withHc, { viewerEnabled: true }));
    expect(out.service.extensions.filter(e => e === 'health_check')).toHaveLength(1);
  });

  it('viewer exporter already absent: no throw, bmchelix intact', () => {
    const noViewer = `
exporters: { otlphttp/bmchelix: { endpoint: x } }
service: { pipelines: { traces: { exporters: [otlphttp/bmchelix] } } }
`;
    const out = yaml.load(transformCollectorConfig(noViewer, { viewerEnabled: false }));
    expect(out.exporters['otlphttp/bmchelix']).toBeDefined();
    expect(out.service.pipelines.traces.exporters).toEqual(['otlphttp/bmchelix']);
  });

  it('malformed YAML throws a typed INVALID_COLLECTOR_YAML error', () => {
    expect(() => transformCollectorConfig('a: b:\n  - [unclosed', { viewerEnabled: true }))
      .toThrowError(/collector/i);
    try { transformCollectorConfig(':\n::', { viewerEnabled: true }); }
    catch (e) { expect(e.code).toBe('INVALID_COLLECTOR_YAML'); }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix backend test -- k8sChart-transform`
Expected: FAIL — `Cannot find module '../k8sChart/transformCollectorConfig.js'` / `transformCollectorConfig is not a function`.

- [ ] **Step 3: Write the implementation**

```js
// backend/k8sChart/transformCollectorConfig.js
// PURE: transform the live collector config into the gateway ConfigMap payload.
// - Rewrites (or strips) the hardcoded local-viewer exporter so it targets the
//   in-cluster viewer Service instead of http://helix-configurator:3001.
// - Ensures a health_check extension so the gateway Deployment can use httpGet probes.
// The Helix exporter's ${env:...} substitutions are left untouched — the values
// arrive via the pod's env (Secret + values), and the ConfigMap embeds this file
// via `.Files.Get` (raw bytes), so no Helm/Go templating touches them.
const yaml = require('js-yaml');

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';

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

function transformCollectorConfig(yamlString, { viewerEnabled, viewerServiceName = 'helix-viewer' } = {}) {
  let doc;
  try {
    doc = yaml.load(yamlString);
  } catch (e) {
    throw invalid('Invalid collector YAML', e);
  }
  if (!doc || typeof doc !== 'object') throw invalid('Collector config is empty or not a mapping');

  doc.exporters = doc.exporters || {};
  const viewer = doc.exporters[VIEWER_EXPORTER_KEY];

  if (viewerEnabled) {
    if (viewer) {
      for (const key of ['traces_endpoint', 'logs_endpoint']) {
        if (typeof viewer[key] === 'string') {
          // Replace scheme + host:port, preserve the /api/otlp/* path.
          viewer[key] = viewer[key].replace(/^https?:\/\/[^/]+/, `http://${viewerServiceName}:3001`);
        }
      }
    }
  } else {
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix backend test -- k8sChart-transform`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/transformCollectorConfig.js backend/__tests__/k8sChart-transform.test.mjs
git commit -m "feat(k8s): collector-config transform for the gateway ConfigMap" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `renderValues`

**Files:**
- Create: `backend/k8sChart/renderValues.js`
- Test: `backend/__tests__/k8sChart-values.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// backend/__tests__/k8sChart-values.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { renderValues, DEFAULTS } from '../k8sChart/renderValues.js';

describe('renderValues', () => {
  it('bakes live endpoint + xSource and never bakes the apiKey', () => {
    const v = yaml.load(renderValues({ endpoint: 'https://helix.example/otlp', xSource: 'acme-otel', viewerEnabled: true }));
    expect(v.helix.endpoint).toBe('https://helix.example/otlp');
    expect(v.helix.xSource).toBe('acme-otel');
    expect(v.helix.apiKey).toBe('');
  });

  it('reflects the viewer toggle', () => {
    expect(yaml.load(renderValues({ viewerEnabled: false })).viewer.enabled).toBe(false);
    expect(yaml.load(renderValues({ viewerEnabled: true })).viewer.enabled).toBe(true);
  });

  it('emits stable resource names and a pinned gateway image', () => {
    const v = yaml.load(renderValues({}));
    expect(v.gateway.name).toBe('helix-gateway');
    expect(v.viewer.name).toBe('helix-viewer');
    expect(v.gateway.image.repository).toBe('otel/opentelemetry-collector-contrib');
    expect(v.gateway.image.tag).toBe(DEFAULTS.collectorTag);
    expect(v.viewer.image.repository).toBe('helix-configurator');
    expect(v.viewer.image.pullPolicy).toBe('IfNotPresent');
  });

  it('produces valid YAML with empty defaults when no live env is supplied', () => {
    const v = yaml.load(renderValues({}));
    expect(v.helix.endpoint).toBe('');
    expect(v.viewer.persistence.size).toBe('2Gi');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix backend test -- k8sChart-values`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// backend/k8sChart/renderValues.js
// PURE: render the chart's values.yaml from live state. Non-secret values
// (endpoint, xSource) are baked; the apiKey is ALWAYS empty (supplied via
// --set at install). Resource names are stable for Docker-parity DNS.
const yaml = require('js-yaml');

const DEFAULTS = {
  gatewayName: 'helix-gateway',
  viewerName: 'helix-viewer',
  collectorImage: 'otel/opentelemetry-collector-contrib',
  collectorTag: '0.119.0', // pinned; verify/bump to a validated contrib release
  viewerImage: 'helix-configurator',
  viewerTag: 'latest',
};

function renderValues({ endpoint = '', xSource = '', viewerEnabled = true } = {}) {
  const rl = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  const values = {
    helix: { endpoint, xSource, apiKey: '' },
    gateway: {
      name: DEFAULTS.gatewayName,
      image: { repository: DEFAULTS.collectorImage, tag: DEFAULTS.collectorTag, pullPolicy: 'IfNotPresent' },
      replicas: 1,
      resources: rl,
      service: { type: 'ClusterIP' },
    },
    viewer: {
      enabled: viewerEnabled,
      name: DEFAULTS.viewerName,
      image: { repository: DEFAULTS.viewerImage, tag: DEFAULTS.viewerTag, pullPolicy: 'IfNotPresent' },
      resources: rl,
      persistence: { size: '2Gi', storageClass: '' },
    },
  };
  return yaml.dump(values, { lineWidth: -1, noRefs: true });
}

module.exports = { renderValues, DEFAULTS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix backend test -- k8sChart-values`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/renderValues.js backend/__tests__/k8sChart-values.test.mjs
git commit -m "feat(k8s): renderValues bakes live state into chart values" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `buildChart` assembly + façade

**Files:**
- Create: `backend/k8sChart/buildChart.js`, `backend/k8sChart/index.js`
- Test: `backend/__tests__/k8sChart-build.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// backend/__tests__/k8sChart-build.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { buildChartFiles } from '../k8sChart/index.js';

const COLLECTOR = `
exporters:
  otlphttp/bmchelix: { endpoint: \${env:HELIX_ENDPOINT} }
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
service:
  pipelines:
    traces: { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    logs:   { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

describe('buildChartFiles', () => {
  it('returns values.yaml and gateway config consistent with the toggle (viewer on)', () => {
    const { values, gatewayConfig } = buildChartFiles({
      collectorYaml: COLLECTOR, endpoint: 'https://h/otlp', xSource: 'acme', viewerEnabled: true,
    });
    const v = yaml.load(values);
    const g = yaml.load(gatewayConfig);
    expect(v.viewer.enabled).toBe(true);
    expect(v.helix.endpoint).toBe('https://h/otlp');
    expect(g.exporters['otlphttp/helix_local_viewer'].traces_endpoint).toBe('http://helix-viewer:3001/api/otlp/traces');
  });

  it('strips the viewer exporter when the toggle is off', () => {
    const { values, gatewayConfig } = buildChartFiles({ collectorYaml: COLLECTOR, viewerEnabled: false });
    expect(yaml.load(values).viewer.enabled).toBe(false);
    expect(yaml.load(gatewayConfig).exporters['otlphttp/helix_local_viewer']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix backend test -- k8sChart-build`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// backend/k8sChart/buildChart.js
// Assembles the chart: the two generated files (from live state) + a streamer
// that globs the static skeleton and appends the generated files under the
// single `helix-otel/` chart directory. Mirrors demo.js's writePackageToArchive.
const { transformCollectorConfig } = require('./transformCollectorConfig');
const { renderValues } = require('./renderValues');

const CHART_DIR_NAME = 'helix-otel';

function buildChartFiles({ collectorYaml, endpoint = '', xSource = '', viewerEnabled = true, viewerServiceName = 'helix-viewer' }) {
  const gatewayConfig = transformCollectorConfig(collectorYaml, { viewerEnabled, viewerServiceName });
  const values = renderValues({ endpoint, xSource, viewerEnabled });
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

```js
// backend/k8sChart/index.js
// Façade for the k8s chart generator (the Phase-2 seam: this resource model is
// what a future @kubernetes/client-node layer will reconcile live).
module.exports = {
  ...require('./transformCollectorConfig'),
  ...require('./renderValues'),
  ...require('./buildChart'),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix backend test -- k8sChart-build`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/buildChart.js backend/k8sChart/index.js backend/__tests__/k8sChart-build.test.mjs
git commit -m "feat(k8s): chart assembly (buildChartFiles + streamChartArchive)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: The static chart skeleton

**Files (all Create):** `helix-otel/Chart.yaml`, `helix-otel/.helmignore`, and `helix-otel/templates/{_helpers.tpl, NOTES.txt, gateway-configmap.yaml, gateway-deployment.yaml, gateway-service.yaml, secret.yaml, viewer-deployment.yaml, viewer-service.yaml, viewer-pvc.yaml}`.

> No values.yaml and no config/ — those are generated (Task 3). Templates contain Go templating and are validated by Task 6's helm smoke test, not by raw YAML parsing.

- [ ] **Step 1: Create `helix-otel/Chart.yaml`**

```yaml
apiVersion: v2
name: helix-otel
description: BMC Helix OTel gateway (and optional local viewer), generated by the Helix Configurator.
type: application
version: 0.1.0
appVersion: "0.119.0"
```

> Before committing, verify `0.119.0` is a real `otel/opentelemetry-collector-contrib` release — helm does **not** pull images, so a bad tag won't fail `helm template`; it only surfaces as ImagePullBackOff at install. Check with `docker pull otel/opentelemetry-collector-contrib:0.119.0` (or the GitHub releases). If you bump it, update **both** this `appVersion` and `DEFAULTS.collectorTag` in `backend/k8sChart/renderValues.js`.

- [ ] **Step 2: Create `helix-otel/.helmignore`**

```
.git/
.DS_Store
*.tmp
*.bak
*.orig
```

- [ ] **Step 3: Create `helix-otel/templates/_helpers.tpl`**

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

{{/* Viewer selector labels. */}}
{{- define "helix-otel.viewer.selectorLabels" -}}
app.kubernetes.io/name: {{ .Values.viewer.name }}
app.kubernetes.io/component: viewer
{{- end -}}
```

- [ ] **Step 4: Create `helix-otel/templates/gateway-configmap.yaml`**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Values.gateway.name }}
  labels:
    {{- include "helix-otel.labels" . | nindent 4 }}
    {{- include "helix-otel.gateway.selectorLabels" . | nindent 4 }}
data:
  config.yaml: |
{{ .Files.Get "config/gateway-collector.yaml" | indent 4 }}
```

- [ ] **Step 5: Create `helix-otel/templates/gateway-deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Values.gateway.name }}
  labels:
    {{- include "helix-otel.labels" . | nindent 4 }}
    {{- include "helix-otel.gateway.selectorLabels" . | nindent 4 }}
spec:
  replicas: {{ .Values.gateway.replicas }}
  selector:
    matchLabels:
      {{- include "helix-otel.gateway.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "helix-otel.gateway.selectorLabels" . | nindent 8 }}
      annotations:
        checksum/config: {{ .Files.Get "config/gateway-collector.yaml" | sha256sum }}
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: collector
          image: "{{ .Values.gateway.image.repository }}:{{ .Values.gateway.image.tag }}"
          imagePullPolicy: {{ .Values.gateway.image.pullPolicy }}
          args: ["--config=/etc/otelcol-contrib/config.yaml"]
          ports:
            - { name: otlp-grpc, containerPort: 4317 }
            - { name: otlp-http, containerPort: 4318 }
            - { name: metrics, containerPort: 8888 }
            - { name: health, containerPort: 13133 }
          env:
            - name: HELIX_ENDPOINT
              value: {{ .Values.helix.endpoint | quote }}
            - name: X_SOURCE
              value: {{ .Values.helix.xSource | quote }}
            - name: HELIX_API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.gateway.name }}-helix
                  key: HELIX_API_KEY
          livenessProbe:
            httpGet: { path: /, port: 13133 }
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet: { path: /, port: 13133 }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            {{- toYaml .Values.gateway.resources | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: config
              mountPath: /etc/otelcol-contrib/config.yaml
              subPath: config.yaml
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: config
          configMap:
            name: {{ .Values.gateway.name }}
        - name: tmp
          emptyDir: {}
```

- [ ] **Step 6: Create `helix-otel/templates/gateway-service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Values.gateway.name }}
  labels:
    {{- include "helix-otel.labels" . | nindent 4 }}
    {{- include "helix-otel.gateway.selectorLabels" . | nindent 4 }}
spec:
  type: {{ .Values.gateway.service.type }}
  selector:
    {{- include "helix-otel.gateway.selectorLabels" . | nindent 4 }}
  ports:
    - { name: otlp-grpc, port: 4317, targetPort: 4317, protocol: TCP }
    - { name: otlp-http, port: 4318, targetPort: 4318, protocol: TCP }
    - { name: metrics, port: 8888, targetPort: 8888, protocol: TCP }
```

- [ ] **Step 7: Create `helix-otel/templates/secret.yaml`**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Values.gateway.name }}-helix
  labels:
    {{- include "helix-otel.labels" . | nindent 4 }}
type: Opaque
stringData:
  HELIX_API_KEY: {{ required "helix.apiKey is required — pass --set helix.apiKey=<TenantID::AccessKey::SecretKey>" .Values.helix.apiKey | quote }}
```

- [ ] **Step 8: Create `helix-otel/templates/viewer-deployment.yaml`**

```yaml
{{- if .Values.viewer.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Values.viewer.name }}
  labels:
    {{- include "helix-otel.labels" . | nindent 4 }}
    {{- include "helix-otel.viewer.selectorLabels" . | nindent 4 }}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      {{- include "helix-otel.viewer.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "helix-otel.viewer.selectorLabels" . | nindent 8 }}
    spec:
      terminationGracePeriodSeconds: 60
      securityContext:
        fsGroup: 1000
      containers:
        - name: viewer
          image: "{{ .Values.viewer.image.repository }}:{{ .Values.viewer.image.tag }}"
          imagePullPolicy: {{ .Values.viewer.image.pullPolicy }}
          ports:
            - { name: http, containerPort: 3001 }
          env:
            - name: OTEL_DB_PATH
              value: /app/data/otel-store.db
            - name: IS_DEMO_INSTALL
              value: "false"
          livenessProbe:
            httpGet: { path: /api/health, port: 3001 }
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet: { path: /api/health, port: 3001 }
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            {{- toYaml .Values.viewer.resources | nindent 12 }}
          volumeMounts:
            - name: data
              mountPath: /app/data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ .Values.viewer.name }}-data
{{- end }}
```

> The viewer intentionally has **no `runAsNonRoot`** — the configurator image runs as root today (spec §8). `fsGroup` keeps the PVC group-writable. Documented caveat for restricted-PSA/OpenShift.

- [ ] **Step 9: Create `helix-otel/templates/viewer-service.yaml`**

```yaml
{{- if .Values.viewer.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: {{ .Values.viewer.name }}
  labels:
    {{- include "helix-otel.labels" . | nindent 4 }}
    {{- include "helix-otel.viewer.selectorLabels" . | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "helix-otel.viewer.selectorLabels" . | nindent 4 }}
  ports:
    - { name: http, port: 3001, targetPort: 3001, protocol: TCP }
{{- end }}
```

- [ ] **Step 10: Create `helix-otel/templates/viewer-pvc.yaml`**

```yaml
{{- if .Values.viewer.enabled }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ .Values.viewer.name }}-data
  labels:
    {{- include "helix-otel.labels" . | nindent 4 }}
    {{- include "helix-otel.viewer.selectorLabels" . | nindent 4 }}
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: {{ .Values.viewer.persistence.size | quote }}
  {{- if .Values.viewer.persistence.storageClass }}
  storageClassName: {{ .Values.viewer.persistence.storageClass | quote }}
  {{- end }}
{{- end }}
```

- [ ] **Step 11: Create `helix-otel/templates/NOTES.txt`**

```
Helix OTel gateway installed as release "{{ .Release.Name }}" in namespace "{{ .Release.Namespace }}".

1) Point your apps at the gateway (in-cluster):
     OTEL_EXPORTER_OTLP_ENDPOINT=http://{{ .Values.gateway.name }}:4318
   (gRPC on :4317, Prometheus metrics on :8888)

{{- if .Values.viewer.enabled }}

2) View OTel Data locally (port-forward the viewer):
     kubectl port-forward -n {{ .Release.Namespace }} svc/{{ .Values.viewer.name }} 3001:3001
   then open http://localhost:3001/otel-data

   If the viewer pod is ImagePullBackOff on a local cluster, load the image first:
     kind load docker-image {{ .Values.viewer.image.repository }}:{{ .Values.viewer.image.tag }}
     # or:  minikube image load {{ .Values.viewer.image.repository }}:{{ .Values.viewer.image.tag }}
{{- end }}
```

- [ ] **Step 12: Verify the skeleton shape**

Run: `ls helix-otel helix-otel/templates && test ! -e helix-otel/values.yaml && test ! -e helix-otel/config && echo "skeleton OK (no values.yaml / config/)"`
Expected: lists the 2 top-level + 9 template files and prints `skeleton OK (no values.yaml / config/)`.

- [ ] **Step 13: Commit**

```bash
git add helix-otel
git commit -m "feat(k8s): static Helm chart skeleton (gateway + optional viewer)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: The `/api/k8s/chart` route + registration

**Files:**
- Create: `backend/routes/k8s.js`
- Modify: `backend/index.js` (register), `backend/package.json` (add `adm-zip` devDependency)
- Test: `backend/__tests__/k8s-routes.test.mjs`

- [ ] **Step 1: Add the `adm-zip` devDependency**

Run (installs into the symlinked, shared backend node_modules — additive, harmless to the other worktree):
```bash
npm --prefix backend install --save-dev adm-zip@^0.5.16
```
Expected: `backend/package.json` gains `"adm-zip": "^0.5.16"` under devDependencies.

- [ ] **Step 2: Write the failing test**

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
  otlphttp/bmchelix: { endpoint: \${env:HELIX_ENDPOINT} }
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

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-route-'));
  configPath = path.join(tmpDir, 'helix-otel-collector.yaml');
  fs.writeFileSync(configPath, FIXTURE);
  process.env.HELIX_ENDPOINT = 'https://helix.example/otlp';
  process.env.X_SOURCE = 'acme-otel';
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('GET /api/k8s/chart/preview', () => {
  it('returns generated values, gateway config, install command and file list', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?viewer=true');
    expect(res.status).toBe(200);
    expect(yaml.load(res.body.values).helix.endpoint).toBe('https://helix.example/otlp');
    expect(yaml.load(res.body.gatewayConfig).exporters['otlphttp/helix_local_viewer'].traces_endpoint)
      .toBe('http://helix-viewer:3001/api/otlp/traces');
    expect(res.body.installCommand).toMatch(/helm install helix \.\/helix-otel/);
    expect(res.body.files).toContain('helix-otel/templates/gateway-deployment.yaml');
  });

  it('viewer=false strips the viewer exporter in the previewed config', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?viewer=false');
    expect(yaml.load(res.body.gatewayConfig).exporters['otlphttp/helix_local_viewer']).toBeUndefined();
  });

  it('returns 400 on malformed live collector YAML', async () => {
    fs.writeFileSync(configPath, ':\n::');
    const res = await request(makeApp()).get('/api/k8s/chart/preview');
    expect(res.status).toBe(400);
    fs.writeFileSync(configPath, FIXTURE); // restore
  });
});

describe('GET /api/k8s/chart', () => {
  it('streams a zip containing the full chart with the generated files', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart?viewer=true')
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
      'helix-otel/templates/viewer-pvc.yaml',
    ]) expect(names).toContain(f);

    // Non-template generated files parse as YAML.
    const zip = new AdmZip(res.body);
    expect(yaml.load(zip.getEntry('helix-otel/values.yaml').getData().toString())).toBeTruthy();
    expect(yaml.load(zip.getEntry('helix-otel/config/gateway-collector.yaml').getData().toString())).toBeTruthy();
    expect(yaml.load(zip.getEntry('helix-otel/Chart.yaml').getData().toString()).name).toBe('helix-otel');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm --prefix backend test -- k8s-routes`
Expected: FAIL — `Cannot find module '../routes/k8s.js'`.

- [ ] **Step 4: Write the route implementation**

```js
// backend/routes/k8s.js
// Phase 1 "Generate K8s chart": stream a self-contained Helm chart (or preview
// it as JSON) built from live configurator state. Generate-only — no cluster calls.
// Reuses the archiver streaming pattern from routes/demo.js. Registered under
// requireAuth (an authed dashboard action).
const fs = require('fs').promises;
const archiver = require('archiver');
const { buildChartFiles, streamChartArchive } = require('../k8sChart');

const INSTALL_COMMAND = 'helm install helix ./helix-otel --set helix.apiKey=<TenantID::AccessKey::SecretKey>';
const CHART_FILES = [
  'helix-otel/Chart.yaml',
  'helix-otel/values.yaml',
  'helix-otel/config/gateway-collector.yaml',
  'helix-otel/templates/gateway-configmap.yaml',
  'helix-otel/templates/gateway-deployment.yaml',
  'helix-otel/templates/gateway-service.yaml',
  'helix-otel/templates/secret.yaml',
  'helix-otel/templates/viewer-deployment.yaml',
  'helix-otel/templates/viewer-service.yaml',
  'helix-otel/templates/viewer-pvc.yaml',
];

const wantsViewer = (req) => String(req.query.viewer ?? 'true').toLowerCase() !== 'false';

function register(app, { configPath, projectRoot }) {
  // Build the two generated files from live state, or send an error response.
  // Returns null after responding on failure.
  async function generate(req, res) {
    let collectorYaml;
    try {
      collectorYaml = await fs.readFile(configPath, 'utf8');
    } catch {
      res.status(500).json({ error: 'Failed to read gateway config' });
      return null;
    }
    try {
      return buildChartFiles({
        collectorYaml,
        endpoint: process.env.HELIX_ENDPOINT || '',
        xSource: process.env.X_SOURCE || '',
        viewerEnabled: wantsViewer(req),
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
    res.json({
      viewerEnabled: wantsViewer(req),
      values: files.values,
      gatewayConfig: files.gatewayConfig,
      installCommand: INSTALL_COMMAND,
      files: CHART_FILES,
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

- [ ] **Step 5: Register the route in `backend/index.js`**

Add after the other authed route registrations (after the `require('./routes/env').register(app);` line, ~line 111):

```js
require('./routes/k8s').register(app, {
  configPath: CONFIG_PATH,
  projectRoot: path.resolve(__dirname, '..'),
});
```

(`CONFIG_PATH` and `path` are already defined at the top of `backend/index.js`.)

- [ ] **Step 6: Run the route test to verify it passes**

Run: `npm --prefix backend test -- k8s-routes`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/routes/k8s.js backend/index.js backend/package.json backend/package-lock.json backend/__tests__/k8s-routes.test.mjs
git commit -m "feat(k8s): chart preview + zip-download route, wired into the app" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Helm smoke test (gated on `helm` availability)

**Files:**
- Create: `backend/__tests__/k8s-helm-smoke.test.mjs`

> This is the only check that validates the **templates** (they contain Go templating and can't be parsed as raw YAML). It assembles a full chart on disk (skeleton + generated files) and runs `helm lint` + `helm template`. It **skips** when `helm` is not installed, so CI without helm still passes.

- [ ] **Step 1: Write the test**

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

function assembleChart(destRoot, viewerEnabled) {
  const dest = path.join(destRoot, 'helix-otel');
  fs.cpSync(SKELETON, dest, { recursive: true });
  const collectorYaml = fs.readFileSync(path.join(PROJECT_ROOT, 'helix-otel-collector.yaml'), 'utf8');
  const { values, gatewayConfig } = buildChartFiles({ collectorYaml, endpoint: 'https://h/otlp', xSource: 'acme', viewerEnabled });
  fs.writeFileSync(path.join(dest, 'values.yaml'), values);
  fs.mkdirSync(path.join(dest, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'config', 'gateway-collector.yaml'), gatewayConfig);
  return dest;
}

describe.skipIf(!helmAvailable())('helm smoke', () => {
  for (const viewer of [true, false]) {
    it(`renders valid manifests (viewer=${viewer})`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-smoke-'));
      try {
        const chart = assembleChart(tmp, viewer);
        execFileSync('helm', ['lint', chart, '--set', 'helix.apiKey=dummy'], { stdio: 'pipe' });
        const out = execFileSync('helm', ['template', 'helix', chart, '--set', 'helix.apiKey=dummy'], { encoding: 'utf8' });
        const docs = yaml.loadAll(out).filter(Boolean);
        const kinds = docs.map(d => d.kind);
        expect(kinds).toContain('Deployment');
        expect(kinds).toContain('ConfigMap');
        expect(kinds).toContain('Secret');
        // Viewer objects present only when enabled.
        expect(kinds.includes('PersistentVolumeClaim')).toBe(viewer);
        // Gateway ConfigMap embeds the collector config.
        const cm = docs.find(d => d.kind === 'ConfigMap');
        expect(cm.data['config.yaml']).toMatch(/otlphttp\/bmchelix/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `npm --prefix backend test -- k8s-helm-smoke`
Expected: PASS if `helm` is installed (2 tests) — manifests render and parse; or **SKIPPED** if `helm` is absent (acceptable). If it FAILS with helm present, fix the templates per the error, then re-run.

- [ ] **Step 3: Commit**

```bash
git add backend/__tests__/k8s-helm-smoke.test.mjs
git commit -m "test(k8s): helm lint/template smoke test (skips without helm)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Frontend modal + launch button + README

**Files:**
- Create: `frontend/src/components/K8sChartModal.tsx`
- Modify: `frontend/src/App.tsx` (state, button, render), `README.md`

> No vitest component test — this repo has no React component-test harness (all frontend tests are pure-util `.test.ts`). Verification is the TypeScript build (Step 4).

- [ ] **Step 1: Create `frontend/src/components/K8sChartModal.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';
import { SnippetBlock } from './SnippetBlock';

type Preview = { values: string; gatewayConfig: string; installCommand: string; files: string[] };
type Props = { isOpen: boolean; onClose: () => void };

// "Generate Kubernetes deployment" — previews and downloads a self-contained
// Helm chart (gateway + optional viewer), pre-wired to Helix from live state.
export const K8sChartModal: React.FC<Props> = ({ isOpen, onClose }) => {
  useEscClose(isOpen, onClose);
  const [viewerEnabled, setViewerEnabled] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/k8s/chart/preview?viewer=${viewerEnabled}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) setPreview(d); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, viewerEnabled]);

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
          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={viewerEnabled} onChange={e => setViewerEnabled(e.target.checked)} className="accent-primary w-4 h-4" />
            Include the local “View OTel Data” viewer (Deployment + PVC)
          </label>

          <div className="flex items-center gap-3 text-sm text-gray-500">
            <input type="checkbox" checked={false} disabled className="w-4 h-4" />
            Use the OpenTelemetry Operator <span className="text-tiny px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700">coming soon</span>
          </div>

          {error && <div className="text-xs text-error-text bg-error/10 border border-error/40 rounded p-3">{error}</div>}
          {loading && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Generating preview…</div>}

          {preview && !loading && (
            <>
              <div>
                <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">Install</p>
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
            href={`/api/k8s/chart?viewer=${viewerEnabled}`}
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

- [ ] **Step 2: Wire it into `App.tsx`**

Mirror the existing `TemplatesModal` / `onOpenGatewayConfig` pattern:

1. Add the import near the other component imports (~line 18):
```tsx
import { K8sChartModal } from './components/K8sChartModal';
```
2. Add state near the other modal state (~line 109):
```tsx
const [showK8sChart, setShowK8sChart] = useState(false);
```
3. Render the modal beside `<TemplatesModal ... />` (~line 1466):
```tsx
<K8sChartModal isOpen={showK8sChart} onClose={() => setShowK8sChart(false)} />
```
4. Add a launch button next to the existing Gateway Config action. The gateway-config action is threaded as `onOpenGatewayConfig={openGatewayConfigModal}` into a dashboard child (~line 1268). Add a sibling `onOpenK8sChart={() => setShowK8sChart(true)}` prop along the same path, and render a button next to the existing "Gateway Config" button in that child component:
```tsx
<button
  onClick={onOpenK8sChart}
  className="bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-1.5 rounded text-tiny font-semibold transition-colors"
>
  Generate K8s deployment
</button>
```
If the dashboard child's prop types are declared in its own file, add `onOpenK8sChart: () => void;` to that prop type. (Search for `onOpenGatewayConfig` to find every site that needs the parallel `onOpenK8sChart`.)

- [ ] **Step 3: Add a README section**

Add to `README.md` (after the install-bundle / onboarding material), keeping the repo's heading style:

```markdown
## Generate a Kubernetes chart

From the dashboard, **Generate K8s deployment** emits a self-contained Helm chart
(`helix-otel/`) wired to your Helix tenant from the current config:

```bash
unzip helix-otel-chart.zip
helm install helix ./helix-otel --set helix.apiKey=<TenantID::AccessKey::SecretKey>
```

Point apps at `http://helix-gateway:4318`. The local viewer (on by default) is reached with
`kubectl port-forward svc/helix-viewer 3001:3001`. On a local cluster, load the viewer image
once with `kind load docker-image helix-configurator:latest` (or `minikube image load …`).
Disable the viewer by unchecking it before download (or `--set viewer.enabled=false`).
```

- [ ] **Step 4: Verify the frontend builds (typecheck)**

Run: `npm --prefix frontend run build`
Expected: build succeeds (no TypeScript errors). If `onOpenK8sChart` prop-type errors appear, add the prop type at the flagged site(s) and re-run.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/K8sChartModal.tsx frontend/src/App.tsx README.md
git commit -m "feat(k8s): K8sChartModal + dashboard action + README" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Full-suite verification + mark spec done

**Files:**
- Modify: `docs/superpowers/specs/2026-06-03-generate-k8s-chart-design.md` (status line)

- [ ] **Step 1: Run the full backend + frontend suites**

Run: `npm --prefix backend test && CI=true npm --prefix frontend test -- --run`
Expected: backend all green (baseline 239 + the new k8s tests), frontend all green (87). No regressions.

- [ ] **Step 2: Manual smoke (optional, if a backend dev server is handy)**

Run: `curl -s 'http://localhost:8765/api/k8s/chart/preview?viewer=true' | head -c 400` (requires the configurator running + an auth session if `UI_AUTH_PASSWORD` is set).
Expected: JSON with `values`, `gatewayConfig`, `installCommand`. Skip if no server is running.

- [ ] **Step 3: Update the spec status to Implemented**

Change the spec header `Status: **Draft for review**` → `Status: **Implemented** (feat/generate-k8s-chart)`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-03-generate-k8s-chart-design.md
git commit -m "docs(k8s): mark Generate K8s chart spec implemented" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (author checklist — completed)

**Spec coverage:** chart contents (§6 → Task 4) · transform (§5 → Task 1) · renderValues/toggle (§7 → Task 2) · assembly/zip (§4 → Tasks 3,5) · routes (§9 → Task 5) · UI (§9 → Task 7) · securityContext + root-image caveat (§8 → Task 4 steps 5,8) · error handling (§10 → Task 5) · testing incl. helm-gated smoke (§11 → Tasks 1-6) · README (§12 → Task 7). Frontend component test from §11 intentionally dropped — no component-test harness in the repo (verified); replaced by the TS build gate.

**Placeholder scan:** none — every step has full code/commands. The `0.119.0` pin is a concrete default; since helm does not pull images, a bad tag won't fail `helm template`, so Task 4 Step 1 carries a manual registry check (a wrong tag only surfaces as ImagePullBackOff at install).

**Type/name consistency:** `transformCollectorConfig(yaml, {viewerEnabled, viewerServiceName})`, `renderValues({endpoint,xSource,viewerEnabled})`, `buildChartFiles({collectorYaml,endpoint,xSource,viewerEnabled,viewerServiceName})`, `streamChartArchive(archive,{projectRoot,files})`, `register(app,{configPath,projectRoot})`, `VIEWER_EXPORTER_KEY='otlphttp/helix_local_viewer'`, stable names `helix-gateway`/`helix-viewer`, secret `helix-gateway-helix` key `HELIX_API_KEY`, viewer Service `helix-viewer` ↔ transform default `viewerServiceName='helix-viewer'`, PVC `helix-viewer-data` ↔ deployment `claimName` — all consistent across tasks.
