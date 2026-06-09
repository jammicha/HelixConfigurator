# 01 — Local Docker Desktop → Production Kubernetes

> **Handoff brief** · Priority: **High** · Created 2026-06-03 · Status: **Shipped** —
> Phase 1 chart generator (`1def94a`, 06-03), Phase 1.5 target-branched wizard (`07213f6`, 06-05),
> and the OTel Operator target (`1a5f3f2`, 06-09) are all on main. Kept as the original brainstorm record.
> Shape: **brainstorm brief** — explore widely before converging.
> Read [`../ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) and the README first.

## TL;DR

The configurator is a two-container `docker-compose` tool that reaches into the
Docker socket to wire a customer's app to a managed OTel gateway. The team asked:
**how do we take this from "a local app in Docker Desktop" to "a production
environment running Kubernetes"?** Goal: **as much parity as possible** with the
current Docker Desktop experience, on any major K8s platform.

## Origin (demo feedback)

> "How do we change this from a narrow *local app running in Docker Desktop* use
> case to a wider *production environment running Kubernetes* use case?"

James is candidly **not deeply versed in Kubernetes** — so part of this brief's
job is to *educate as it proposes*. Lead with a plain-English map of "here's the
Docker thing you have, here's its K8s equivalent," then a recommendation.

## Current state (everything assumes Docker Engine)

- **Deployment:** `docker-compose.yml` brings up `helix-configurator` +
  `helix-gateway` on a `helix-bridge` bridge network.
- **The configurator's superpower is the Docker socket.** It mounts
  `/var/run/docker.sock` and uses **dockerode** to: discover other collectors
  (`/api/discovery/collectors`), attach the gateway to the customer's compose
  network (`/api/lifecycle/bridge`, `bridge-network`), restart containers,
  recreate the gateway after `.env`/YAML edits, and Smart-add an exporter to a
  detected collector's mounted config. **None of this exists in K8s** — there is
  no Docker socket and no compose network to bridge.
- **Some K8s awareness already exists.** The **Connect step (Step 3)** detects
  Kubernetes-based collectors and offers a one-click **K8s Attribute Enrichment**
  template. That's the seed to build on, not a deployment story.
- **Local viewer fan-out:** the gateway sends traces+logs to
  `http://helix-configurator:3001/api/otlp/*` over the shared Docker network.
  The viewer's store is **SQLite on a bind-mounted `./data`** volume
  (single-writer, `stop_grace_period: 60s` to avoid corruption on shutdown).
- **Prior thinking lives in [`../productization-todo.md`](../roadmap/productization-todo.md)**
  under "Kubernetes deployment story" (High priority, "next phase after POC"):
  Helm chart, operator-pattern vs ConfigMap+Deployment+Service, **investigate the
  OpenTelemetry Operator**, ingress, liveness/readiness probes, and a concrete
  test bed — the Jaeger `examples/otel-demo/` Helm deploy (polyglot "astronomy
  shop" + real storage) as a parity smoke target.

## What "parity" should feel like in K8s

For each thing the operator does today in Docker, name the K8s equivalent. A
first-cut **parity map** (validate/extend this — it's the spine of the brief):

| Docker today | Mechanism today | K8s equivalent to design |
|---|---|---|
| `helix-gateway` container | compose service + mounted YAML | Collector as a **Deployment (gateway) + optional DaemonSet (node agent)** — via the **OpenTelemetry Operator** (`OpenTelemetryCollector` CR) or a Helm chart |
| Bring-up | `docker-compose up` | **Helm chart** / Operator CRs / kustomize for configurator + gateway + viewer |
| Bridge gateway onto app network | dockerode network attach | **Not needed** — a K8s `Service` gives the gateway cluster-wide DNS (`helix-gateway.<ns>.svc`) |
| "Point your app at `helix-gateway:4318`" | Step 2 snippet (manual) | Set `OTEL_EXPORTER_OTLP_ENDPOINT` to the gateway Service **or** auto-inject via the Operator's `Instrumentation` CR (**→ brief 04**) |
| Smart-add exporter to a collector's config | edit mounted file + restart | **Patch an `OpenTelemetryCollector` CR or the collector's ConfigMap** + rollout restart |
| Discover collectors | `docker ps` via socket | **List collectors/pods via the K8s API** (label selectors, the Operator's CRs) |
| Restart container | `docker.restart()` | `kubectl rollout restart` equivalent via the K8s API |
| Host-root via `docker.sock` | socket mount | **ServiceAccount + scoped RBAC Role** |
| Local "View OTel Data" viewer | fan-out to a sibling container | Same fan-out to a configurator **Service**, viewer runs as a Deployment, **SQLite on a PVC** (1 replica), reached via port-forward / Ingress |

The headline insight to brainstorm around: **the configurator's role shifts from
"runtime manipulator of containers" to "control plane that emits/patches K8s
manifests and talks to the K8s API."** In Docker it *does* things to containers;
in K8s the idiomatic move is to *declare* desired state (CRs / Helm values) and
let the Operator reconcile.

## The big fork to decide

**Where does the configurator run, and what is its job?** Two coherent models —
the brainstorm should pick (or blend) one:

1. **In-cluster control plane.** The configurator runs as a Deployment, uses a
   ServiceAccount + RBAC, manages the gateway via the OTel Operator, and serves
   the viewer in-cluster. Closest to "the Docker experience, but in the cluster."
2. **Local tool that targets a remote cluster.** The configurator stays a
   local/laptop tool, talks to a kubeconfig, and mainly **generates artifacts**
   (Helm chart / Operator CRs / manifests) the user applies. Lower blast radius,
   weaker "live wiring" magic, overlaps **brief 05** (generate Blueprint-conformant
   output).

## Open questions & decisions

- In-cluster vs. local-targeting-remote (the fork above)?
- **Operator vs. Helm vs. raw manifests** for the gateway? (Operator unlocks
  auto-instrumentation injection — strong tie to brief 04.)
- How does the **local viewer** survive? Does it stay (PVC-backed, port-forward/
  Ingress), or is the prod stance "just use Helix" and the viewer is a
  local-dev-only affordance? (Parity argues *keep it*.)
- **Discovery without the Docker socket** — what's the K8s analog of "find the
  customer's existing collector and Smart-add to it"? (Operator CRs? ConfigMap
  label conventions?)
- **RBAC scope** a Fortune-500 security review will accept (read pods/collectors,
  patch specific CRs in specific namespaces — not cluster-admin).
- **Multi-namespace / multi-cluster / fleet** — single-cluster onboarding first;
  how far toward fleet? Platform targets (EKS/GKE/AKS/OpenShift) — any specifics
  that break portability (OpenShift SCCs, PSA/PSS, Istio sidecars)?
- Secrets: `.env` plaintext today → **K8s Secret / external secrets** (also in
  productization-todo "Plaintext secrets").

## Constraints & known blockers

- **No Docker socket in K8s.** Every dockerode code path
  (`backend/routes/discovery.js`, `lifecycle.js`, `containers.js`) needs a K8s
  abstraction behind it — a big chunk of the backend assumes Docker.
- **SQLite is single-writer.** The viewer store can't naively scale to multiple
  replicas; a PVC + single replica is the simple answer (revisit if HA matters).
- **`.env`-file substitution** at gateway startup becomes a ConfigMap/Secret +
  env story; the "recreate the gateway after edit" flow becomes a rollout.
- Existing productization blockers apply: auth revamp, socket lockdown, secrets
  — see [`../productization-todo.md`](../roadmap/productization-todo.md).

## Suggested first moves

1. **Stand up a K8s test bed.** Use the Jaeger `examples/otel-demo/` Helm deploy
   cited in productization-todo (polyglot trace producers + real storage) as the
   target environment for everything below.
2. **Deploy the gateway the K8s-native way** — install the **OpenTelemetry
   Operator**, express `helix-gateway` as an `OpenTelemetryCollector` CR, confirm
   the Helix exporter + local-viewer fan-out still work pod-to-pod.
3. **Write a Helm chart** for `helix-configurator` + gateway + viewer (PVC for
   SQLite, Service, probes) — this is the concrete parity artifact.
4. **Prototype K8s-API discovery** — replace one dockerode path (e.g. "list
   collectors") with a K8s-client equivalent to prove the abstraction.
5. Draft the **parity map** above into a doc the team can react to — it doubles
   as the K8s education piece James asked for.

## Related prior art & files

- [`../productization-todo.md`](../roadmap/productization-todo.md) → "Kubernetes
  deployment story" (the canonical backlog for this) + secrets/auth blockers.
- README → "Connect (Step 3)" K8s collector detection + K8s Attribute Enrichment.
- [`../ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) → component map, fan-out, dockerode
  lifecycle endpoints, SQLite store. (NB: its "two-step wizard" line is stale.)
- Docker-bound backend to abstract: `backend/routes/discovery.js`,
  `backend/routes/lifecycle.js`, `backend/routes/containers.js`,
  `backend/index.js` (dockerode setup).
- **External:** OpenTelemetry Operator (`OpenTelemetryCollector` + `Instrumentation`
  CRDs), `opentelemetry-collector` / `opentelemetry-kube-stack` Helm charts,
  `k8sattributes` processor, `kubeletstats`/`hostmetrics` receivers.

## Cross-links

- **Brief 04 (auto-instrumentation):** the Operator's `Instrumentation` CR is the
  industry-standard "instrument the app with no code change" path — the K8s
  answer to 04. Design these together.
- **Brief 05 (OTel Blueprints):** "Kubernetes observability" is one of the three
  in-progress Blueprints; this work could *be* a Blueprint-conformant deployment.
- **Brief 02 (resource metrics):** in K8s, `kubeletstats`/`hostmetrics` receivers
  are the natural CPU/mem source — coordinate the metric model.

## How to use this brief

Brainstorm first. The biggest unlock is **deciding the fork** (in-cluster vs.
local-targeting-remote) and **whether to lean on the OTel Operator** — most other
choices fall out of those two. Keep "parity with the Docker experience" as the
north star James set.
