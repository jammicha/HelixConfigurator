# 06 — Branch the onboarding wizard by target (Docker vs Kubernetes)

> **Handoff brief** · Priority: **High** · Created 2026-06-04 · Status: **Shipped** —
> merged to main `07213f6` (2026-06-05); the third (OTel Operator) target followed on 06-09.
> Kept as the original brainstorm record.
> Shape: **brainstorm brief** — explore widely before converging.
> Read the Phase 1 spec + the decision memo first (see Cross-links).

## TL;DR

Phase 1 shipped a **"Generate K8s chart"** capability — a dashboard action plus a Helm-chart
generator. But the **onboarding wizard is Docker-only end-to-end**, and the K8s capability is just
a button on the dashboard. The product's primary surface *is* the guided onboarding, so the K8s
story should be a **first-class onboarding path**, not a bolt-on. Design a **target-branched
onboarding**: ask "Docker or Kubernetes?" early, keep what's universal, and fork what isn't.

## Origin (demo/build feedback)

While testing Phase 1, James flagged it: the "Generate K8s deployment" button was buried (dashboard,
inside the expandable Gateway Config card — now promoted to QuickActions as a stopgap), and the
onboarding wizard assumes Docker throughout.

> "Shouldn't the 'Running in Kubernetes?' delta happen much earlier in the onboarding? Step 1 is
> ~universal for Docker and K8s; Step 3 (connect to a Docker network) is probably Docker-specific."

He's right — and the fork actually starts at **Step 1's *mechanism*** (how the gateway runs).

## Current onboarding (Docker-only) — per-step Docker-specificity

| Step | What it does (today) | Docker-specific? |
|---|---|---|
| **1** | Paste Helix creds (endpoint/key/X-Source) → save to `.env` → **recreate the gateway container** | Creds are **universal**; the "recreate the container" mechanism is Docker |
| **2** | Instrument the app / point it at the gateway (snippet) + smart-add to detected collectors | Instrumenting is **universal**; the endpoint (`helix-gateway:4318` on the bridge) + socket-based collector detection are Docker |
| **3** | **Bridge the gateway onto the app's Docker network** + verify connectivity | **Pure Docker** — in K8s a Service gives the gateway a DNS name automatically; "a whole column of the Docker design disappears" (decision memo §2) |
| **4** | Verify telemetry is flowing (receiver counters, see spans/logs) | **Universal intent** (polls the Docker gateway today) |
| **5** | Link X-Source → Helix business service / finish | **Universal** (Helix-side) |

## The design question

**Where does the fork go, and what's shared vs forked?**

- **Recommended fork point:** the **top of onboarding** (a "Where will this run? Docker / Kubernetes"
  selector before Step 1), because the answer changes *how the gateway runs* — a container the
  configurator recreates (Docker) vs. a Deployment the user installs from the generated chart (K8s) —
  and that colors every later step.
- **Shared spine:** creds (Step 1) → instrument the app (Step 2) → verify telemetry (Step 4) → link
  to a Helix business service (Step 5).
- **What the K8s branch forks:**
  - the gateway-run mechanism (chart + `helm install`, not container recreate);
  - **Step 2's endpoint snippet**: `helix-gateway:4318` → the in-cluster Service DNS
    (`helix-gateway.<ns>.svc:4318`);
  - **Step 3** (the big one): the Docker network-bridge becomes *"generate + `helm install` the
    chart, then point apps at the gateway Service"* — no bridging needed.

## Key files

- **Wizard:** `frontend/src/components/wizard/{Stepper,Step1..Step5}.tsx`; `frontend/src/App.tsx`
  (the step state machine + the `<QuickActions>` / dashboard render).
- **Phase 1 K8s feature (reuse):** `backend/k8sChart/*`, `backend/routes/k8s.js`,
  `frontend/src/components/K8sChartModal.tsx`, the `helix-otel/` chart;
  `frontend/src/components/dashboard/QuickActions.tsx` (where the stopgap entry point now lives).
- **Docker mechanics that don't carry over:** `backend/routes/{lifecycle,discovery,containers}.js`
  (dockerode bridge/recreate/discover), the Step 3 network-attach.

## Open questions & decisions

- **Generate-only or live?** Does the K8s path stay generate-only (Phase 1 style — emit a chart the
  user installs) or assume a reachable cluster (kubeconfig) for live discovery/verify? Generate-only
  keeps it simple and matches Phase 1; live wiring is the Phase 2 in-cluster story.
- **Step 4 "verify" in K8s:** verify against *what*? If generate-only, the configurator can't see the
  user's cluster gateway. Maybe Step 4 becomes "here's how to `kubectl get pods` / port-forward the
  viewer" guidance rather than a live poll.
- **Step 2 in K8s:** how much changes beyond the endpoint? (No socket-based collector detection.)
- **State:** does the target choice persist (saved server-side / localStorage) like the wizard step?
- **Operator flavor / auto-instrumentation** (brief 04): fold into the K8s branch or defer?
- **Platform caveats** (OpenShift SCC, restricted PSA, the viewer root-image caveat): surface in
  onboarding copy, or keep in the chart README?

## Cross-links

- **Phase 1 spec:** `docs/superpowers/specs/2026-06-03-generate-k8s-chart-design.md`
- **Phase 1 plan:** `docs/superpowers/plans/2026-06-03-generate-k8s-chart.md`
- **Decision memo:** `docs/superpowers/specs/2026-06-03-kubernetes-deployment-decision-design.md`
  (the phased approach — this branched onboarding is the natural Phase 1.5 / Phase 2 UX)
- **Original brief:** `docs/handoffs/01-local-to-kubernetes.md`
- **Brief 04** (sidecar auto-instrumentation), **Brief 05** (OTel Blueprints) — co-design candidates.

## How to use this brief

**Brainstorm first** — this is a design brief, not an implementation plan. Shape the branched flow
(fork point, shared spine, the K8s Step 3), get it approved, then spec → plan → build like Phase 1
(fresh worktree, TDD, subagent-driven). The Phase 1 artifacts above are the model for the cycle.
