# K8s Viewer Redesign: Drop Bundled Viewer, Gate Local vs Remote

**Date:** 2026-06-05
**Status:** Draft
**Supersedes:** Viewer portions of [2026-06-03-generate-k8s-chart-design.md](2026-06-03-generate-k8s-chart-design.md)

## Problem

PR #8 (Phase 1.5 K8s onboarding, merged 2026-06-05) ships a bundled in-cluster viewer: a separate Deployment + Service + PVC in the Helm chart. This breaks Docker parity by introducing a second deployment competing for port 8765, forces port-juggling, and violates the core UX constraint: K8s onboarding must mirror Docker exactly (one app, one port, the configurator's own built-in `/otel-data` viewer).

## Decision

Remove the in-cluster viewer entirely. Gate on cluster location:

- **Local (Docker Desktop k8s):** The gateway's `otlphttp/helix_local_viewer` exporter sends telemetry back to the host's configurator at `host.docker.internal:8765`. Same app, same port, same `/otel-data` route.
- **Remote / cloud:** The exporter is stripped. Users view telemetry in BMC Helix.

## Networking Verification

`host.docker.internal` resolves from K8s pods on Docker Desktop (macOS, Windows, Linux). K8s pods and Docker containers share Docker Desktop's VM; the DNS name is injected at the VM level, not per-container. Also works on kind running atop Docker Desktop.

| Environment | `host.docker.internal` from K8s pod? | Notes |
|---|---|---|
| Docker Desktop (macOS) | Yes | Shared VM, DNS injected at VM level |
| Docker Desktop (Windows) | Yes | Same |
| Docker Desktop (Linux) | Yes | Docker Desktop on Linux also runs a VM |
| kind (macOS/Windows) | Yes | kind containers run inside Docker Desktop's VM |
| kind (Linux native) | No | No `--add-host` config in kind yet |
| minikube | No | Uses `host.minikube.internal` instead |

The target audience is Docker Desktop k8s users (the wizard's Step 1 says "Enable Docker Desktop's built-in Kubernetes"). This is sufficient.

**Gotcha:** The configurator's Express server binds `0.0.0.0` by default, and Docker Compose maps host:8765 to container:3001. The path from a K8s pod is: `host.docker.internal:8765` -> Docker Desktop VM -> host port 8765 -> Docker port mapping -> configurator container:3001.

## Data Flow

### Local mode

```
K8s Pod (helix-gateway)
  -> otlphttp/bmchelix        -> Helix endpoint (traces, logs, metrics)
  -> otlphttp/helix_local_viewer -> http://host.docker.internal:8765/api/otlp/{traces,logs,metrics}
                                    -> Docker Desktop VM -> host :8765
                                    -> Docker Compose 8765:3001
                                    -> Configurator /api/otlp/* routes
                                    -> SQLite store -> /otel-data UI
```

### Remote mode

```
K8s Pod (helix-gateway)
  -> otlphttp/bmchelix -> Helix endpoint (traces, logs, metrics)
  (no helix_local_viewer exporter — stripped from config)
```

## Frontend Changes

### `K8sChartModal.tsx`

Replace the `viewerEnabled` boolean checkbox with a `clusterTarget` radio group:

| Value | Label | Helper text |
|---|---|---|
| `local` (default) | Local cluster (Docker Desktop) | Telemetry flows back to this app at localhost:8765/otel-data — same view as Docker. |
| `remote` | Remote / cloud cluster | View your telemetry in BMC Helix. The local viewer isn't reachable from a remote cluster. |

The fetch URL changes from `?viewer=${viewerEnabled}` to `?target=${clusterTarget}`. The download link does the same.

The `handoff` checkbox and disabled "OpenTelemetry Operator" checkbox are unchanged.

## Backend Route Changes

### `backend/routes/k8s.js`

- Replace `wantsViewer(req)` with `getTarget(req)` returning `'local'` or `'remote'` (default: `'local'`).
- Pass `target` to `buildChartFiles()` instead of `viewerEnabled`.

## Chart Generation Changes

### `backend/k8sChart/transformCollectorConfig.js`

- **Signature:** `transformCollectorConfig(yamlString, { target })` — replaces `{ viewerEnabled, viewerServiceName }`.
- **`target === 'local'`:** Rewrite `otlphttp/helix_local_viewer` exporter endpoints from `http://helix-configurator:3001/api/otlp/*` to `http://host.docker.internal:8765/api/otlp/*`. The regex replacement stays (`/^https?:\/\/[^/]+/`), just the replacement string changes.
- **`target === 'remote'`:** Strip the exporter from `doc.exporters` and from all pipeline exporter arrays. Same logic as current `viewerEnabled=false`.
- **Delete:** `viewerServiceName` parameter (no in-cluster viewer service to name).

### `backend/k8sChart/renderValues.js`

- **Delete from `DEFAULTS`:** `viewerName`, `viewerImage`, `viewerTag`.
- **Delete from generated values:** The entire `viewer:` block. Values contain only `helix:` and `gateway:`.
- **Delete parameter:** `viewerEnabled`.

### `backend/k8sChart/buildChart.js`

- **Signature:** Replace `{ viewerEnabled, viewerServiceName }` with `{ target }`.
- Pass `target` through to `transformCollectorConfig()`. The `renderValues()` call no longer needs any viewer-related param — just drop it.

## Helm Chart Skeleton Changes

### Delete

- `helix-otel/templates/viewer-deployment.yaml`
- `helix-otel/templates/viewer-service.yaml`
- `helix-otel/templates/viewer-pvc.yaml`

### Update `helix-otel/templates/NOTES.txt`

Remove all LoadBalancer/ClusterIP viewer branching. Gateway instructions stay. Replace viewer section with static text:

> Telemetry is flowing to Helix.
> If running on a local cluster (Docker Desktop k8s), telemetry also flows to http://localhost:8765/otel-data.

The exporter's presence in the collector config is what actually gates the local viewer behavior, not NOTES.txt.

### No static `values.yaml` in skeleton

The skeleton has no static `values.yaml` — it's generated by `renderValues.js` and injected at build time. Removing the `viewer:` block from `renderValues.js` (above) is sufficient.

## Test Changes

### `backend/__tests__/k8sChart-transform.test.mjs`

- Replace `viewerEnabled=true` tests with `target='local'` tests asserting `host.docker.internal:8765` in rewritten endpoints.
- Replace `viewerEnabled=false` tests with `target='remote'` tests asserting exporter stripped.
- Remove `viewerServiceName` customization tests.
- Keep: health_check injection, malformed YAML, missing-exporter-graceful tests.

### `backend/__tests__/k8sChart-values.test.mjs`

- Assert no `viewer` key in generated values.
- Remove `viewerEnabled` toggle test.
- Remove `viewerName`/persistence assertions.
- Keep: endpoint/xSource baking, apiKey omission, stable gateway name, valid YAML tests.

### `backend/__tests__/k8sChart-build.test.mjs`

- Replace `viewer=true/false` with `target=local/remote`.
- Assert no `viewer` section in values for either target.
- Assert `host.docker.internal:8765` in gateway config for `target=local`.
- Assert exporter stripped for `target=remote`.

### `backend/__tests__/k8s-routes.test.mjs`

- Replace `viewer=true/false` query params with `target=local/remote`.
- Remove viewer-exporter presence/absence assertions, add `host.docker.internal` assertions for local.
- Keep: handoff, key-embedded, missing-skeleton, zip download tests.

### `backend/__tests__/k8s-helm-smoke.test.mjs`

- Remove PVC-when-viewer-enabled assertion.
- Confirm `helm template` renders only gateway resources (Deployment, Service, ConfigMap, Secret) — no viewer Deployment/Service/PVC.
- Keep: helm lint, ConfigMap content, gateway probe tests.

## Documentation Changes

### `README.md`

- Remove: port-forward viewer instructions, image-load instructions, `--set viewer.enabled=false`.
- Add: "Local clusters (Docker Desktop k8s) send telemetry back to localhost:8765/otel-data automatically."

### `docs/architecture/ARCHITECTURE.md`

- Update pipeline diagrams: K8s local mode shows `host.docker.internal:8765`, not an in-cluster viewer service.
- Remove in-cluster viewer deployment references.

### `docs/COMPREHENSIVE-GUIDE.md`

- Same updates as ARCHITECTURE.md.

### `frontend/public/k8s-walkthrough.html`

- Remove viewer-specific instructions (port-forward, image load).
- Update to reflect local/remote modes.

## Unchanged

- **`/otel-data` page** (`OtelDataPage.tsx`) — the viewer UI itself is unchanged.
- **OTLP ingest routes** (`routes/otlp.js`) — already handle inbound data on `/api/otlp/*`.
- **SQLite store** (`otelStore.js`) — data layer is unchanged.
- **Base collector config** (`helix-otel-collector.yaml`) — its `otlphttp/helix_local_viewer` exporter still targets `helix-configurator:3001` for Docker Compose mode. The K8s chart transform handles the rewrite per target.
- **Gateway templates** (deployment, service, configmap, secret) — untouched.
- **`backend/validate.js`** — its warning about missing/unwired `otlphttp/helix_local_viewer` is about the Docker Compose config, not K8s. Unchanged.

## Phase 2 Compatibility: OTel Operator

The design is forward-compatible with a future Phase 2 where the generated chart uses the OTel Operator (`OpenTelemetryCollector` CR) instead of raw Deployment + ConfigMap.

**`target` and `deploymentMethod` are orthogonal axes:**

| | Raw Helm (Phase 1) | OTel Operator (Phase 2) |
|---|---|---|
| **Local** | Gateway ConfigMap embeds config with `host.docker.internal:8765` exporter | Operator CR embeds same collector config with same exporter |
| **Remote** | Gateway ConfigMap embeds config with exporter stripped | Operator CR embeds same config with exporter stripped |

`transformCollectorConfig()` operates on raw collector YAML regardless of how it gets deployed. The Operator's CR wraps the same format — the transform function is reusable.

The function signature `{ target }` extends cleanly to `{ target, deploymentMethod }` in Phase 2 without a boolean-to-enum migration. The disabled "OpenTelemetry Operator" checkbox in the modal becomes a second, independent toggle that sets `deploymentMethod`.

No over-engineering is needed now. The Phase 2 path is: add a `deploymentMethod` param, generate CR templates instead of raw templates, reuse the same transform + values logic.
