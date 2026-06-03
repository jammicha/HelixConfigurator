# Generate K8s chart — Phase 1 design

> **Spec** · Created 2026-06-03 · Status: **Draft for review**
> Decision: [`2026-06-03-kubernetes-deployment-decision-design.md`](2026-06-03-kubernetes-deployment-decision-design.md) (approved)
> Source brief: [`docs/handoffs/01-local-to-kubernetes.md`](../../handoffs/01-local-to-kubernetes.md)
> Build branch: `feat/generate-k8s-chart`

This spec scopes **Phase 1** of the Kubernetes story: a configurator action that **emits a
self-contained, Operator-free Helm chart**, pre-wired to Helix from the configurator's current
state. It is generate-only — the configurator never touches a cluster. Phase 2 (in-cluster
control plane) is out of scope and explicitly not cornered by this design.

---

## 1. What we're building

A new dashboard action — **"Generate Kubernetes deployment"** — that produces a downloadable
`.zip` containing a ready-to-`helm install` chart:

```
helm install helix ./helix-otel --set helix.apiKey=<TenantID::AccessKey::SecretKey>
```

…which brings up the Helix OTel **gateway** (and, by default, the local **viewer**) in the
user's cluster, shipping traces/metrics/logs to their Helix tenant exactly as the Docker
gateway does today.

The chart is built **from live state**: the running configurator's `helix-otel-collector.yaml`
becomes the gateway config, and `HELIX_ENDPOINT` / `X_SOURCE` are baked into `values.yaml`. The
secret (`HELIX_API_KEY`) is **never written to disk** — it is supplied at install time.

### The one piece of genuinely new logic

Everything else is a static Helm chart + the codebase's existing zip-bundle plumbing. The novel,
TDD-worthy logic is a pure function that **transforms the live collector config** into the
gateway ConfigMap payload (§5). The hardcoded local-viewer exporter
(`http://helix-configurator:3001`) must be rewritten to the in-cluster viewer Service — or
cleanly stripped when the viewer is disabled.

---

## 2. Goals / Non-goals

**Goals**
- Emit a self-contained, Operator-free Helm chart that `helm install`s with zero cluster
  prerequisites on the gateway path (gateway uses the public `otel/opentelemetry-collector-contrib`).
- Pre-wire it to Helix from live configurator state.
- Keep the local "View OTel Data" viewer (parity north star): in-chart Deployment + PVC,
  reached by `kubectl port-forward`.
- Keep secrets out of generated files.
- Don't corner Phase 2: resource model and naming are the substrate Phase 2 will patch live.

**Non-goals (deferred, see §11)**
- The OTel **Operator** / `OpenTelemetryCollector` CR flavor (doc §6) — documented fast-follow.
- **Live cluster interaction** (kubeconfig discovery / patch / rollout) — that is Phase 2.
- Publishing the configurator image to a registry; Ingress; multi-namespace / fleet; HA viewer;
  OpenShift SCC manifests; auth revamp.

---

## 3. Decisions locked in brainstorming

1. **Output = a Helm chart, downloaded as a `.zip`**, streamed with the same `archiver` plumbing
   `demo.js` already uses for the install bundle.
2. **Approach = static chart skeleton in the repo + a thin generator** that overlays the two
   live-derived files (`values.yaml`, `config/gateway-collector.yaml`). The chart is real,
   reviewable YAML — not Helm templates authored as JS strings.
3. **Generate-only.** No `@kubernetes/client-node`, no kubeconfig, no cluster calls in Phase 1.
   The generator sits behind a clean module seam so Phase 2 can reuse the resource model.
4. **Viewer on by default, local image.** `viewer.image` defaults to `helix-configurator:latest`
   with `imagePullPolicy: IfNotPresent`; the user loads it into a local POC cluster once
   (`kind load docker-image` / `minikube image load`) and overrides `viewer.image` for real
   registries. Honors "on by default" without adding registry/CI scope.
5. **Operator flavor deferred.** Phase 1 ships the raw-resource chart only; the UI shows the
   `--operator` option as a disabled "coming soon" affordance.
6. **Platform-agnostic**, with restricted-PSA-friendly defaults on the gateway; the viewer
   carries a documented root-image caveat (§8).

---

## 4. Architecture & module layout

```
helix-otel/                              # static chart skeleton (committed to the repo)
  Chart.yaml
  .helmignore
  templates/
    _helpers.tpl
    NOTES.txt
    gateway-configmap.yaml               # embeds config via .Files.Get (no Go-templating of payload)
    gateway-deployment.yaml
    gateway-service.yaml
    secret.yaml
    viewer-deployment.yaml               # guarded by {{ if .Values.viewer.enabled }}
    viewer-service.yaml                  #   "
    viewer-pvc.yaml                      #   "
backend/k8sChart/
  transformCollectorConfig.js            # PURE: live collector yaml + opts -> gateway config yaml
  renderValues.js                        # PURE: live env + opts -> values.yaml string
  buildChart.js                          # assembles the archive: skeleton glob + 2 generated files
  index.js                               # small façade re-exporting the above (the Phase-2 seam)
backend/routes/k8s.js                    # GET /api/k8s/chart(.zip) + GET /api/k8s/chart/preview
frontend/src/components/K8sChartModal.tsx  # mirrors TemplatesModal.tsx
```

- The route registers via the existing `register(app, deps)` pattern in `backend/index.js`,
  **after** the `requireAuth` gate (it's an authed dashboard action), receiving
  `{ configPath }` (the live collector YAML path) — env is read from `process.env`.
- The static skeleton lives at the **repo root** as `helix-otel/` (sibling to `templates/`,
  which is reserved for collector config templates). `buildChart.js` streams it with
  `archive.glob('helix-otel/**', { cwd: projectRoot, dot: true })`, then appends the two
  generated files **under the same `helix-otel/` prefix** (`helix-otel/values.yaml`,
  `helix-otel/config/gateway-collector.yaml`) so the zip contains a single chart directory.
  This mirrors `demo.js`'s `writePackageToArchive`.
- The skeleton **intentionally omits `values.yaml` and the `config/` directory** — those are the
  two generated files. The glob and the appends therefore never collide, and there is one source
  of truth for each (the skeleton for static templates, `renderValues`/the transform for the two
  dynamic files). A test renders a fixture chart so the skeleton can still be `helm lint`ed.
- **Naming for parity:** gateway and viewer resources use **stable, release-independent names**
  (`helix-gateway`, `helix-viewer`), overridable via values. This keeps the Docker-era
  Step-2 snippet working verbatim in K8s (`OTEL_EXPORTER_OTLP_ENDPOINT=http://helix-gateway:4318`)
  and lets the generated collector config reference `http://helix-viewer:3001` without knowing
  the install-time release name. One logical gateway+viewer per namespace (a POC-appropriate
  constraint; documented).

---

## 5. The transform (`transformCollectorConfig`) — the heart

```
transformCollectorConfig(collectorYamlString, { viewerEnabled, viewerServiceName }) -> string
```

Steps (operating on the `js-yaml`-parsed document, re-emitted with `js-yaml.dump`):

1. **Parse.** `yaml.load`. On parse error, throw a typed error the route maps to **400** (mirrors
   `config.js`'s syntax-check response shape).
2. **Viewer exporter handling** — the exporter key is `otlphttp/helix_local_viewer`:
   - **viewerEnabled = true:** rewrite both `traces_endpoint` and `logs_endpoint` host from
     `helix-configurator:3001` → `${viewerServiceName}:3001` (default `helix-viewer`), preserving
     the `/api/otlp/traces` and `/api/otlp/logs` paths.
   - **viewerEnabled = false:** delete the `otlphttp/helix_local_viewer` exporter **and** remove
     it from every pipeline's `exporters:` list (`traces`, `logs`), leaving `otlphttp/bmchelix`.
   - If the exporter is already absent (user removed it), no-op gracefully.
3. **Health-check extension** (`ensureHealthCheckExtension`): ensure
   `extensions.health_check.endpoint: 0.0.0.0:13133` exists and `13133` is in `service.extensions`.
   This backs real httpGet liveness/readiness probes on the gateway.
4. **Leave the Helix exporter untouched.** `otlphttp/bmchelix` keeps its `${env:HELIX_ENDPOINT}`,
   `${env:HELIX_API_KEY}`, `${env:X_SOURCE}` substitutions — the values arrive via the pod's env
   (Secret + values, §6,§7). Because the ConfigMap embeds this file via `.Files.Get` (raw bytes,
   no Go-templating), `${env:...}` passes through untouched.

> Round-tripping through `js-yaml` drops comments and normalizes formatting. That is acceptable
> and expected for a generated artifact.

**Test matrix (golden files):** viewer-on rewrite · viewer-off strip (exporter + both pipeline
refs, bmchelix retained) · viewer exporter already absent (no-op) · health_check injected when
missing · health_check left intact when already present · malformed YAML throws.

---

## 6. The Helm chart — file-by-file

### Chart.yaml
`apiVersion: v2`, `name: helix-otel`, `type: application`, `version: 0.1.0`,
`appVersion: "0.119.0"` (the pinned contrib release). Description notes it is generated by the
Helix Configurator.

### values.yaml (generated by `renderValues`; live values baked where noted)
```yaml
helix:
  endpoint: "<live HELIX_ENDPOINT>"     # baked from process.env
  xSource:  "<live X_SOURCE>"           # baked from process.env
  apiKey:   ""                          # NEVER baked; supplied via --set at install
gateway:
  name: helix-gateway
  image: { repository: otel/opentelemetry-collector-contrib, tag: "0.119.0", pullPolicy: IfNotPresent }
  replicas: 1
  resources: { requests: {cpu: 100m, memory: 256Mi}, limits: {cpu: "1", memory: 512Mi} }
  service: { type: ClusterIP }
viewer:
  enabled: true                         # set from the generate-time toggle
  name: helix-viewer
  image: { repository: helix-configurator, tag: latest, pullPolicy: IfNotPresent }
  resources: { requests: {cpu: 100m, memory: 256Mi}, limits: {cpu: "1", memory: 512Mi} }
  persistence: { size: 2Gi, storageClass: "" }
```
The contrib image **tag is pinned** (not `latest`) for reproducibility; confirm/bump to the
team's validated contrib release during implementation. The endpoint/xSource are baked so the
chart is pre-wired, but remain overridable at install.

### templates/gateway-configmap.yaml
```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: {{ .Values.gateway.name }}, labels: {{ include "helix-otel.labels" . | nindent 4 }} }
data:
  config.yaml: |
{{ .Files.Get "config/gateway-collector.yaml" | indent 4 }}
```

### templates/gateway-deployment.yaml
- One container, `{{ .Values.gateway.image.* }}`, args mount the ConfigMap at
  `/etc/otelcol-contrib/config.yaml` (matches the Docker mount).
- **env:** `HELIX_ENDPOINT` ← `.Values.helix.endpoint`; `X_SOURCE` ← `.Values.helix.xSource`;
  `HELIX_API_KEY` ← `secretKeyRef` to the Secret.
- ports 4317/4318/8888; liveness+readiness `httpGet :13133 /`.
- restricted-PSA `securityContext` (§8); resources from values; `Recreate` not needed (stateless).

### templates/gateway-service.yaml
`ClusterIP`, name `{{ .Values.gateway.name }}`, ports 4317/4318/8888.

### templates/secret.yaml
```yaml
apiVersion: v1
kind: Secret
metadata: { name: {{ .Values.gateway.name }}-helix }
type: Opaque
stringData:
  HELIX_API_KEY: {{ required "helix.apiKey is required — pass --set helix.apiKey=<TenantID::AccessKey::SecretKey>" .Values.helix.apiKey | quote }}
```
`required` makes a missing key fail `helm install` fast with a helpful message rather than
silently 401ing against Helix. (Tests render with `--set helix.apiKey=dummy`.)

### templates/viewer-deployment.yaml  *(guarded by `{{- if .Values.viewer.enabled }}`)*
- Image `{{ .Values.viewer.image.* }}` (default `helix-configurator:latest`, `IfNotPresent`).
- `strategy.type: Recreate` + `terminationGracePeriodSeconds: 60` — single-writer SQLite must
  not have two writers overlap on upgrade, and needs time to checkpoint on SIGTERM.
- Volume: PVC mounted at `/app/data`; env `OTEL_DB_PATH=/app/data/otel-store.db`,
  `IS_DEMO_INSTALL=false`.
- port 3001; liveness+readiness `httpGet :3001 /api/health` (existing public endpoint).
- `securityContext` permissive + `fsGroup` (§8).

### templates/viewer-service.yaml / viewer-pvc.yaml  *(both guarded by viewer.enabled)*
Service `{{ .Values.viewer.name }}` exposing 3001 (the gateway's rewritten fan-out target).
PVC `ReadWriteOnce`, `{{ .Values.viewer.persistence.size }}`, optional `storageClass`.

### templates/_helpers.tpl / NOTES.txt
Standard labels/selector helpers. `NOTES.txt` prints: how to set `helix.apiKey` if absent, the
app-pointing snippet (`OTEL_EXPORTER_OTLP_ENDPOINT=http://helix-gateway:4318`), the viewer
`kubectl port-forward svc/helix-viewer 3001:3001` → `http://localhost:3001/otel-data`, and the
`kind load` / `minikube image load` reminder for the viewer image on local clusters.

### config/gateway-collector.yaml
**Generated** — the §5 transform output. The `.Files.Get` target.

### .helmignore
Standard ignores (`.git`, `*.md` editor cruft, etc.).

---

## 7. `renderValues` + the generate-time toggle

```
renderValues({ endpoint, xSource, viewerEnabled, /* name/image/resource overrides default */ }) -> string
```
A pure function producing the `values.yaml` of §6 with `helix.endpoint`/`helix.xSource` from
live env and `viewer.enabled` from the toggle. `helix.apiKey` is always emitted as `""`.

**Toggle semantics.** The generate-time `viewer` flag is the **primary control**: it drives both
the transform (rewrite vs strip) and `viewer.enabled`. The viewer templates always ship in the
chart (guarded by `.Values.viewer.enabled`) so a user can still `--set viewer.enabled=false` at
install; if they do so on a chart generated with the viewer **on**, the gateway keeps the
`helix-viewer` exporter and harmlessly drops that fan-out (its `sending_queue`/`retry_on_failure`
are already disabled) while Helix export continues. Documented in NOTES/README.

---

## 8. securityContext & the root-image caveat

- **Gateway:** full restricted-PSA — `runAsNonRoot: true`, `allowPrivilegeEscalation: false`,
  `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem: true`.
  The contrib image supports this.
- **Viewer:** the configurator image currently runs as **root** (no `USER` in the Dockerfile;
  the Docker flow bind-mounts `./data`). Forcing `runAsNonRoot` here would require rebuilding the
  image non-root, which risks regressing the existing Docker Desktop experience — out of scope.
  So the viewer ships a **permissive, values-overridable `securityContext`** plus `fsGroup` for
  the PVC, with a **documented caveat**: on restricted-PSA / OpenShift clusters the viewer needs
  a non-root image rebuild or a namespace exception. This pairs with the deferred "publish a
  non-root image" work and is called out as a known gap — not silently shipped.

---

## 9. API & UI

### Routes (`backend/routes/k8s.js`, under `requireAuth`)
- `GET /api/k8s/chart?viewer=true|false` → streams `application/zip`,
  `Content-Disposition: attachment; filename="helix-otel-chart.zip"`. Mirrors `demo.js`'s
  archiver error handling + `finalize()`.
- `GET /api/k8s/chart/preview?viewer=true|false` → JSON `{ values, gatewayConfig, installCommand,
  files: [paths] }` for the modal's preview pane.
- The only generate-time input is `viewer`; `apiKey`, namespace, and release name are install-time
  Helm concerns and are **not** chart inputs.

### Frontend (`K8sChartModal.tsx`, launched from a dashboard button)
- A "Generate Kubernetes deployment" button in the dashboard's gateway/config area opens the modal.
- Modal contents: a **viewer on/off** toggle; a **preview** pane (generated `values.yaml`, the
  transformed gateway config, and the `helm install …` command); a **Download chart (.zip)**
  button (anchor to the chart endpoint, credentialed via the existing cookie); and a disabled
  **"Use OTel Operator (coming soon)"** affordance.
- Mirrors `TemplatesModal.tsx` conventions (ESC-close, toast on action). Exact dashboard placement
  finalized during implementation.

---

## 10. Error handling

- **Malformed live collector YAML** → transform throws → route returns **400** with the
  `config.js`-style `{ error, mark? }` shape.
- **Archive stream error** → log + `res.status(500).end()` if headers unsent, else `res.end()`
  (verbatim `demo.js` pattern).
- **Missing `helix-otel-collector.yaml` on disk** → 500 "Failed to read gateway config" (mirrors
  `GET /api/config`).
- `helix.apiKey` omission is handled at **install** time by the chart's `required` guard, not by
  the generator.

---

## 11. Testing strategy

- **`backend/__tests__/k8sChart-transform.test.mjs`** — golden tests for the §5 matrix.
- **`backend/__tests__/k8sChart-values.test.mjs`** — `renderValues` golden tests (live values
  baked, apiKey always empty, viewer toggle).
- **`backend/__tests__/k8s-routes.test.mjs`** (supertest):
  - preview returns JSON with the expected file list + install command;
  - chart returns a zip (content-type, content-disposition); unzip in-memory and assert the full
    file set is present, **every `.yaml` parses**, and the gateway config reflects the toggle;
  - malformed live config → 400.
- **Optional `helm`-gated smoke** (skipped when `which helm` fails): run `helm lint` and
  `helm template --set helix.apiKey=dummy` against the generated chart (viewer on and off) and
  assert the rendered manifests parse. CI without `helm` still gets full coverage from the
  YAML-parse assertions above.
- **Frontend** — a light `K8sChartModal` test (renders, toggle flips the previewed config, calls
  the endpoints), following existing frontend test conventions.

---

## 12. New / changed files (for the plan)

**New**
- `helix-otel/` chart skeleton (Chart.yaml, .helmignore, templates/*, _helpers.tpl, NOTES.txt).
- `backend/k8sChart/{transformCollectorConfig,renderValues,buildChart,index}.js`.
- `backend/routes/k8s.js`.
- `frontend/src/components/K8sChartModal.tsx`.
- Tests listed in §11.

**Changed**
- `backend/index.js` — register the k8s route (pass `configPath`, `projectRoot`).
- `frontend/src/App.tsx` — the launch button + modal wiring.
- `README.md` — a short "Generate a Kubernetes chart" section (parity with the install-bundle docs).

---

## 13. Known gaps (honest, not solved here)

- **Viewer image is root** → restricted-PSA/OpenShift caveat (§8); pairs with deferred image
  publishing.
- **Contrib image tag** must be pinned to a verified release at implementation (default is a
  concrete pin, overridable).
- **Collector config comments** are lost in the `js-yaml` round-trip (acceptable for generated
  output).
- **One gateway+viewer per namespace** (stable names) — multi-release-per-namespace is a
  non-goal.

---

## 14. How this feeds Phase 2

The generated chart **is** Phase 2's substrate: Phase 2 patches these same objects (ConfigMap,
Deployments) live via a ServiceAccount instead of regenerating files. The `backend/k8sChart/`
module is the seam — its resource model and naming are what a future `@kubernetes/client-node`
layer will reconcile. Nothing here is throwaway.
