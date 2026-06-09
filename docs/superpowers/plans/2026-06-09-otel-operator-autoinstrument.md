# OTel Operator + Auto-Instrumentation Target — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third onboarding target, *Kubernetes — OTel Operator*, that generates a separate `helix-otel-operator/` Helm chart expressing the gateway as an `OpenTelemetryCollector` CR plus an `Instrumentation` CR for zero-code auto-instrumentation (Java/Node/Python/.NET) — purely additive to the existing `docker`/`kubernetes` paths.

**Architecture:** The frontend `WizardTarget` toggle gains a `'kubernetes-operator'` value (a third `TargetSelector` card). The backend chart generator gains an `engine=deployment|operator` axis: `engine=operator` streams the new `helix-otel-operator/` skeleton instead of `helix-otel/`. Generate-only — the configurator emits the chart + pinned prerequisite/install/annotate commands; the user applies them. Exactly one chart renders per request; the existing `helix-otel/` chart and `kubernetes` path are never touched.

**Tech Stack:** Node/Express backend (`backend/k8sChart/`, `backend/routes/k8s.js`), Vitest tests (`backend/__tests__/`), Helm chart (Go templates), React/TypeScript frontend (`frontend/src/components/wizard/`), static HTML walkthrough (`frontend/public/`).

**Spec:** [`docs/superpowers/specs/2026-06-09-otel-operator-autoinstrument-design.md`](../specs/2026-06-09-otel-operator-autoinstrument-design.md)

**Working directory:** worktree `/Users/jammicha/dev/HelixConfigurator-otel-operator`, branch `brainstorm/otel-operator-autoinstrument`. Run all commands from there.

**Test commands:**
- Backend: `cd backend && npx vitest run <file>` (or `npm test` for all)
- Frontend: `cd frontend && npx vitest run <file>` and `npm run build` (tsc typecheck)

---

## Key contracts (consistent across all tasks)

- **`engine`**: `'deployment'` (default) | `'operator'`. Read from `req.query.engine` in routes; threaded into `buildChartFiles({ engine })`.
- **`buildChartFiles({ collectorYaml, endpoint, xSource, target, engine })`** returns `{ values, gatewayConfig }`. For `engine='operator'`, `values` is the operator values shape and `CHART_DIR_NAME` resolves to `helix-otel-operator`.
- **Operator values shape** (from `renderValues({ engine:'operator', ... })`):
  ```yaml
  helix: { endpoint, xSource, apiKey: '', existingSecret: '', existingSecretKey: HELIX_API_KEY }
  gateway:
    name: helix-gateway
    image: { repository: otel/opentelemetry-collector-contrib, tag: <DEFAULTS.collectorTag>, pullPolicy: IfNotPresent }
    replicas: 1
    resources: { requests: {cpu: 100m, memory: 256Mi}, limits: {cpu: '1', memory: 512Mi} }
    aliasService: true
  instrumentation:
    languages: { java: true, nodejs: true, python: true, dotnet: true }
    images:    { java: '', nodejs: '', python: '', dotnet: '' }
  ```
- **Generated collector config** is the SAME file for both engines: `config/gateway-collector.yaml`, produced by the existing `transformCollectorConfig` (no change). The operator chart embeds it under the CR's `spec.config:`.
- **Gateway DNS parity**: the operator chart ships an alias `Service` named `helix-gateway` so `k8sGatewayEndpoint(ns)` (`http://helix-gateway.<ns>.svc.cluster.local:4318`) keeps working.
- **Prereq versions** live as named constants in `backend/k8sChart/operatorPrereqs.js`.

---

# Phase A — Backend + chart (TDD)

## Task A1: Pinned prerequisite versions module

**Files:**
- Create: `backend/k8sChart/operatorPrereqs.js`
- Test: `backend/__tests__/k8sChart-operator-prereqs.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// backend/__tests__/k8sChart-operator-prereqs.test.mjs
import { describe, it, expect } from 'vitest';
import { CERT_MANAGER_VERSION, OPERATOR_VERSION, prereqCommands } from '../k8sChart/operatorPrereqs.js';

describe('operatorPrereqs', () => {
  it('pins concrete versions (not "latest")', () => {
    expect(CERT_MANAGER_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(OPERATOR_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('prereqCommands references the pinned versions and waits for readiness', () => {
    const c = prereqCommands();
    expect(c.certManager).toContain(`cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`);
    expect(c.operator).toContain(`opentelemetry-operator/releases/download/${OPERATOR_VERSION}/opentelemetry-operator.yaml`);
    // A wait gate between the two installs (cert-manager webhook must be up first).
    expect(c.waitCertManager).toMatch(/kubectl wait.*cert-manager/);
    expect(c.waitOperator).toMatch(/kubectl wait.*opentelemetry-operator-system|kubectl rollout status/);
  });
});
```

- [ ] **Step 2: Run it; expect FAIL** (module missing)

Run: `cd backend && npx vitest run __tests__/k8sChart-operator-prereqs.test.mjs`
Expected: FAIL — "Cannot find module '../k8sChart/operatorPrereqs.js'"

- [ ] **Step 3: Implement**

```js
// backend/k8sChart/operatorPrereqs.js
// Pinned, validated prerequisite versions for the OTel-Operator chart path.
// Bump these together after smoke-testing a newer pair. Pinning the Operator
// version transitively pins the default auto-instrumentation agent images
// (we intentionally don't pin those in the Instrumentation CR).
const CERT_MANAGER_VERSION = 'v1.19.5';
const OPERATOR_VERSION = 'v0.152.0';

function prereqCommands() {
  return {
    certManager: `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`,
    waitCertManager: 'kubectl wait --for=condition=Available --timeout=180s -n cert-manager deploy/cert-manager-webhook',
    operator: `kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/download/${OPERATOR_VERSION}/opentelemetry-operator.yaml`,
    waitOperator: 'kubectl rollout status -n opentelemetry-operator-system deploy/opentelemetry-operator --timeout=180s',
  };
}

module.exports = { CERT_MANAGER_VERSION, OPERATOR_VERSION, prereqCommands };
```

> NOTE: `v1.19.5` (cert-manager) and `v0.152.0` (OTel Operator) are the initial pins. In Step 4, if either URL 404s when you later smoke-install, bump to the newest matching the `vX.Y.Z` shape and re-run. The unit test only checks shape + wiring, not network.

- [ ] **Step 4: Run it; expect PASS**

Run: `cd backend && npx vitest run __tests__/k8sChart-operator-prereqs.test.mjs`
Expected: PASS (3 assertions)

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/operatorPrereqs.js backend/__tests__/k8sChart-operator-prereqs.test.mjs
git commit -m "feat(k8s): pinned cert-manager + OTel Operator prereq versions module"
```

---

## Task A2: `renderValues` gains an `engine` parameter (operator values)

**Files:**
- Modify: `backend/k8sChart/renderValues.js`
- Test: `backend/__tests__/k8sChart-values.test.mjs` (add a describe block; do not change existing tests)

- [ ] **Step 1: Add failing tests** (append to the existing file, after the existing `describe`)

```js
// --- appended: operator engine ---
import { renderValues as rv2 } from '../k8sChart/renderValues.js';

describe('renderValues (engine=operator)', () => {
  it('emits instrumentation languages (all four on) and empty image overrides', () => {
    const v = yaml.load(rv2({ endpoint: 'https://h/otlp', xSource: 'acme', engine: 'operator' }));
    expect(v.instrumentation.languages).toEqual({ java: true, nodejs: true, python: true, dotnet: true });
    expect(v.instrumentation.images).toEqual({ java: '', nodejs: '', python: '', dotnet: '' });
  });

  it('bakes endpoint/xSource, never the apiKey, and sets aliasService', () => {
    const v = yaml.load(rv2({ endpoint: 'https://h/otlp', xSource: 'acme', engine: 'operator' }));
    expect(v.helix.endpoint).toBe('https://h/otlp');
    expect(v.helix.xSource).toBe('acme');
    expect(v.helix.apiKey).toBe('');
    expect(v.gateway.name).toBe('helix-gateway');
    expect(v.gateway.aliasService).toBe(true);
  });

  it('respects an explicit languages override', () => {
    const v = yaml.load(rv2({ engine: 'operator', languages: { java: true, nodejs: false, python: false, dotnet: false } }));
    expect(v.instrumentation.languages).toEqual({ java: true, nodejs: false, python: false, dotnet: false });
  });

  it('engine=deployment (default) is unchanged — no instrumentation key', () => {
    const v = yaml.load(rv2({ endpoint: 'x' }));
    expect(v.instrumentation).toBeUndefined();
    expect(v.gateway.service.type).toBe('ClusterIP');
  });
});
```

- [ ] **Step 2: Run; expect FAIL**

Run: `cd backend && npx vitest run __tests__/k8sChart-values.test.mjs`
Expected: FAIL — operator block undefined / `instrumentation` undefined.

- [ ] **Step 3: Implement** — replace the body of `renderValues` in `backend/k8sChart/renderValues.js`:

```js
// backend/k8sChart/renderValues.js
const yaml = require('js-yaml');

const DEFAULTS = {
  gatewayName: 'helix-gateway',
  collectorImage: 'otel/opentelemetry-collector-contrib',
  collectorTag: '0.119.0', // pinned; verify/bump to a validated contrib release
};

const ALL_LANGUAGES = { java: true, nodejs: true, python: true, dotnet: true };

function renderValues({ endpoint = '', xSource = '', engine = 'deployment', languages } = {}) {
  const rl = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  const helix = { endpoint, xSource, apiKey: '', existingSecret: '', existingSecretKey: 'HELIX_API_KEY' };
  const gateway = {
    name: DEFAULTS.gatewayName,
    image: { repository: DEFAULTS.collectorImage, tag: DEFAULTS.collectorTag, pullPolicy: 'IfNotPresent' },
    replicas: 1,
    resources: rl,
  };

  if (engine === 'operator') {
    gateway.aliasService = true;
    const langs = { ...ALL_LANGUAGES, ...(languages || {}) };
    const values = {
      helix,
      gateway,
      instrumentation: {
        languages: langs,
        images: { java: '', nodejs: '', python: '', dotnet: '' },
      },
    };
    return yaml.dump(values, { lineWidth: -1, noRefs: true });
  }

  // engine === 'deployment' (unchanged shape)
  gateway.service = { type: 'ClusterIP' };
  return yaml.dump({ helix, gateway }, { lineWidth: -1, noRefs: true });
}

module.exports = { renderValues, DEFAULTS };
```

- [ ] **Step 4: Run; expect PASS** (existing 4 + new 4)

Run: `cd backend && npx vitest run __tests__/k8sChart-values.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/renderValues.js backend/__tests__/k8sChart-values.test.mjs
git commit -m "feat(k8s): renderValues engine=operator (instrumentation languages + alias service)"
```

---

## Task A3: `buildChart` gains an `engine` parameter (chart dir selection)

**Files:**
- Modify: `backend/k8sChart/buildChart.js`
- Test: `backend/__tests__/k8sChart-build.test.mjs` (append; keep existing tests)

- [ ] **Step 1: Add failing tests** (append after the existing `describe`)

```js
// --- appended: operator engine ---
describe('buildChartFiles (engine=operator)', () => {
  it('produces operator values + the same gateway config, viewer rewritten for local', () => {
    const { values, gatewayConfig } = buildChartFiles({
      collectorYaml: COLLECTOR, endpoint: 'https://h/otlp', xSource: 'acme', target: 'local', engine: 'operator',
    });
    const v = yaml.load(values);
    const g = yaml.load(gatewayConfig);
    expect(v.instrumentation.languages.java).toBe(true);
    expect(v.gateway.aliasService).toBe(true);
    expect(g.exporters['otlphttp/helix_local_viewer'].traces_endpoint).toBe('http://host.docker.internal:8765/api/otlp/traces');
  });
});

describe('CHART_DIR_NAME by engine', () => {
  it('resolves operator vs deployment skeleton dir', async () => {
    const { chartDirForEngine } = await import('../k8sChart/buildChart.js');
    expect(chartDirForEngine('operator')).toBe('helix-otel-operator');
    expect(chartDirForEngine('deployment')).toBe('helix-otel');
    expect(chartDirForEngine(undefined)).toBe('helix-otel');
  });
});
```

- [ ] **Step 2: Run; expect FAIL** (`chartDirForEngine` missing; operator branch absent)

Run: `cd backend && npx vitest run __tests__/k8sChart-build.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** — replace `backend/k8sChart/buildChart.js`:

```js
// backend/k8sChart/buildChart.js
// Assembles the chart: the two generated files (from live state) + a streamer
// that globs the static skeleton and appends the generated files. The skeleton
// dir is engine-dependent: helix-otel (Deployment) or helix-otel-operator (CRs).
const { transformCollectorConfig } = require('./transformCollectorConfig');
const { renderValues } = require('./renderValues');

const CHART_DIR_DEPLOYMENT = 'helix-otel';
const CHART_DIR_OPERATOR = 'helix-otel-operator';

function chartDirForEngine(engine) {
  return engine === 'operator' ? CHART_DIR_OPERATOR : CHART_DIR_DEPLOYMENT;
}

function buildChartFiles({ collectorYaml, endpoint = '', xSource = '', target = 'local', engine = 'deployment', languages } = {}) {
  const gatewayConfig = transformCollectorConfig(collectorYaml, { target });
  const values = renderValues({ endpoint, xSource, engine, languages });
  return { values, gatewayConfig };
}

// `archive` is an archiver('zip') instance; `projectRoot` contains the skeleton.
// `files` is the buildChartFiles() result; `engine` selects the skeleton dir.
function streamChartArchive(archive, { projectRoot, files, engine = 'deployment' }) {
  const dir = chartDirForEngine(engine);
  archive.glob(`${dir}/**`, { cwd: projectRoot, dot: true });
  archive.append(files.values, { name: `${dir}/values.yaml` });
  archive.append(files.gatewayConfig, { name: `${dir}/config/gateway-collector.yaml` });
}

module.exports = {
  buildChartFiles, streamChartArchive, chartDirForEngine,
  CHART_DIR_NAME: CHART_DIR_DEPLOYMENT, // back-compat export
  CHART_DIR_DEPLOYMENT, CHART_DIR_OPERATOR,
};
```

- [ ] **Step 4: Run; expect PASS** (existing 2 + new 2)

Run: `cd backend && npx vitest run __tests__/k8sChart-build.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/k8sChart/buildChart.js backend/__tests__/k8sChart-build.test.mjs
git commit -m "feat(k8s): buildChart engine param selects helix-otel-operator skeleton"
```

---

## Task A4: Operator chart skeleton — static files

**Files (all Create):**
- `helix-otel-operator/Chart.yaml`
- `helix-otel-operator/.helmignore`
- `helix-otel-operator/templates/_helpers.tpl`
- `helix-otel-operator/templates/collector.yaml`
- `helix-otel-operator/templates/instrumentation.yaml`
- `helix-otel-operator/templates/gateway-service-alias.yaml`
- `helix-otel-operator/templates/secret.yaml`
- `helix-otel-operator/templates/NOTES.txt`

No unit test here (validated by the helm-smoke test in Task A7). This task is pure file creation.

- [ ] **Step 1: `helix-otel-operator/Chart.yaml`**

```yaml
apiVersion: v2
name: helix-otel-operator
description: BMC Helix OTel gateway (OpenTelemetryCollector CR) + zero-code auto-instrumentation (Instrumentation CR), generated by the Helix Configurator. Requires the OpenTelemetry Operator.
type: application
version: 0.1.0
appVersion: "0.119.0"
```

- [ ] **Step 2: `helix-otel-operator/.helmignore`**

```
.DS_Store
*.tmp
```

- [ ] **Step 3: `helix-otel-operator/templates/_helpers.tpl`**

```
{{/* Common labels applied to chart-managed objects. */}}
{{- define "helix-otel-operator.labels" -}}
app.kubernetes.io/managed-by: helix-configurator
app.kubernetes.io/part-of: helix-otel
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Selector that matches the Operator-managed collector pods for the alias Service.
     The OTel Operator labels collector pods with these keys; instance is <ns>.<cr-name>. */}}
{{- define "helix-otel-operator.collectorSelector" -}}
app.kubernetes.io/component: opentelemetry-collector
app.kubernetes.io/instance: {{ .Release.Namespace }}.{{ .Values.gateway.name }}
{{- end -}}
```

- [ ] **Step 4: `helix-otel-operator/templates/collector.yaml`**

```
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: {{ .Values.gateway.name }}
  labels:
    {{- include "helix-otel-operator.labels" . | nindent 4 }}
spec:
  mode: deployment
  replicas: {{ .Values.gateway.replicas }}
  image: "{{ .Values.gateway.image.repository }}:{{ .Values.gateway.image.tag }}"
  imagePullPolicy: {{ .Values.gateway.image.pullPolicy }}
  resources:
    {{- toYaml .Values.gateway.resources | nindent 4 }}
  env:
    - name: HELIX_ENDPOINT
      value: {{ .Values.helix.endpoint | quote }}
    - name: X_SOURCE
      value: {{ .Values.helix.xSource | quote }}
    - name: HELIX_API_KEY
      valueFrom:
        secretKeyRef:
          name: {{ .Values.helix.existingSecret | default (printf "%s-helix" .Values.gateway.name) }}
          key: {{ .Values.helix.existingSecretKey | default "HELIX_API_KEY" }}
  config:
{{ .Files.Get "config/gateway-collector.yaml" | indent 4 }}
```

> The Operator derives container ports from the receivers in `config:` and wires
> liveness/readiness from the `health_check` extension (always injected by
> `transformCollectorConfig`). It creates a managed Deployment + a Service named
> `{{ .Values.gateway.name }}-collector`.

- [ ] **Step 5: `helix-otel-operator/templates/instrumentation.yaml`**

```
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: helix-instrumentation
  labels:
    {{- include "helix-otel-operator.labels" . | nindent 4 }}
spec:
  exporter:
    endpoint: "http://{{ .Values.gateway.name }}.{{ .Release.Namespace }}.svc.cluster.local:4318"
  propagators:
    - tracecontext
    - baggage
  sampler:
    type: parentbased_traceidratio
    argument: "1.0"
{{- if .Values.instrumentation.languages.java }}
{{- if .Values.instrumentation.images.java }}
  java:
    image: {{ .Values.instrumentation.images.java | quote }}
{{- else }}
  java: {}
{{- end }}
{{- end }}
{{- if .Values.instrumentation.languages.nodejs }}
{{- if .Values.instrumentation.images.nodejs }}
  nodejs:
    image: {{ .Values.instrumentation.images.nodejs | quote }}
{{- else }}
  nodejs: {}
{{- end }}
{{- end }}
{{- if .Values.instrumentation.languages.python }}
{{- if .Values.instrumentation.images.python }}
  python:
    image: {{ .Values.instrumentation.images.python | quote }}
{{- else }}
  python: {}
{{- end }}
{{- end }}
{{- if .Values.instrumentation.languages.dotnet }}
{{- if .Values.instrumentation.images.dotnet }}
  dotnet:
    image: {{ .Values.instrumentation.images.dotnet | quote }}
{{- else }}
  dotnet: {}
{{- end }}
{{- end }}
```

- [ ] **Step 6: `helix-otel-operator/templates/gateway-service-alias.yaml`**

```
{{- if .Values.gateway.aliasService }}
{{- /* Stable DNS alias so apps + the Instrumentation exporter can reach the
       gateway at helix-gateway:4318 (the Operator's own Service is named
       <cr-name>-collector). Selects the Operator-managed collector pods. */ -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .Values.gateway.name }}
  labels:
    {{- include "helix-otel-operator.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "helix-otel-operator.collectorSelector" . | nindent 4 }}
  ports:
    - { name: otlp-grpc, port: 4317, targetPort: 4317, protocol: TCP }
    - { name: otlp-http, port: 4318, targetPort: 4318, protocol: TCP }
{{- end }}
```

- [ ] **Step 7: `helix-otel-operator/templates/secret.yaml`** (identical pattern to the deployment chart)

```
{{- /* Only create a chart-managed Secret when the user hasn't supplied their own.
       Best practice: pre-create a Secret out-of-band and set helix.existingSecret. */ -}}
{{- if not .Values.helix.existingSecret }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Values.gateway.name }}-helix
  labels:
    {{- include "helix-otel-operator.labels" . | nindent 4 }}
type: Opaque
stringData:
  HELIX_API_KEY: {{ required "Provide the Helix API key: pre-create a Secret and pass --set helix.existingSecret=<name> (recommended), or --set helix.apiKey=<TenantID::AccessKey::SecretKey> (quick demo)." .Values.helix.apiKey | quote }}
{{- end }}
```

- [ ] **Step 8: `helix-otel-operator/templates/NOTES.txt`**

```
Helix OTel Operator chart installed as release "{{ .Release.Name }}" in namespace "{{ .Release.Namespace }}".

PREREQUISITE: this chart needs the OpenTelemetry Operator (and cert-manager) already
installed. If `helm install` failed with 'no matches for kind "OpenTelemetryCollector"',
install them first — see k8s-operator-walkthrough.html (the in-app "Full walkthrough" link).

1) The Operator is reconciling the gateway as an OpenTelemetryCollector CR.
   Check it came up:
     kubectl get opentelemetrycollector,pods -l app.kubernetes.io/component=opentelemetry-collector -n {{ .Release.Namespace }}
   Apps reach it in-cluster at:
     http://{{ .Values.gateway.name }}:4318    (same namespace)
     http://{{ .Values.gateway.name }}.{{ .Release.Namespace }}.svc.cluster.local:4318  (any namespace)

2) Auto-instrument an app WITHOUT changing its code — add a pod annotation, then
   restart it so the Operator injects the agent:
     kubectl patch deployment <app> -n <app-ns> -p \
       '{"spec":{"template":{"metadata":{"annotations":{"instrumentation.opentelemetry.io/inject-java":"{{ .Release.Namespace }}/helix-instrumentation"}}}}}'
   (use -nodejs / -python / -dotnet for other runtimes; value "true" works when the
   app is in THIS namespace.)

3) Telemetry flows to Helix. On a local cluster it also fans out to
   http://localhost:8765/otel-data.
```

- [ ] **Step 9: Commit**

```bash
git add helix-otel-operator/
git commit -m "feat(k8s): operator chart skeleton (OpenTelemetryCollector + Instrumentation CRs, alias Service)"
```

---

## Task A5: Wire `engine` through the routes

**Files:**
- Modify: `backend/routes/k8s.js`
- Test: `backend/__tests__/k8s-routes.test.mjs` (append a describe block)

- [ ] **Step 1: Add failing tests** (append after the existing `describe('GET /api/k8s/chart')`)

```js
// --- appended: operator engine ---
describe('GET /api/k8s/chart/preview?engine=operator', () => {
  it('returns operator values, prereq commands, operator install cmd, and operator file list', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview?engine=operator&target=local');
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('operator');
    expect(yaml.load(res.body.values).instrumentation.languages.java).toBe(true);
    expect(res.body.installCommand).toMatch(/helm install helix \.\/helix-otel-operator/);
    expect(res.body.prereqs.certManager).toMatch(/cert-manager\.yaml/);
    expect(res.body.prereqs.operator).toMatch(/opentelemetry-operator\.yaml/);
    expect(res.body.files).toContain('helix-otel-operator/templates/collector.yaml');
    expect(res.body.files).toContain('helix-otel-operator/templates/instrumentation.yaml');
  });

  it('default engine (no param) stays deployment and omits prereqs', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart/preview');
    expect(res.body.engine).toBe('deployment');
    expect(res.body.prereqs).toBeUndefined();
    expect(res.body.installCommand).toMatch(/helm install helix \.\/helix-otel\b/);
  });
});

describe('GET /api/k8s/chart?engine=operator', () => {
  it('streams a zip with the operator CRs', async () => {
    const res = await request(makeApp()).get('/api/k8s/chart?engine=operator&target=local')
      .buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    const names = new AdmZip(res.body).getEntries().map(e => e.entryName);
    for (const f of [
      'helix-otel-operator/Chart.yaml',
      'helix-otel-operator/values.yaml',
      'helix-otel-operator/config/gateway-collector.yaml',
      'helix-otel-operator/templates/collector.yaml',
      'helix-otel-operator/templates/instrumentation.yaml',
    ]) expect(names).toContain(f);
    // The deployment chart's Deployment template must NOT be present.
    expect(names).not.toContain('helix-otel-operator/templates/gateway-deployment.yaml');
  });
});
```

- [ ] **Step 2: Run; expect FAIL**

Run: `cd backend && npx vitest run __tests__/k8s-routes.test.mjs`
Expected: FAIL — `engine` undefined, `prereqs` missing, operator file list absent.

- [ ] **Step 3: Implement** — update `backend/routes/k8s.js`. Apply these edits:

(a) Add imports + an engine reader near the top (after the existing `require`s):

```js
const { chartDirForEngine } = require('../k8sChart/buildChart');
const { prereqCommands } = require('../k8sChart/operatorPrereqs');

const getEngine = (req) => String(req.query.engine || 'deployment') === 'operator' ? 'operator' : 'deployment';
```

(b) Replace `buildCommands` so the install command + (for operator) prereqs depend on engine:

```js
function buildCommands({ handoff, engine }) {
  const key = handoff ? KEY_PLACEHOLDER : (process.env.HELIX_API_KEY || KEY_PLACEHOLDER);
  const chartDir = chartDirForEngine(engine);
  const commands = {
    secretCommand: `kubectl create secret generic helix-key --from-literal=HELIX_API_KEY='${key}'`,
    installCommand: `helm install helix ./${chartDir} --set helix.existingSecret=helix-key`,
  };
  if (engine === 'operator') commands.prereqs = prereqCommands();
  return commands;
}
```

(c) Make `listChartFiles` engine-aware — cache key includes engine, and it globs the right skeleton dir:

```js
const chartFilesCache = new Map();
function listChartFiles(projectRoot, engine = 'deployment') {
  const dir = chartDirForEngine(engine);
  const cacheKey = `${projectRoot}::${dir}`;
  if (chartFilesCache.has(cacheKey)) return chartFilesCache.get(cacheKey);
  const generated = [`${dir}/values.yaml`, `${dir}/config/gateway-collector.yaml`];
  let skeletonFiles = [];
  try {
    const skeletonRoot = path.join(projectRoot, dir);
    skeletonFiles = fsSync.readdirSync(skeletonRoot, { recursive: true })
      .map(e => path.join(dir, e).replace(/\\/g, '/'))
      .filter(p => { try { return fsSync.statSync(path.join(projectRoot, p)).isFile(); } catch { return false; } });
  } catch (e) {
    console.warn(`k8s: chart skeleton missing at ${path.join(projectRoot, dir)} (${e.code || e.message}); chart generation will be unavailable.`);
  }
  const result = [...new Set([...skeletonFiles, ...generated])].sort();
  chartFilesCache.set(cacheKey, result);
  return result;
}
```

(d) Thread `engine` into `generate()` (pass it to `buildChartFiles`) and both handlers. Update the `preview` handler to include `engine`, `prereqs`, and engine-aware file list; update the zip handler to pass `engine` into `streamChartArchive`:

```js
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
        engine: getEngine(req),
      });
    } catch (e) {
      if (e.code === 'INVALID_COLLECTOR_YAML') res.status(400).json({ error: 'Invalid collector YAML', mark: e.mark });
      else res.status(500).json({ error: 'Failed to build chart', details: e.message });
      return null;
    }
  }

  app.get('/api/k8s/chart/preview', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    const engine = getEngine(req);
    const handoff = wantsHandoff(req);
    const cmds = buildCommands({ handoff, engine });
    res.json({
      target: getTarget(req),
      engine,
      values: files.values,
      gatewayConfig: files.gatewayConfig,
      secretCommand: cmds.secretCommand,
      installCommand: cmds.installCommand,
      ...(cmds.prereqs ? { prereqs: cmds.prereqs } : {}),
      keyEmbedded: !handoff && !!process.env.HELIX_API_KEY,
      files: listChartFiles(projectRoot, engine),
    });
  });

  app.get('/api/k8s/chart', async (req, res) => {
    const files = await generate(req, res);
    if (!files) return;
    const engine = getEngine(req);
    const chartDir = chartDirForEngine(engine);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${chartDir}-chart.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('k8s chart archive error:', err);
      if (!res.headersSent) res.status(500).end(); else res.end();
    });
    archive.pipe(res);
    streamChartArchive(archive, { projectRoot, files, engine });
    archive.finalize();
  });
```

> The existing `buildCommands({ handoff })` call sites must now pass `engine`. The
> preview handler above is the only caller — already updated. Leave `getTarget`,
> `wantsHandoff`, `KEY_PLACEHOLDER` as-is.

- [ ] **Step 4: Run; expect PASS** (existing 8 + new 3)

Run: `cd backend && npx vitest run __tests__/k8s-routes.test.mjs`
Expected: PASS. The existing `helix-otel-chart.zip` filename test still passes (deployment engine → `helix-otel-chart.zip`).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/k8s.js backend/__tests__/k8s-routes.test.mjs
git commit -m "feat(k8s): /api/k8s/chart engine=operator (operator chart, prereqs, install cmd)"
```

---

## Task A6: Helm smoke test for the operator chart

**Files:**
- Create: `backend/__tests__/k8s-helm-smoke-operator.test.mjs`

- [ ] **Step 1: Write the test** (helm IS installed in this env, so it runs)

```js
// backend/__tests__/k8s-helm-smoke-operator.test.mjs
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
const SKELETON = path.join(PROJECT_ROOT, 'helix-otel-operator');

function helmAvailable() {
  try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function assembleChart(destRoot, { target = 'local', languages } = {}) {
  const dest = path.join(destRoot, 'helix-otel-operator');
  fs.cpSync(SKELETON, dest, { recursive: true });
  const collectorYaml = fs.readFileSync(path.join(PROJECT_ROOT, 'helix-otel-collector.yaml'), 'utf8');
  const { values, gatewayConfig } = buildChartFiles({ collectorYaml, endpoint: 'https://h/otlp', xSource: 'acme', target, engine: 'operator', languages });
  fs.writeFileSync(path.join(dest, 'values.yaml'), values);
  fs.mkdirSync(path.join(dest, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'config', 'gateway-collector.yaml'), gatewayConfig);
  return dest;
}

function template(chart, sets = ['helix.apiKey=dummy']) {
  const args = ['template', 'helix', chart];
  for (const s of sets) args.push('--set', s);
  return yaml.loadAll(execFileSync('helm', args, { encoding: 'utf8' })).filter(Boolean);
}

describe.skipIf(!helmAvailable())('helm smoke (operator)', () => {
  it('lints and renders the CRs + alias Service + Secret', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-op-'));
    try {
      const chart = assembleChart(tmp);
      execFileSync('helm', ['lint', chart, '--set', 'helix.apiKey=dummy'], { stdio: 'pipe' });
      const docs = template(chart);
      const kinds = docs.map(d => d.kind);
      expect(kinds).toContain('OpenTelemetryCollector');
      expect(kinds).toContain('Instrumentation');
      expect(kinds).toContain('Secret');

      const col = docs.find(d => d.kind === 'OpenTelemetryCollector');
      expect(col.spec.mode).toBe('deployment');
      // spec.config embedded as STRUCTURED yaml (a map), not a string.
      expect(typeof col.spec.config).toBe('object');
      expect(col.spec.config.exporters['otlphttp/bmchelix']).toBeDefined();

      const inst = docs.find(d => d.kind === 'Instrumentation');
      expect(inst.spec.exporter.endpoint).toMatch(/helix-gateway\..*\.svc\.cluster\.local:4318/);
      expect(inst.spec).toHaveProperty('java');
      expect(inst.spec).toHaveProperty('nodejs');
      expect(inst.spec).toHaveProperty('python');
      expect(inst.spec).toHaveProperty('dotnet');

      const alias = docs.find(d => d.kind === 'Service' && d.metadata.name === 'helix-gateway');
      expect(alias).toBeTruthy();
      expect(alias.spec.ports.map(p => p.port).sort()).toEqual([4317, 4318]);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('omits disabled language blocks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-op-lang-'));
    try {
      const chart = assembleChart(tmp);
      const docs = template(chart, ['helix.apiKey=dummy', 'instrumentation.languages.python=false', 'instrumentation.languages.dotnet=false']);
      const inst = docs.find(d => d.kind === 'Instrumentation');
      expect(inst.spec).toHaveProperty('java');
      expect(inst.spec).not.toHaveProperty('python');
      expect(inst.spec).not.toHaveProperty('dotnet');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('existingSecret mode: no chart Secret, collector env refs the external one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-op-es-'));
    try {
      const chart = assembleChart(tmp);
      const docs = template(chart, ['helix.existingSecret=my-helix-key']);
      expect(docs.map(d => d.kind)).not.toContain('Secret');
      const col = docs.find(d => d.kind === 'OpenTelemetryCollector');
      const apiKeyEnv = col.spec.env.find(e => e.name === 'HELIX_API_KEY');
      expect(apiKeyEnv.valueFrom.secretKeyRef.name).toBe('my-helix-key');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run; expect FAIL or template errors first time**

Run: `cd backend && npx vitest run __tests__/k8s-helm-smoke-operator.test.mjs`
Expected: Initially may FAIL if a template has an indentation bug. Fix the template in `helix-otel-operator/templates/` until it passes. Common fix points: the `config:` `indent 4` block in `collector.yaml`; the `java: {}` vs `java:`/`image:` branches in `instrumentation.yaml`.

- [ ] **Step 3: Iterate templates → PASS** (3 tests)

Run: `cd backend && npx vitest run __tests__/k8s-helm-smoke-operator.test.mjs`
Expected: PASS.

- [ ] **Step 4: Full backend suite green**

Run: `cd backend && npm test`
Expected: all pass (existing + new). The existing deployment helm-smoke still passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/__tests__/k8s-helm-smoke-operator.test.mjs helix-otel-operator/
git commit -m "test(k8s): helm smoke for operator chart (CRs, alias Service, language gating)"
```

> **Phase A checkpoint:** `GET /api/k8s/chart?engine=operator` now returns a valid,
> Operator-native chart. This is independently shippable. Pause here for review
> before Phase B (frontend wiring).

---

# Phase B — Frontend (third target + wizard wiring)

## Task B1: `wizardTargets.ts` — third target, `isK8sTarget`, operator steps

**Files:**
- Modify: `frontend/src/components/wizard/wizardTargets.ts`
- Test: `frontend/src/components/wizard/wizardTargets.test.ts` (append; keep existing tests)

- [ ] **Step 1: Add failing tests** (append after the existing describes)

```ts
import { isK8sTarget } from './wizardTargets';

describe('kubernetes-operator target', () => {
  it('is a valid target', () => {
    expect(isWizardTarget('kubernetes-operator')).toBe(true);
    expect(isWizardTargetOrNull('kubernetes-operator')).toBe(true);
  });
  it('has its own step labels (Prereqs & Generate / Annotate)', () => {
    expect(getWizardSteps('kubernetes-operator').map(s => s.label))
      .toEqual(['Configure', 'Prereqs & Generate', 'Annotate', 'Verify', 'Link Service']);
  });
  it('isK8sTarget covers both kubernetes variants, not docker', () => {
    expect(isK8sTarget('kubernetes')).toBe(true);
    expect(isK8sTarget('kubernetes-operator')).toBe(true);
    expect(isK8sTarget('docker')).toBe(false);
  });
});
```

- [ ] **Step 2: Run; expect FAIL**

Run: `cd frontend && npx vitest run src/components/wizard/wizardTargets.test.ts`
Expected: FAIL — `'kubernetes-operator'` not a target; `isK8sTarget` missing.

- [ ] **Step 3: Implement** — edit `wizardTargets.ts`:

(a) Extend the union + guard:

```ts
export type WizardTarget = 'docker' | 'kubernetes' | 'kubernetes-operator';

export function isWizardTarget(v: unknown): v is WizardTarget {
  return v === 'docker' || v === 'kubernetes' || v === 'kubernetes-operator';
}
```

(b) Add the operator step set + `isK8sTarget`, and route it in `getWizardSteps`:

```ts
const KUBERNETES_OPERATOR_STEPS: WizardStep[] = [
  { n: 1, label: 'Configure' },
  { n: 2, label: 'Prereqs & Generate' },
  { n: 3, label: 'Annotate' },
  { n: 4, label: 'Verify' },
  { n: 5, label: 'Link Service' },
];

export function isK8sTarget(target: WizardTarget): boolean {
  return target === 'kubernetes' || target === 'kubernetes-operator';
}

export function getWizardSteps(target: WizardTarget): WizardStep[] {
  if (target === 'kubernetes-operator') return KUBERNETES_OPERATOR_STEPS;
  return target === 'kubernetes' ? KUBERNETES_STEPS : DOCKER_STEPS;
}
```

- [ ] **Step 4: Run; expect PASS**

Run: `cd frontend && npx vitest run src/components/wizard/wizardTargets.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/wizard/wizardTargets.ts frontend/src/components/wizard/wizardTargets.test.ts
git commit -m "feat(wizard): kubernetes-operator target, isK8sTarget, operator step labels"
```

---

## Task B2: `TargetSelector` — third card + relabel the plain K8s card

**Files:**
- Modify: `frontend/src/components/wizard/TargetSelector.tsx`

No unit test (presentational; covered by `npm run build` typecheck).

- [ ] **Step 1: Add the import** (top of file):

```tsx
import { Container, Ship, Boxes } from 'lucide-react';
```

- [ ] **Step 2: Relabel the existing kubernetes card and add the operator card** — replace the two K8s entries in `CARDS`:

```tsx
  {
    target: 'kubernetes',
    icon: <Ship className="w-6 h-6" />,
    title: 'Kubernetes (manual instrument)',
    tagline: 'Generate a Helm chart you install in your cluster.',
    detail: 'We emit a self-contained gateway chart pre-wired to Helix; you helm install it and instrument your apps yourself. No Operator required.',
  },
  {
    target: 'kubernetes-operator',
    icon: <Boxes className="w-6 h-6" />,
    title: 'Kubernetes — OTel Operator (auto-instrument)',
    tagline: 'Operator-managed gateway + zero-code auto-instrumentation.',
    detail: 'Generates an OpenTelemetryCollector CR plus an Instrumentation CR — annotate a pod and the Operator injects the agent (Java/Node/Python/.NET). Requires installing cert-manager + the OpenTelemetry Operator once.',
  },
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run build`
Expected: builds clean (no TS errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/wizard/TargetSelector.tsx
git commit -m "feat(wizard): third target card (OTel Operator) + relabel manual K8s card"
```

---

## Task B3: `K8sChartPanel` — `engine` prop (operator fetch + language toggles)

**Files:**
- Modify: `frontend/src/components/K8sChartPanel.tsx`

No unit test (presentational + fetch; covered by build + manual preview). Keep the deployment path byte-identical when no `engine` prop is passed.

- [ ] **Step 1: Add the `engine` prop + language state.** Update the `Preview` type and `Props`, and add operator state:

```tsx
type Preview = {
  values: string;
  gatewayConfig: string;
  secretCommand: string;
  installCommand: string;
  files: string[];
  keyEmbedded: boolean;
  prereqs?: { certManager: string; waitCertManager: string; operator: string; waitOperator: string };
};

type Props = { namespace: string; onNamespaceChange: (ns: string) => void; engine?: 'deployment' | 'operator' };

export const K8sChartPanel: React.FC<Props> = ({ namespace, onNamespaceChange, engine = 'deployment' }) => {
  const isOperator = engine === 'operator';
  const [viewerEnabled, setViewerEnabled] = useState(true);
  const [exposeViewer, setExposeViewer] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [langs, setLangs] = useState({ java: true, nodejs: true, python: true, dotnet: true });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
```

- [ ] **Step 2: Make the fetch + download engine-aware.** Replace the `useEffect` fetch URL and dependency array:

```tsx
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ engine, handoff: String(handoff) });
    if (!isOperator) { q.set('viewer', String(viewerEnabled)); q.set('expose', String(exposeViewer)); }
    fetch(`/api/k8s/chart/preview?${q.toString()}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) setPreview(d); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [engine, isOperator, viewerEnabled, handoff, exposeViewer]);
```

And the download link href (in the "1 · Download & unzip" block):

```tsx
            <a
              href={`/api/k8s/chart?engine=${engine}`}
              className="bg-primary hover:bg-[#3006c2] text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors inline-flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Download chart (.zip)
            </a>
```

And the unzip snippet must use the right dir:

```tsx
            <SnippetBlock text={`unzip ${isOperator ? 'helix-otel-operator' : 'helix-otel'}-chart.zip && cd ${isOperator ? 'helix-otel-operator' : 'helix-otel'}`} />
```

- [ ] **Step 3: Swap the toggles block by engine.** Replace the three deployment toggles (viewer / expose / "coming soon" Operator checkbox, lines ~56–76) with a conditional:

```tsx
      {isOperator ? (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Auto-instrument these runtimes</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {(['java', 'nodejs', 'python', 'dotnet'] as const).map(l => (
              <label key={l} className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={langs[l]} onChange={e => setLangs(s => ({ ...s, [l]: e.target.checked }))} className="accent-primary w-4 h-4" />
                {l === 'nodejs' ? 'Node.js' : l === 'dotnet' ? '.NET' : l[0].toUpperCase() + l.slice(1)}
              </label>
            ))}
          </div>
          <p className="text-tiny text-gray-500 mt-2">These set the default <code className="font-mono">instrumentation.languages.*</code> in <code className="font-mono">values.yaml</code>; you can also toggle them with <code className="font-mono">--set</code> at install. Annotate pods in Step 3.</p>
        </div>
      ) : (
        <>
          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={viewerEnabled} onChange={e => { setViewerEnabled(e.target.checked); if (!e.target.checked) setExposeViewer(false); }} className="accent-primary w-4 h-4" />
            Include the local &quot;View OTel Data&quot; viewer (Deployment + PVC)
          </label>
          {viewerEnabled && (
            <label className="flex items-start gap-3 text-sm text-gray-300 ml-7">
              <input type="checkbox" checked={exposeViewer} onChange={e => setExposeViewer(e.target.checked)} className="accent-primary w-4 h-4 mt-0.5" />
              <span>Expose it at <code className="font-mono text-gray-100">localhost:8765</code> — no port-forward <span className="text-tiny text-gray-500">(Caution: local clusters only)</span></span>
            </label>
          )}
          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={handoff} onChange={e => setHandoff(e.target.checked)} className="accent-primary w-4 h-4" />
            Generating this for someone else (omit my key)
          </label>
        </>
      )}
```

> The deployment branch keeps the existing viewer/expose/handoff toggles but
> drops the dead "coming soon Operator" line (now shipped via the third card).
> For operator, `handoff` stays at its default `false`; the language checkboxes
> are display-only defaults baked into `values.yaml` — they do not need to drive
> the preview fetch for v1 (the chart ships all-four-on by default and `--set`
> overrides at install). Keep the download URL on `engine` only.

- [ ] **Step 4: Walkthrough link engine-aware.** In the "Install steps" header, point at the right page:

```tsx
            <a
              href={isOperator ? '/k8s-operator-walkthrough.html' : '/k8s-walkthrough.html'}
              target="_blank" rel="noopener noreferrer"
              className="text-tiny text-[#8b7cf6] hover:underline"
            >Full walkthrough ↗</a>
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run build`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/K8sChartPanel.tsx
git commit -m "feat(wizard): K8sChartPanel engine prop (operator download + language toggles)"
```

---

## Task B4: Operator Step 2 + Step 3 components

**Files:**
- Create: `frontend/src/components/wizard/Step2K8sOperator.tsx`
- Create: `frontend/src/components/wizard/Step3K8sOperator.tsx`

- [ ] **Step 1: `Step2K8sOperator.tsx`** — prereqs block above the reused panel:

```tsx
import React from 'react';
import { Boxes } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';
import { K8sChartPanel } from '../K8sChartPanel';

type Props = { namespace: string; onNamespaceChange: (ns: string) => void; onBack: () => void; onNext: () => void };

// Kubernetes (Operator) Step 2 — install the OTel Operator prerequisites, then
// generate the CR chart. Reuses K8sChartPanel in operator mode.
export const Step2K8sOperator: React.FC<Props> = ({ namespace, onNamespaceChange, onBack, onNext }) => (
  <div className="adapt-card">
    <div className="flex items-start justify-between gap-3 mb-2">
      <h2 className="text-lg font-semibold text-gray-200">Step 2: Install prerequisites &amp; generate</h2>
      <a href="/k8s-operator-walkthrough.html#prereqs" target="_blank" rel="noopener noreferrer"
         className="text-tiny text-[#8b7cf6] hover:underline whitespace-nowrap mt-1 flex-shrink-0">Full walkthrough ↗</a>
    </div>

    <div className="mb-4 p-3 rounded border border-primary/40 bg-primary/10">
      <div className="flex items-center gap-2 mb-2">
        <Boxes className="w-4 h-4 text-link" />
        <span className="text-sm font-semibold text-gray-100">One-time prerequisites</span>
      </div>
      <p className="text-tiny text-gray-400 mb-2">
        This chart deploys <code className="font-mono">OpenTelemetryCollector</code> and{' '}
        <code className="font-mono">Instrumentation</code> custom resources, so the cluster needs the
        OpenTelemetry Operator (and cert-manager) first. Run these once per cluster (cluster-admin):
      </p>
      <SnippetBlock text={`# 1. cert-manager (the Operator's webhook certs)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.19.5/cert-manager.yaml
kubectl wait --for=condition=Available --timeout=180s -n cert-manager deploy/cert-manager-webhook

# 2. OpenTelemetry Operator
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/download/v0.152.0/opentelemetry-operator.yaml
kubectl rollout status -n opentelemetry-operator-system deploy/opentelemetry-operator --timeout=180s`} />
      <p className="text-tiny text-gray-500">Already run the Operator? Skip straight to generating the chart.</p>
    </div>

    <p className="text-sm text-gray-400 mb-4">Then generate the chart, pre-wired to Helix, and <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">helm install</code> it:</p>
    <K8sChartPanel namespace={namespace} onNamespaceChange={onNamespaceChange} engine="operator" />

    <div className="flex gap-4 mt-6">
      <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
      <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Annotate pods →</button>
    </div>
  </div>
);
```

> The prereq commands are duplicated as literal text here for copy-paste clarity;
> the backend `operatorPrereqs.js` is the source of truth for the API-driven copy.
> If you bump versions, update both (a shared constant across the FE/BE boundary
> is out of scope for v1).

- [ ] **Step 2: `Step3K8sOperator.tsx`** — annotate pods:

```tsx
import React from 'react';
import { Hexagon } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';
import { NamespaceRecipe } from './NamespaceRecipe';

type Props = { namespace: string; onBack: () => void; onNext: () => void };

const ANNOTATIONS: { lang: string; label: string; key: string }[] = [
  { lang: 'java', label: 'Java', key: 'inject-java' },
  { lang: 'nodejs', label: 'Node.js', key: 'inject-nodejs' },
  { lang: 'python', label: 'Python', key: 'inject-python' },
  { lang: 'dotnet', label: '.NET', key: 'inject-dotnet' },
];

// Kubernetes (Operator) Step 3 — annotate pods so the Operator injects the agent.
// No app code changes; the agent is added on the next pod restart.
export const Step3K8sOperator: React.FC<Props> = ({ namespace, onBack, onNext }) => {
  const ns = namespace.trim() || 'default';
  return (
    <div className="adapt-card">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h2 className="text-lg font-semibold text-gray-200">Step 3: Annotate your pods (zero code changes)</h2>
        <a href="/k8s-operator-walkthrough.html#annotate" target="_blank" rel="noopener noreferrer"
           className="text-tiny text-[#8b7cf6] hover:underline whitespace-nowrap mt-1 flex-shrink-0">Full walkthrough ↗</a>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        Add a pod-template annotation to your app&apos;s Deployment. The Operator injects the language
        agent via an init container on the next rollout — no changes to your app image or code.
      </p>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Annotation per runtime</p>
      <SnippetBlock text={ANNOTATIONS.map(a => `instrumentation.opentelemetry.io/${a.key}: "${ns}/helix-instrumentation"   # ${a.label}`).join('\n')} />
      <p className="text-tiny text-gray-500 -mt-4 mb-4">
        The value is <code className="font-mono">&lt;namespace&gt;/helix-instrumentation</code> (the Instrumentation
        CR lives in <code className="font-mono">{ns}</code>, where you installed the chart). If your app runs in
        that same namespace, <code className="font-mono">&quot;true&quot;</code> works too.
      </p>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Apply &amp; roll out (example: a Java Deployment)</p>
      <SnippetBlock text={`kubectl patch deployment <app> -n <app-ns> -p \\
  '{"spec":{"template":{"metadata":{"annotations":{"instrumentation.opentelemetry.io/inject-java":"${ns}/helix-instrumentation"}}}}}'
# the rollout restarts pods; the Operator injects the agent as they come back up`} />

      <div className="mb-4 mt-2 flex items-start gap-3 p-2.5 rounded border border-gray-800 bg-gray-1000/50 text-tiny text-gray-400">
        <Hexagon className="w-3.5 h-3.5 text-link flex-shrink-0 mt-0.5" />
        <span>Prefer not to annotate? Apps can still send OTLP straight to the gateway:{' '}
          <code className="font-mono">OTEL_EXPORTER_OTLP_ENDPOINT=http://helix-gateway.{ns}.svc.cluster.local:4318</code>.</span>
      </div>

      <NamespaceRecipe extraNote={<>Auto-instrumentation reads <code className="font-mono">OTEL_RESOURCE_ATTRIBUTES</code> too — set them on the app the same way.</>} />

      <div className="flex gap-4">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
        <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Verify →</button>
      </div>
    </div>
  );
};
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run build`
Expected: builds clean (these aren't wired into App yet — build still passes; unused modules are fine).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/wizard/Step2K8sOperator.tsx frontend/src/components/wizard/Step3K8sOperator.tsx
git commit -m "feat(wizard): operator Step 2 (prereqs+generate) and Step 3 (annotate pods)"
```

---

## Task B5: App.tsx — wire the operator target into the dispatch

**Files:**
- Modify: `frontend/src/App.tsx`

No unit test (integration; covered by build). The existing `docker`/`kubernetes` branches stay byte-identical.

- [ ] **Step 1: Imports.** Add near the other wizard imports (around line 29–32):

```tsx
import { Step2K8sOperator } from './components/wizard/Step2K8sOperator';
import { Step3K8sOperator } from './components/wizard/Step3K8sOperator';
```

And extend the existing `wizardTargets` import to include `isK8sTarget`:

```tsx
import { getWizardSteps, isWizardTargetOrNull, isK8sTarget, type WizardTarget } from './components/wizard/wizardTargets';
```

- [ ] **Step 2: Fix the "change target" label** (around line 1268) to handle three targets:

```tsx
                  Target: {target === 'kubernetes' ? 'Kubernetes' : target === 'kubernetes-operator' ? 'Kubernetes · Operator' : 'Docker'} · change
```

- [ ] **Step 3: Step 2 dispatch.** Replace the `setupStep === 2` block (lines ~1315–1329) so operator gets its own component:

```tsx
              {setupStep === 2 && (
                target === 'kubernetes-operator' ? (
                  <Step2K8sOperator namespace={k8sNamespace} onNamespaceChange={setK8sNamespace} onBack={() => setSetupStep(1)} onNext={() => setSetupStep(3)} />
                ) : target === 'kubernetes' ? (
                  <Step2K8s namespace={k8sNamespace} onNamespaceChange={setK8sNamespace} onBack={() => setSetupStep(1)} onNext={() => setSetupStep(3)} />
                ) : (
                  <Step2
                    smartAddProposal={smartAdd.proposal}
                    smartAddResult={smartAdd.result}
                    smartAddLoading={smartAdd.loading}
                    onOpenSmartAddPreview={() => smartAdd.setPreviewOpen(true)}
                    onOpenGatewayConfig={openGatewayConfigModal}
                    onDismissResult={smartAdd.dismissResult}
                    onVerifyExporter={smartAdd.proposal ? () => smartAdd.refresh(smartAdd.proposal!.name) : null}
                    onBack={() => setSetupStep(1)}
                    onNext={() => setSetupStep(3)}
                  />
                )
              )}
```

- [ ] **Step 4: Step 3 dispatch.** Replace the `setupStep === 3` block (lines ~1331–1351):

```tsx
              {setupStep === 3 && (
                target === 'kubernetes-operator' ? (
                  <Step3K8sOperator namespace={k8sNamespace} onBack={() => setSetupStep(2)} onNext={() => setSetupStep(4)} />
                ) : target === 'kubernetes' ? (
                  <Step3K8s namespace={k8sNamespace} onBack={() => setSetupStep(2)} onNext={() => setSetupStep(4)} />
                ) : (
                  <Step3
                    bridgeStatus={bridgeStatus}
                    tab={step3Tab}
                    setTab={setStep3Tab}
                    detectedCollectors={detectedCollectors}
                    attachingNetwork={attachingNetwork}
                    attachResult={attachResult}
                    onAttachNetwork={attachSidecarToNetwork}
                    onDetachNetwork={detachSidecarFromNetwork}
                    detachingNetwork={detachingNetwork}
                    k8sApplying={k8sApplying}
                    k8sApplyResult={k8sApplyResult}
                    onApplyK8sTemplate={requestApplyK8sTemplate}
                    onBack={() => setSetupStep(2)}
                    onNext={() => setSetupStep(4)}
                    onJumpToStep={setSetupStep}
                  />
                )
              )}
```

- [ ] **Step 5: Step 4 dispatch.** The operator path reuses `Step4K8s`. Change the `setupStep === 4` condition (line ~1353) from `target === 'kubernetes'` to cover both K8s variants:

```tsx
              {setupStep === 4 && (isK8sTarget(target) ? (
                <Step4K8s
                  otelDashboardUrl={externalApps.otelDashboardUrl}
                  namespace={k8sNamespace}
                  onBack={() => setSetupStep(3)}
                  onFinishStep={() => setSetupStep(5)}
                />
              ) : (
```

(Leave the rest of the Step 4 Docker branch untouched.)

- [ ] **Step 6: Step 1 labels.** The `setupStep === 1` block keys some copy off `target === 'kubernetes'` (lines ~1300–1301). Make those checks cover both K8s variants so the operator path shows the K8s-flavored copy:

```tsx
                  primaryLabel={isK8sTarget(target) ? 'Save & continue →' : 'Save & initialize →'}
                  heading={isK8sTarget(target) ? 'Step 1: Configure your Helix connection' : 'Step 1: Configure helix-gateway'}
```

- [ ] **Step 7: Typecheck + full frontend tests**

Run: `cd frontend && npm run build && npx vitest run`
Expected: build clean; all vitest pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(wizard): dispatch the kubernetes-operator target through the wizard steps"
```

---

## Task B6: Operator walkthrough page

**Files:**
- Create: `frontend/public/k8s-operator-walkthrough.html`

- [ ] **Step 1: Create the page.** Copy lines 1–94 of `frontend/public/k8s-walkthrough.html` verbatim (the `<!doctype>`, `<head>` with the full `<style>` block, and the opening `<body><div class="wrap"><header class="brand">…</header>`), changing ONLY the `<title>` to `Deploy the Helix OTel gateway via the OpenTelemetry Operator — Walkthrough`. Then append this body content (replacing everything from the `<h1>` through `</html>`):

```html
    <h1>Deploy via the OpenTelemetry Operator (auto-instrumentation)</h1>
    <p class="lede">
      This chart deploys the Helix gateway as an <code>OpenTelemetryCollector</code> custom resource and ships
      an <code>Instrumentation</code> custom resource, so you can auto-instrument apps (Java, Node.js, Python,
      .NET) with <strong>no code changes</strong> — just a pod annotation. It needs the OpenTelemetry Operator
      installed first.
    </p>

    <div class="toc">
      <div class="label">On this page</div>
      <ol>
        <li><a href="#prereqs">Install prerequisites (cert-manager + Operator)</a></li>
        <li><a href="#generate">Generate &amp; download the chart</a></li>
        <li><a href="#secret">Create the Helix API-key secret</a></li>
        <li><a href="#install">Install with Helm</a></li>
        <li><a href="#annotate">Annotate your pods</a></li>
        <li><a href="#verify">Verify telemetry is flowing</a></li>
        <li><a href="#troubleshooting">Troubleshooting</a></li>
      </ol>
    </div>

    <h2 id="prereqs"><span class="num">1</span>Install prerequisites</h2>
    <p>The Operator extends Kubernetes with two new resource types (the CRs this chart uses). Install
    cert-manager (for the Operator's admission-webhook certs), then the Operator. One-time, per cluster:</p>
    <pre><code>kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.19.5/cert-manager.yaml
kubectl wait --for=condition=Available --timeout=180s -n cert-manager deploy/cert-manager-webhook

kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/download/v0.152.0/opentelemetry-operator.yaml
kubectl rollout status -n opentelemetry-operator-system deploy/opentelemetry-operator --timeout=180s</code></pre>
    <div class="callout">
      <div class="label">Already running the Operator?</div>
      Skip this step. The chart only needs the <code>OpenTelemetryCollector</code> and
      <code>Instrumentation</code> CRDs to exist.
    </div>

    <h2 id="generate"><span class="num">2</span>Generate &amp; download the chart</h2>
    <p>In the configurator's <strong>Prereqs &amp; Generate</strong> step, pick which runtimes to
    auto-instrument, then <strong>Download chart (.zip)</strong>. Unzip and <code>cd</code> in:</p>
    <pre><code>unzip helix-otel-operator-chart.zip
cd helix-otel-operator</code></pre>
    <p class="muted">Your <code>HELIX_ENDPOINT</code> and <code>X_SOURCE</code> are baked into
    <code>values.yaml</code>; your live collector pipeline becomes the CR's <code>spec.config</code>. Your API
    key is never written into the chart.</p>

    <h2 id="secret"><span class="num">3</span>Create the Helix API-key secret</h2>
    <pre><code>kubectl create secret generic helix-key \
  --from-literal=HELIX_API_KEY='&lt;TenantID&gt;::&lt;AccessKey&gt;::&lt;SecretKey&gt;'</code></pre>
    <div class="callout">
      <div class="label">Already manage secrets your way?</div>
      <code>--set helix.existingSecret=&lt;your-secret-name&gt;</code> (it must expose a <code>HELIX_API_KEY</code> key).
    </div>

    <h2 id="install"><span class="num">4</span>Install with Helm</h2>
    <pre><code>helm install helix . --set helix.existingSecret=helix-key</code></pre>
    <p>Into a specific namespace, create the Secret there too:</p>
    <pre><code>kubectl create namespace observability
kubectl create secret generic helix-key -n observability \
  --from-literal=HELIX_API_KEY='&lt;TenantID&gt;::&lt;AccessKey&gt;::&lt;SecretKey&gt;'
helm install helix . -n observability --set helix.existingSecret=helix-key</code></pre>
    <p class="muted">The Operator reconciles the CR into a managed collector Deployment and a Service named
    <code>helix-gateway-collector</code>. The chart also adds a stable alias Service <code>helix-gateway</code>
    (on <code>4317</code>/<code>4318</code>) so apps can use the familiar name.</p>

    <h2 id="annotate"><span class="num">5</span>Annotate your pods</h2>
    <p>Add a pod-template annotation to your app's Deployment — the Operator injects the agent on the next
    rollout. No app image or code changes:</p>
    <pre><code>instrumentation.opentelemetry.io/inject-java:    "&lt;namespace&gt;/helix-instrumentation"
instrumentation.opentelemetry.io/inject-nodejs:  "&lt;namespace&gt;/helix-instrumentation"
instrumentation.opentelemetry.io/inject-python:  "&lt;namespace&gt;/helix-instrumentation"
instrumentation.opentelemetry.io/inject-dotnet:  "&lt;namespace&gt;/helix-instrumentation"</code></pre>
    <p>Apply to a running Deployment and roll it out:</p>
    <pre><code>kubectl patch deployment &lt;app&gt; -n &lt;app-ns&gt; -p \
  '{"spec":{"template":{"metadata":{"annotations":{"instrumentation.opentelemetry.io/inject-java":"&lt;namespace&gt;/helix-instrumentation"}}}}}'</code></pre>
    <div class="callout warn">
      <div class="label">Namespace rule</div>
      The <code>Instrumentation</code> CR is namespaced. Reference it as
      <code>&lt;namespace&gt;/helix-instrumentation</code> (where you installed the chart). The bare value
      <code>"true"</code> only works when the app is in that <em>same</em> namespace.
    </div>
    <p class="faint">Prefer not to annotate? Apps can send OTLP straight to
    <code>http://helix-gateway.&lt;namespace&gt;.svc.cluster.local:4318</code>.</p>

    <h2 id="verify"><span class="num">6</span>Verify telemetry is flowing</h2>
    <h3>The Operator reconciled the gateway</h3>
    <pre><code>kubectl get opentelemetrycollector,pods -l app.kubernetes.io/component=opentelemetry-collector -n &lt;namespace&gt;</code></pre>
    <h3>The agent was injected into your app</h3>
    <pre><code>kubectl get pod &lt;app-pod&gt; -n &lt;app-ns&gt; \
  -o jsonpath='{.spec.initContainers[*].name}{"\n"}'</code></pre>
    <p class="faint">You should see an <code>opentelemetry-auto-instrumentation-*</code> init container.</p>
    <h3>See it in Helix</h3>
    <p>Open your tenant's <strong>OTel Namespace Overview</strong> dashboard — telemetry from your
    annotated apps should appear within a couple of minutes of the rollout.</p>

    <h2 id="troubleshooting"><span class="num">?</span>Troubleshooting</h2>
    <h3><code>helm install</code> fails: <em>no matches for kind "OpenTelemetryCollector"</em></h3>
    <p>The Operator (or its CRDs) isn't installed. Do step 1 first, then retry.</p>
    <h3>Annotated a pod but no telemetry / no init container</h3>
    <p>The webhook only fires on pod <em>creation</em> — annotate the pod <em>template</em> (not the live
    pod) and roll out: <code>kubectl rollout restart deployment/&lt;app&gt; -n &lt;app-ns&gt;</code>. Confirm the
    annotation key matches the runtime, and the value's namespace points at where the chart is installed.</p>
    <h3>Apps in another namespace can't reach the gateway</h3>
    <p>Use the fully-qualified endpoint
    <code>http://helix-gateway.&lt;install-namespace&gt;.svc.cluster.local:4318</code>, and annotate with the
    <code>&lt;install-namespace&gt;/helix-instrumentation</code> form.</p>
    <div class="callout warn">
      <div class="label">OpenShift / restricted Pod Security</div>
      The Operator and the collector run non-root. If a <code>restricted</code>-PSA namespace rejects the
      injected init container, grant the app's ServiceAccount the appropriate SCC or instrument via the
      direct-OTLP fallback instead.
    </div>

  </div>
</body>
</html>
```

- [ ] **Step 2: Sanity-check the HTML is well-formed**

Run: `cd frontend && node -e "const s=require('fs').readFileSync('public/k8s-operator-walkthrough.html','utf8'); if(!s.includes('id=\"annotate\"')||!s.endsWith('</html>\n')&&!s.endsWith('</html>')) throw new Error('bad'); console.log('ok, '+s.length+' bytes')"`
Expected: prints `ok, <n> bytes`.

- [ ] **Step 3: Commit**

```bash
git add frontend/public/k8s-operator-walkthrough.html
git commit -m "docs(k8s): operator walkthrough runbook (prereqs -> annotate -> verify)"
```

---

## Task B7: Full verification pass

- [ ] **Step 1: Backend suite**

Run: `cd backend && npm test`
Expected: all pass (including both helm-smoke suites, since helm is installed).

- [ ] **Step 2: Frontend build + tests**

Run: `cd frontend && npm run build && npx vitest run`
Expected: build clean; all pass.

- [ ] **Step 3: Manual smoke (optional, if a dev server is run).** Start the app, pick the **Kubernetes — OTel Operator** card, confirm: Stepper shows `Configure / Prereqs & Generate / Annotate / Verify / Link Service`; Step 2 shows the prereq block + language toggles + a download that fetches `?engine=operator`; Step 3 shows the annotation snippets; the "Full walkthrough ↗" links open `k8s-operator-walkthrough.html`.

- [ ] **Step 4: Final commit (if any docs/notes changed)** — otherwise nothing to do.

---

## Self-review checklist (run before handoff to execution)

- Spec §"The third target" → Tasks B1, B2, B5. ✓
- Spec §"Frontend changes" (wizardTargets, TargetSelector, Step2/3 operator, walkthrough, App dispatch) → B1–B6. ✓
- Spec §"Backend changes" (skeleton, transform reuse, renderValues engine, buildChart engine, routes engine, operatorPrereqs) → A1–A5. ✓
- Spec §"Data flow (operator path)" → end-to-end via A5 (`?engine=operator`) + B3/B4. ✓
- Spec §"Error handling" (invalid YAML 400, missing skeleton warn, all-langs-off, cross-namespace, CRD-not-found) → A5 (reused 400 + engine-aware listChartFiles), B4/B6 (cross-namespace + CRD-not-found copy), A6 (language gating test). ✓
- Spec §"Testing strategy" (transform, renderValues, buildChart, routes, helm-smoke, frontend) → A2/A3/A5/A6 + B1. ✓
- Decision 6 (engine param) → A3/A5. Decision 7 (relabel cards) → B2. Decision 8 (pinned versions) → A1. Decision 9 (walkthrough page) → B6. ✓
- Gateway DNS parity (alias Service) → A4 (gateway-service-alias.yaml) + A6 (smoke asserts `helix-gateway` Service on 4317/4318). ✓
- No placeholders; every code/template/test step shows full content. ✓
- Type/name consistency: `engine`, `chartDirForEngine`, `prereqCommands`, `isK8sTarget`, `instrumentation.languages.*` used identically across tasks. ✓
