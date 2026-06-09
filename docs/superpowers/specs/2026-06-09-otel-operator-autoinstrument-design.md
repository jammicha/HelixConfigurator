# OTel Operator + Auto-Instrumentation as a Third Wizard Target

> **Design spec** · Created 2026-06-09 · Branch: `brainstorm/otel-operator-autoinstrument`
> Combines [handoff 01 (local → Kubernetes)](../../handoffs/01-local-to-kubernetes.md) and
> [handoff 04 (sidecar auto-instrumentation)](../../handoffs/04-sidecar-auto-instrumentation.md).
> Status: **awaiting user review** before writing the implementation plan.

## TL;DR

Add a **third onboarding target** — *Kubernetes (OTel Operator)* — alongside the
existing `docker` and `kubernetes` cards. Picking it generates a **separate Helm
chart** (`helix-otel-operator/`) that expresses the gateway as an
`OpenTelemetryCollector` CR and ships an `Instrumentation` CR for **zero-code
auto-instrumentation** (Java, Node.js, Python, .NET) via pod annotations. The
existing `kubernetes` (plain Deployment) path and its `helix-otel/` chart are
**left untouched** — this is purely additive. Exactly one path renders per run;
the "one or the other, never both" guarantee is structural (you pick a card),
not a runtime conditional.

## Goals

- Reuse the wizard's existing **target-card toggle** (`TargetSelector` →
  `WizardTarget`) as the user's "Operator or not" choice. New card, new step
  variants, new chart skeleton — no new toggle paradigm.
- Generate an Operator-native chart: `OpenTelemetryCollector` (v1beta1) for the
  gateway + `Instrumentation` (v1alpha1) for auto-injection.
- Preserve **Docker-parity DNS**: apps keep reaching the gateway at
  `helix-gateway.<ns>.svc.cluster.local:4318`, so the existing
  `k8sGatewayEndpoint` helper works unchanged.
- Keep it **generate-only** — the configurator emits the chart + the exact
  prerequisite/install/annotate commands; the user applies them. No cluster calls.
- **Zero changes to `main`'s working paths**: don't edit `helix-otel/`,
  `Step2K8s`, `Step3K8s`, or the existing `kubernetes` branch behavior.

## Non-goals

- **eBPF / Go auto-instrumentation** (handoff 04's "Arm B"). Needs elevated
  privileges; separate concern. Big-four SDK languages only.
- **An in-cluster viewer.** Like the plain `helix-otel/` chart, the operator
  chart is **gateway-only**. The "local viewer" is the host configurator reached
  via `host.docker.internal:8765` (the `target=local` fan-out in
  `transformCollectorConfig`); commit `1b5b57a` replaced the bundled viewer with
  this host-loopback. No viewer Deployment/Service is generated. *(Aside:
  `Step4K8s` still has a stale `kubectl port-forward svc/helix-viewer` line
  referencing a Service that no longer exists in main — pre-existing, out of
  scope; the operator Verify tip won't depend on it.)*
- **Live cluster operations** (apply CRs, watch pods, read counters). Stays
  generate-only, matching the current K8s target. Live reconciliation is the
  documented future "Phase 2" seam, not this work.
- **Operator/cert-manager installation by the configurator.** We *document and
  emit* the commands; the user runs them (they need cluster-admin once).
- Touching the Docker target at all.

## Terminology (Kubernetes primer)

- **Resource** — a typed object you describe in YAML and hand to the cluster,
  which makes it real. Built-in types: `Pod`, `Deployment`, `Service`,
  `ConfigMap`, `Secret`.
- **CR (Custom Resource)** — a *new* kind of object that isn't built in. Here:
  `OpenTelemetryCollector` and `Instrumentation`.
- **CRD (Custom Resource Definition)** — the thing you install to teach the
  cluster a new `kind:`. Installing the OpenTelemetry Operator registers the two
  CRDs above.
- **Operator** — a program in the cluster that *watches* for CRs and does the work
  to make reality match them ("reconciling"). The OTel Operator turns an
  `OpenTelemetryCollector` CR into a real Deployment + Service, and uses the
  `Instrumentation` CR + a pod annotation to inject the agent.
- **Why the Operator is a prerequisite:** without it (and its CRDs) installed, the
  cluster has never heard of `kind: OpenTelemetryCollector`, so `helm install`
  fails with *"no matches for kind OpenTelemetryCollector"* (see Edge cases).

## Background: what's there today

- **Wizard target toggle.** `frontend/.../wizard/TargetSelector.tsx` renders a
  card grid; `WizardTarget = 'docker' | 'kubernetes'` is persisted to
  localStorage and drives step components (`Step3` vs `Step3K8s`), step labels
  (`getWizardSteps`), and the gateway endpoint helper. Its own comment: *"future
  targets slot in as new entries without restructuring the wizard."* This is the
  extension point.
- **App dispatch.** `App.tsx` switches each step with a binary
  `target === 'kubernetes' ? <K8sStep> : <DockerStep>`.
- **Chart generator.** `backend/k8sChart/` is pure + tested:
  `transformCollectorConfig.js` (live collector YAML → gateway config, with
  `target=local|remote` viewer fan-out), `renderValues.js` (values.yaml),
  `buildChart.js` (globs the `helix-otel/` skeleton + appends generated files into
  a zip). `routes/k8s.js` serves `/api/k8s/chart` (zip) and
  `/api/k8s/chart/preview` (JSON) with `secretCommand`/`installCommand`.
- **Chart skeleton.** `helix-otel/templates/` = Deployment + ConfigMap + Service +
  Secret + NOTES — a plain, Operator-free gateway.

## Key facts (verified against current OTel docs)

- `OpenTelemetryCollector` is **`opentelemetry.io/v1beta1`**, `mode: deployment`.
  Config is **structured YAML under `spec.config:`** (not a string); in v1beta1
  empty values must be `{}`/`[]`. The Operator auto-creates a managed Deployment
  and a Service named **`<cr-name>-collector`**, and derives container ports from
  the receivers in the config.
- `Instrumentation` is **`opentelemetry.io/v1alpha1`**. Injection is triggered by
  pod annotations: `instrumentation.opentelemetry.io/inject-java: "true"` (and
  `-nodejs`, `-python`, `-dotnet`). The value may be `"true"` (use the
  Instrumentation CR in the pod's namespace), a CR **name**, or
  **`<namespace>/<name>`** (cross-namespace).
- The Operator requires **cert-manager** (for its admission-webhook certs).
  Install order: cert-manager → Operator → `helm install` our chart.
- **Best practice: don't pin auto-instrumentation images.** Omitting `image:` in
  each language block lets the Operator inject its own version-matched defaults.
  We expose optional overrides but default them empty.

## Architecture

### The third target

`WizardTarget` gains `'kubernetes-operator'`. `TargetSelector` gets a third card:

| Card title | target | What it generates |
|---|---|---|
| Docker Desktop / Compose | `docker` | (unchanged) |
| Kubernetes (manual instrument) | `kubernetes` | (unchanged) `helix-otel/` plain Deployment chart — title relabeled, behavior identical |
| **Kubernetes — OTel Operator (auto-instrument)** | `kubernetes-operator` | **new** `helix-otel-operator/` chart (CRs) |

The new card's copy makes the tradeoff explicit: *"Operator-managed gateway +
zero-code auto-instrumentation (Java/Node/Python/.NET). Requires installing
cert-manager and the OpenTelemetry Operator once."* The plain card's tagline is
nudged to clarify it's the no-Operator, instrument-your-own-apps path.

### Frontend changes (additive)

- **`wizardTargets.ts`**: extend the `WizardTarget` union + `isWizardTarget`
  guard; add a `KUBERNETES_OPERATOR_STEPS` label set (Step 2 *"Prereqs &
  Generate"*, Step 3 *"Annotate"*); add an `isK8sTarget(t)` helper (true for both
  K8s variants) so App dispatch reads cleanly. `k8sGatewayEndpoint` is reused
  as-is.
- **`TargetSelector.tsx`**: one new entry in the `CARDS` array.
- **New components** (the two steps that genuinely differ):
  - `Step2K8sOperator.tsx` — a **Prerequisites** block (copy-paste cert-manager +
    Operator `kubectl apply` at **pinned versions** + wait commands) above the
    existing generate/download panel (reuse `K8sChartPanel` with the operator
    chart). Deep-links to `k8s-operator-walkthrough.html#prereqs`.
  - `Step3K8sOperator.tsx` — **"Annotate your pods."** Per-language annotation
    snippets; explains the Operator injects an init-container + env on the **next
    pod restart**; calls out the **namespace rule** (Instrumentation CR must be in
    the app's namespace or referenced `<ns>/helix-instrumentation`). Keeps the
    manual `OTEL_EXPORTER_OTLP_ENDPOINT` env as a labelled fallback. Deep-links to
    `k8s-operator-walkthrough.html#annotate`.
- **New static page** `frontend/public/k8s-operator-walkthrough.html` — mirrors the
  existing `k8s-walkthrough.html` scaffold/CSS; full operator runbook (`#prereqs` →
  `#generate` → `#secret` → `#install` → `#annotate` → `#verify` + troubleshooting).
- **Reused as-is**: `Step1` (Configure) and `Step4K8s` (Verify) — Verify gains one
  optional operator-only tip ("confirm the init container was injected:
  `kubectl get pod <p> -o jsonpath=...initContainers`"). Existing `Step2K8s` /
  `Step3K8s` are **not modified**.
- **`App.tsx`**: the binary step ternaries become a small three-way dispatch
  keyed on `target`. Existing `docker`/`kubernetes` branches are unchanged.

### Backend changes (additive)

- **New skeleton `helix-otel-operator/`** (sibling to `helix-otel/`):
  - `templates/collector.yaml` — `OpenTelemetryCollector` v1beta1, `mode:
    deployment`, `replicas`/`resources` from values, env (`HELIX_ENDPOINT`,
    `X_SOURCE`, `HELIX_API_KEY` from the Secret), and `spec.config:` = the
    transformed gateway YAML embedded with indentation (`.Files.Get ... | indent`).
  - `templates/instrumentation.yaml` — `Instrumentation` v1alpha1; `spec.exporter.
    endpoint` = the gateway; `propagators` + a parent-based sampler default;
    per-language blocks (`java`/`nodejs`/`python`/`dotnet`) each gated on
    `values.instrumentation.languages.<lang>` and with an optional `image`
    override (empty ⇒ omitted ⇒ Operator default).
  - `templates/gateway-service-alias.yaml` — a plain `Service` named
    **`helix-gateway`** selecting the Operator-managed collector pods (the
    Operator's `app.kubernetes.io/instance`/`name` labels), gated on
    `values.gateway.aliasService` (default `true`). **This preserves the stable
    `helix-gateway:4318` DNS** the wizard + Instrumentation endpoint rely on.
  - `templates/secret.yaml`, `_helpers.tpl`, `Chart.yaml`, `NOTES.txt` — mirror
    `helix-otel/`'s patterns; NOTES documents prereqs + the annotate command.
- **`backend/k8sChart/`**:
  - `transformCollectorConfig.js` — **reused unchanged**; its output drops under
    `spec.config:`. (The viewer-fan-out `target=local|remote` axis still applies
    and composes orthogonally with the engine choice.)
  - `renderValues.js` — parameterize by `engine`: operator values add
    `instrumentation: { languages: {java,nodejs,python,dotnet: true}, images: {…:''} }`
    and `gateway.aliasService: true`. The Operator owns the managed
    `helix-gateway-collector` Service; the only chart-managed Service is the
    `helix-gateway` **alias** (ClusterIP), so `service.type` applies to that alias.
  - `buildChart.js` — `CHART_DIR_NAME` + appended file paths become a function of
    `engine` (`helix-otel` vs `helix-otel-operator`).
- **`routes/k8s.js`** — add an `engine=deployment|operator` query param (default
  `deployment`, so existing callers are unchanged). For `operator`, `buildCommands`
  returns the **prereq commands** (cert-manager apply, Operator apply, waits — at
  **pinned versions** sourced from named constants, e.g. a small
  `k8sChart/operatorPrereqs.js`) plus the `helm install` of the operator chart.
  Preview JSON gains the operator file list + prereqs.

### Data flow (operator path)

```
User picks "Kubernetes — OTel Operator" card
  └─ target='kubernetes-operator' (localStorage)
Step 1  Configure Helix endpoint / key / X-Source  (Step1, unchanged)
Step 2  Prereqs (cert-manager + Operator) → Generate/Download chart
  └─ GET /api/k8s/chart?engine=operator&target=local|remote
       backend: transformCollectorConfig(live YAML) → spec.config
                renderValues(engine=operator) → values.yaml
                buildChart globs helix-otel-operator/ skeleton + generated files → zip
Step 3  Annotate pods (per-language annotations) + namespace rule
Step 4  Verify (kubectl + Helix deep-link; +init-container check)  (Step4K8s, reused)
```

At install time the user runs: cert-manager apply → Operator apply → create
Secret → `helm install helix ./helix-otel-operator …`. Apps get auto-instrumented
on their next restart once annotated.

## Error handling & edge cases

- **Invalid live collector YAML** — reuse the existing
  `INVALID_COLLECTOR_YAML` → 400 path in `routes/k8s.js`.
- **Missing operator skeleton on disk** — same warn-and-degrade pattern as
  `listChartFiles` today.
- **All languages toggled off** — the Instrumentation CR still renders (the
  gateway is still useful); NOTES notes that nothing will be injected until a
  language is enabled + a pod annotated. (No language block is required by the CR.)
- **Cross-namespace apps** — surfaced in Step 3 copy + NOTES: annotate with
  `inject-java: "<release-ns>/helix-instrumentation"` when apps live elsewhere.
- **`helm install` without the Operator present** — the CRs' CRDs won't exist;
  `helm install` fails fast with a clear "no matches for kind OpenTelemetryCollector"
  error. Step 2 ordering (prereqs first) + NOTES prevent this; we also mention the
  symptom so it's self-diagnosing.

## Testing strategy

Mirror the existing `backend/__tests__/k8sChart-*.test.mjs` + `k8s-routes` +
`k8s-helm-smoke` structure:

- **transform**: operator embedding — transformed config is valid under
  `spec.config`, health-check still ensured, viewer fan-out local/remote still
  correct.
- **renderValues (operator)**: language toggles add/omit blocks; empty image ⇒
  omitted; `aliasService` toggle; secret/endpoint/X-Source wiring.
- **buildChart**: `engine=operator` globs `helix-otel-operator/` and places
  generated files at the right paths; `engine=deployment` unchanged.
- **routes**: `?engine=operator` preview returns operator install + prereq
  commands and the operator file list; default (no param) is byte-identical to
  today.
- **helm smoke** (`helm template` shell-out, like the existing smoke test): the
  operator chart renders valid `OpenTelemetryCollector` + `Instrumentation` YAML;
  gated language sections appear/disappear; alias Service present; `helm lint`
  passes.
- **frontend**: extend `wizardTargets.test.ts` for the third target's labels +
  `isWizardTarget`/`isK8sTarget` guards. New step components are largely static
  (matching the existing K8s step components, which have no component tests).

## Decisions captured (from brainstorming)

1. **Operator-only chart, on a feature branch** — don't change `main`'s working
   paths. → separate `helix-otel-operator/` skeleton, new branch.
2. **One-or-the-other via the existing target toggle**, never co-installed. →
   third `TargetSelector` card, not a values flag, not both-at-once.
3. **Big-four languages** (Java/Node/Python/.NET). → Instrumentation CR blocks,
   each toggleable.
4. **Annotation-first Step 3** with manual env as fallback.
5. **Don't pin auto-instrumentation images** by default; allow override.

## Decisions resolved (review round, 2026-06-09)

6. **Engine param = `engine=deployment|operator`** (default `deployment`). Avoids
   collision with the CR's own `mode: deployment` and the existing
   `target=local|remote`.
7. **Relabel both K8s cards for contrast** — plain → *"Kubernetes (manual
   instrument)"*; new → *"Kubernetes — OTel Operator (auto-instrument)"*. This is a
   **copy-only** edit to `TargetSelector`; the plain card's `target` value stays
   `'kubernetes'` and its behavior is unchanged.
8. **Pin known-good prerequisite versions.** cert-manager + the OTel Operator are
   pinned to specific validated versions held as **named constants** (mirroring the
   collector-image `0.119.0` pin), chosen and smoke-validated at implementation
   time and easy to bump. Note: pinning the **Operator** version transitively pins
   the **default auto-instrumentation agent images** (we don't pin those directly,
   per decision 5), so the two image decisions compose cleanly.
9. **Document the runbook in a parallel walkthrough page**, not a chart README.
   Add `frontend/public/k8s-operator-walkthrough.html` mirroring the existing
   `k8s-walkthrough.html` scaffold/CSS, with operator sections:
   `#prereqs` → `#generate` → `#secret` → `#install` → `#annotate` → `#verify` +
   troubleshooting (CRD-not-found, agent-not-injected, cross-namespace). The
   operator step components deep-link into it, exactly as `Step3K8s`/`Step4K8s`
   link into the existing page today. A minimal `NOTES.txt` still renders
   post-install with the annotate hint + a link to the walkthrough.
