# Kubernetes deployment — decision + Docker→K8s parity map

> **Decision memo** · Created 2026-06-03 · Round shape: *"decision + parity map"* (no code)
> Source brief: `docs/handoffs/01-local-to-kubernetes.md` (High priority)
> Status: **Draft for review**
> Note: `docs/` is gitignored in this repo — this is a local-only working note, consistent
> with the other handoff/spec docs.

This memo settles the architecture for taking the configurator from Docker Desktop to
production Kubernetes, and gives the plain-English Docker→K8s map the brief asked for. It is
an **education + decision** artifact, not an implementation plan. If the direction holds, the
follow-on is a *build* round scoped to **Phase 1 only** (see §4), which gets its own
spec → plan.

---

## 1. TL;DR — the recommendation

Three decisions, settled:

1. **Phase it: generate first, run in-cluster later.** **Phase 1** makes the configurator
   *emit a self-contained Helm chart* you `helm install` — it stays a local/CI tool pointed at
   your cluster via a kubeconfig. **Phase 2** (post-POC) lifts the configurator *into* the
   cluster as a control plane that manages those same resources live. One codebase; Phase 1's
   output is Phase 2's substrate, so no work is thrown away.

2. **Default to an Operator-free chart; make the OTel Operator an opt-in.** The validated demo
   ask was *"it would be cool if it could generate the Helm charts needed to run this in K8s"* —
   that means a chart with **zero prerequisites**. The OpenTelemetry Operator (which unlocks
   zero-code auto-instrumentation — brief 04) rides behind a flag for shops that want it, rather
   than being a thing every customer must install first.

3. **Keep the local viewer in the K8s story** — as an optional in-chart Deployment on a PVC,
   reached by `kubectl port-forward`. Parity with today's "View OTel Data" is the north star;
   "just use Helix" is the fallback, not the default.

The mental-model shift underneath all three: in Docker the configurator **does things to
containers**; in Kubernetes it **declares desired state** and lets controllers reconcile.
Phase 1 expresses that as *"generate the declaration"*; Phase 2 as *"hold and patch the
declaration live."*

**Why this order:** it ships exactly what was asked for first (a chart that just runs), defers
the expensive, security-heavy part (an in-cluster control plane holding cluster credentials)
until the POC has earned it, and reuses every artifact across phases.

---

## 2. Kubernetes for the Docker-fluent (the one big idea)

Today the configurator's superpower is the **Docker socket** (`/var/run/docker.sock`). Through
it the configurator *reaches into the host and acts*: attaches the gateway to your app's
network, restarts containers, recreates the gateway after an edit, reads other collectors'
mounted configs. It is, in Docker terms, a hands-on operator.

Kubernetes has no such socket, and its whole philosophy inverts that posture:

- You don't *start a container* — you **declare** "I want a Deployment with this spec," and a
  controller keeps reality matching it (restarts crashed pods, reschedules across nodes).
- You don't *attach a network* — every Pod gets a cluster-wide DNS name via a **Service**
  (`helix-gateway.<namespace>.svc`). No bridging required; this is why a whole column of the
  Docker design simply disappears.
- You don't *edit a file in a container and restart it* — you change a **ConfigMap** (or a
  custom resource) and trigger a **rollout**, usually by re-applying a manifest rather than
  poking the live object.

So porting to K8s isn't a 1:1 translation of the configurator's Docker calls — it's a **posture
change**, from *imperative* ("do X to this container now") to *declarative* ("here's what the
world should look like"). The parity map in §3 is that translation. The phased plan is just
*where the declaration is authored*: by a chart the user applies (Phase 1) → by the configurator
itself, holding and patching it live (Phase 2).

A few term swaps to anchor the rest of the doc:

| Docker term | Kubernetes term | One-liner |
|---|---|---|
| Container | **Pod** | smallest deployable unit (one+ containers) |
| `docker run` / compose service | **Deployment** | declares N replicas of a Pod; self-heals |
| Compose network + container DNS | **Service** | stable in-cluster DNS + load-balancing for a set of Pods |
| Bind-mounted config file | **ConfigMap** | non-secret config delivered to Pods as files/env |
| `.env` secrets | **Secret** | same, for sensitive values |
| Named volume / bind mount | **PersistentVolumeClaim (PVC)** | durable storage that survives Pod restarts |
| `docker-compose up` | **`helm install`** | apply a templated bundle of the above |
| Docker socket (host-root) | **ServiceAccount + RBAC** | scoped API permissions, not host-root |

---

## 3. The parity map (the spine)

For each thing the configurator does in Docker today: the mechanism now, its K8s equivalent,
and how each phase handles it. The default path uses plain resources (Deployment + ConfigMap);
the **Operator** flavor swaps the gateway rows for a single custom resource — see §6.

| Capability | Docker today | Kubernetes equivalent | Phase 1 — *generate* (laptop/CI + kubeconfig) | Phase 2 — *in-cluster* control plane |
|---|---|---|---|---|
| **Run the gateway** | `helix-gateway` compose service + mounted YAML | A **Deployment** running `otel/opentelemetry-collector-contrib`, config from a **ConfigMap** (optional node **DaemonSet** later) | Chart templates the Deployment + ConfigMap from your current `helix-otel-collector.yaml` | Configurator patches the ConfigMap + rolls the Deployment live |
| **Bring-up** | `docker-compose up` | **`helm install`** of the generated chart | The headline feature: **"Generate K8s chart"** → `helm install` | `helm upgrade` or direct API patches, driven by the configurator |
| **Reach the gateway / point app at it** | dockerode attaches gateway to the app's compose network; Step 2 snippet | A **Service**: `helix-gateway.<ns>.svc:4318` cluster-wide — **no bridging needed** | Chart emits the Service; Step 2 snippet becomes "set `OTEL_EXPORTER_OTLP_ENDPOINT` to the Service DNS" | Same; optionally auto-inject via the Operator `Instrumentation` CR (brief 04) |
| **Smart-add an exporter to a detected collector** | Edit the collector's mounted config + restart, via socket | **Patch the collector's ConfigMap (or `OpenTelemetryCollector` CR) + rollout restart** | Patch is *generated* for the user to `kubectl apply` / `helm upgrade` | Configurator patches it **live** via the K8s API |
| **Discover collectors** | `docker ps` via socket | **List via the K8s API** — label selectors over Pods/Deployments (+ Operator CRs if present) | Read-only list using your **kubeconfig** | Same list using the configurator's **ServiceAccount** |
| **Restart a collector** | `docker.restart()` | **`kubectl rollout restart`** equivalent via the API | Generated command / one-click via kubeconfig | Live via ServiceAccount |
| **Host access mechanism** | `/var/run/docker.sock` (effective host-root) | **ServiceAccount + scoped RBAC Role** (read pods/collectors; patch named CRs/ConfigMaps in named namespaces) | **None** — uses your kubeconfig; no in-cluster footprint | Scoped Role/RoleBinding in the chart — the security-review surface |
| **Local "View OTel Data" viewer** | Sibling container; gateway fans out to `helix-configurator:3001`; SQLite on bind-mounted `./data` | Viewer **Deployment** (1 replica) + **PVC** for SQLite; gateway fans out to the viewer **Service**; reached via **port-forward** / Ingress | Included by default (flag to disable); `kubectl port-forward` to view | Always-on in-cluster; Ingress optional |
| **Secrets (`HELIX_API_KEY`, auth)** | Plaintext `.env`, bind-mounted | **Secret** (or external-secrets / Vault) surfaced as env | Chart templates a Secret; value supplied at install, never committed | Same; optionally integrate a secrets operator |
| **Config edit + "recreate gateway"** | Edit YAML in the dashboard → recreate container via socket | Change the ConfigMap → **rollout restart** | Re-generate / `helm upgrade` | Configurator does the patch + rollout live — the **closest analog to today's behavior** |

---

## 4. The phased plan

### Phase 1 — "Generate the K8s chart" (the validated ask)

- **What it is:** a new action in the configurator — *"Generate Kubernetes deployment"* — that
  emits a **self-contained Helm chart**, pre-wired to Helix from your current state
  (`helix-otel-collector.yaml` → gateway ConfigMap; `HELIX_API_KEY` → Secret;
  `HELIX_ENDPOINT` / `X_SOURCE` already in hand).
- **What's in the chart:**
  - Gateway **Deployment** + **ConfigMap** (your pipeline YAML) + **Service** (`4317/4318/8888`).
  - **Secret** for `HELIX_API_KEY` (value supplied at `helm install` time, never committed).
  - Viewer **Deployment** + **PVC** + **Service** — **on by default**, with a flag to disable (per §1.3).
  - Liveness/readiness probes, resource requests/limits, sensible labels.
- **What the user does:** `helm install helix ./helix-chart --set helix.apiKey=…` → gateway
  comes up → point apps at `helix-gateway.<ns>.svc:4318` → (optional) `kubectl port-forward`
  the viewer.
- **Configurator footprint in the cluster:** **none.** It generated files; you applied them.
  The easiest possible security review.
- **Not a dead generator:** with a kubeconfig, the configurator (still on your laptop) can
  *also* list collectors, patch the gateway, and trigger rollouts against the cluster. Those
  live paths are optional in Phase 1 and become the default in Phase 2.

### Phase 2 — In-cluster control plane (post-POC)

- The configurator runs as its **own Deployment** with a **ServiceAccount + scoped RBAC**.
- It manages the same gateway resources **live** (patch ConfigMap/CR, rollout restart) instead
  of regenerating files.
- The viewer runs persistently in-cluster on its PVC; Ingress optional.
- This is where the Fortune-500 RBAC review lands — deferred until the POC proves value.

### The three rules that keep Phase 1 from cornering Phase 2

1. **One K8s-client abstraction** behind discovery/lifecycle. Use `@kubernetes/client-node`;
   its default config loader detects an **in-cluster ServiceAccount** when present and otherwise
   reads your **kubeconfig** — same code, two credential sources. Build this layer as the K8s
   analog of today's dockerode layer.
2. **The generated chart *is* the Phase-2 substrate.** Whatever Phase 1 emits, Phase 2 *patches
   the same objects* live. Don't invent a separate Phase-2 resource model.
3. **Template the viewer as optional from day one.** Even shipping off-by-default, having the
   Deployment+PVC in the chart means Phase 2 flips a flag rather than designing it later.

---

## 5. The honest gaps — what does NOT carry over cleanly

- **No Docker socket.** Every dockerode path (`backend/routes/discovery.js`, `lifecycle.js`,
  `containers.js`, the setup in `backend/index.js`) needs a K8s-client equivalent behind the
  shared abstraction. This is the single largest code change — but it is mostly **Phase 2**;
  Phase 1 only needs *read + generate*.
- **SQLite is single-writer.** The viewer store can't scale to multiple replicas. Answer:
  **PVC + exactly one replica**, with the **`Recreate`** deployment strategy (not
  `RollingUpdate`) so two writers never overlap during an upgrade. The current 60s
  `stop_grace_period` becomes `terminationGracePeriodSeconds` so the store checkpoints cleanly
  on Pod termination. HA is explicitly out of scope.
- **`.env`-file substitution at startup** → ConfigMap/Secret + env. The collector's
  `${env:HELIX_*}` substitution still works; the values just come from a Secret-backed env var.
- **"Recreate the gateway after edit"** → a **rollout**. Phase 1: `helm upgrade`. Phase 2: live
  patch + rollout. The current self-restart-via-socket flow (productization-todo, "Self-restart
  edge cases") has no analog and isn't needed — K8s owns restarts.
- **Hardcoded names** (`helix-gateway`, `helix-bridge`) → chart values / labels. Fold the
  existing `TARGET_CONTAINER_NAME` / `SELF_CONTAINER_NAME` overrides (productization-todo,
  "Brittle Docker assumptions") into chart parameters.

---

## 6. The OTel Operator — the opt-in upgrade (not the default)

- **What it is:** a small CNCF controller installed once per cluster. With it, you stop shipping
  a Deployment+ConfigMap for the gateway and instead ship a single **`OpenTelemetryCollector`**
  custom resource; the Operator reconciles it into the real Deployment/Service.
- **What it buys:**
  - **Zero-code auto-instrumentation** via the Operator's **`Instrumentation`** CR (pod
    annotation → init-container injects the agent). This is the native K8s form of **brief 04**.
  - More idiomatic management (patch a CR, not raw resources) and a slightly cleaner Phase-2 story.
- **What it costs:** a **cluster-wide operator install** — standard and CNCF-blessed, but some
  locked-down enterprises scrutinize any operator. That is exactly why it is **not** the default
  for the "just generate me a chart" ask.
- **How we support it:** a flag on the generate step — `--operator` emits the CR flavor (assumes
  the Operator is present); the default emits the self-contained raw-resource chart. Same parity
  map; only the gateway rows swap. First-class *"support both forever"* is deferred until a real
  customer constraint demands it.

---

## 7. Deferred to a build round (flagged, not solved here)

- **Target platforms.** Default stance: a **platform-agnostic** chart. Caveats to handle when
  building: **OpenShift** SecurityContextConstraints (non-root, no privileged), **Pod Security
  Admission** (restricted), and service-mesh sidecars (Istio/Linkerd) altering port behavior.
  EKS/GKE/AKS are largely uniform.
- **Viewer exposure:** port-forward (default) vs. Ingress (per-controller annotations) vs.
  "prod stance = just use Helix." We keep the viewer; *how* it's exposed is a build choice.
- **Phase-2 RBAC scope:** the exact verbs/resources a security review accepts (read
  pods/collectors; patch named CRs/ConfigMaps in named namespaces; never cluster-admin).
- **Multi-namespace / multi-cluster / fleet:** single-cluster onboarding first; fleet is a
  later horizon.
- **UI placement** of "Generate K8s chart," and whether it reads live state or a saved config.
- **Test bed:** the Jaeger `examples/otel-demo/` Helm deploy (polyglot trace producers + real
  storage) as the parity smoke target (cited in productization-todo).

---

## 8. Cross-links

- **Brief 04 (auto-instrumentation):** the Operator's `Instrumentation` CR is the K8s-native
  form — §6 is the bridge. Co-design.
- **Brief 05 (OTel Blueprints):** the in-progress *"Kubernetes observability"* Blueprint maps
  ~1:1 onto this; the generated chart could *be* a BMC reference implementation of it, and the
  Phase-1 generator is literally Blueprint Phase C ("generate Blueprint-conformant artifacts").
- **Brief 02 (resource metrics):** in K8s the CPU/mem source becomes the
  `kubeletstats` / `hostmetrics` receivers (vs. `docker_stats` in Docker) — keep the metric
  model portable. (Being worked concurrently on `feat/trace-resource-metrics`.)
- **Productization-todo:** the "Kubernetes deployment story" entry, plus the
  secrets / auth-revamp / socket-lockdown blockers that Phase 2 must satisfy.

---

## Appendix — the fork, and how we resolved it

The brief framed one big fork: **(1)** in-cluster control plane vs. **(2)** local tool targeting
a remote cluster. We did not pick a pole — we **sequenced** them. Phase 1 *is* model (2) (local,
generates artifacts); Phase 2 *is* model (1) (in-cluster control plane). The insight that makes
the sequence safe rather than a rewrite: a local tool with a kubeconfig and an in-cluster tool
with a ServiceAccount are the **same control-plane logic** with two credential sources, so the
evolution is additive. Likewise, the Operator question resolved not as "assume it" vs. "support
both," but as **"default off, opt-in on"** — driven by the concrete demo ask for a chart that
runs with no prerequisites.
