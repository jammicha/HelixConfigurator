# Target-branched onboarding (Docker vs Kubernetes) — design

> **Spec** · Created 2026-06-04 · Status: **Draft for review**
> Build branch: `feat/k8s-onboarding-branch` (worktree `.worktrees/k8s-onboarding-branch`)
> Source brief: [`docs/handoffs/06-k8s-onboarding-branch.md`](../../handoffs/06-k8s-onboarding-branch.md)
> Builds on Phase 1: [`2026-06-03-generate-k8s-chart-design.md`](2026-06-03-generate-k8s-chart-design.md) · decision memo [`2026-06-03-kubernetes-deployment-decision-design.md`](2026-06-03-kubernetes-deployment-decision-design.md)

This spec makes the Kubernetes story a **first-class onboarding path** instead of a dashboard
button. Phase 1 shipped the chart generator (backend + `K8sChartModal`); the onboarding wizard is
still Docker-only end-to-end. We add a **target selector** at the top of onboarding, share the
universal spine (creds → instrument → verify → link), and replace the Docker-specific network-bridge
step with a generate-and-install path. It is **generate-only** — the configurator never touches the
user's cluster — and **almost entirely frontend**: the Phase 1 chart routes are reused unchanged.

---

## 1. What we're building

A `target: 'docker' | 'kubernetes'` choice made on a new **"Where will this run?"** screen before
Step 1. The choice drives a single adaptive 5-step wizard whose universal steps are shared and whose
Docker-specific steps are replaced by Kubernetes equivalents:

| Slot | Docker (today, unchanged) | Kubernetes (new) | Shared? |
|---|---|---|---|
| **0** | — | **Target selector** (Docker / Kubernetes) | new, pre-step |
| **1 · Configure** | creds → save `.env` → **recreate gateway container** → network diagnostic | creds → save `.env` → continue (no recreate) | form shared, **commit forks** |
| **2** | **Exporter**: smart-add + exporter snippet (`helix-gateway:4318`) | **Generate**: generate & `helm install` the chart (the `K8sChartPanel`) | **forks** |
| **3** | **Connect**: bridge gateway onto the app's Docker network | **Point apps**: point apps/collectors at the gateway **Service DNS** | **forks** |
| **4 · Verify** | live receiver-counter poll + export-error scan | guidance: `kubectl get pods` / port-forward viewer / view in Helix | intent shared, **body forks** |
| **5 · Link Service** | link X-Source → Helix Business Service | identical | **shared** |

The product's primary surface is the guided onboarding, so K8s becomes co-equal with Docker rather
than a bolt-on. The dashboard "Generate Kubernetes deployment" button **stays** as a re-entry point
for users who already onboarded.

### Step-order refinement (deliberate deviation from the brief)

The brief lumped "generate + `helm install` + point apps" into a single K8s Step 3. We **split it
across slots 2 and 3** because the honest K8s order is *provision the gateway first, then point apps
at it* — you can't point an app at a Service that doesn't exist yet. So for K8s: **slot 2 = Generate
(stand up the gateway)**, **slot 3 = Point apps (instrument)**. This is the inverse of Docker's order
(instrument at 2, connect-network at 3), which is correct: in Docker the gateway container already
exists, so you instrument first; in K8s you must create it first. The per-target stepper labels make
this legible — the user never sees a mismatched slot.

---

## 2. Goals / Non-goals

**Goals**
- A target selector at the top of onboarding, built as an **extensible card grid** (room for
  bare-metal / a K8s Operator sub-flavor later, without restructuring).
- Share the universal spine (Step 1 form, Step 4 intent, Step 5) across targets; fork only what is
  genuinely target-specific.
- Make the K8s path first-class by **reusing the Phase 1 generator inline** as Step 2 (no new chart
  logic) and giving K8s honest Step 3 (point apps at the Service) and Step 4 (verify) content.
- Keep the proven Docker flow **untouched as the default branch** (lowest blast radius).
- Persist the target choice like the wizard step (localStorage), reversible via a target chip.

**Non-goals (deferred, see §13)**
- **Live cluster interaction** (kubeconfig discovery / apply / verify) — decision-memo Phase 2.
- **Live verify for K8s** (paste a reachable gateway URL / port-forward probe) — explicitly out;
  Step 4 K8s is guidance only this round.
- **OTel Operator / auto-instrumentation** (brief 04) — stays a "coming soon" affordance.
- New chart features, OpenShift-specific manifests, a bare-metal/systemd target — seams designed,
  not built.
- A React component-test harness (the repo has none; see §11).

---

## 3. Decisions locked in brainstorming

1. **Generate-only.** The K8s branch wraps the shipped Phase 1 generator. No kubeconfig, no cluster
   calls. Backend is reused as-is.
2. **Fork at the top, on a dedicated selector screen** (not a toggle inside Step 1) — because Step
   1's *commit action* diverges immediately (Docker recreates a container; K8s bakes creds into the
   chart), and the stepper labels differ. A screen lets the stepper render honestly from first paint.
3. **One adaptive stepper + the existing `setupStep` machine; forked steps delegate to target
   sub-components.** Universal steps stay put; `Step2/3/4` render a `…K8s` sibling when
   `target === 'kubernetes'`. The Docker components keep their names (no risky rename of the working
   flow).
4. **Selector is an extensible card grid.** Durable taxonomy: *peers* = Docker, Kubernetes, (later)
   bare-metal/systemd; *sub-flavors inside Kubernetes* = raw-vs-Operator and OpenShift; *different
   axis* = in-cluster control plane (Phase 2 operating mode). Build the two cards now; design the
   seam for the rest.
5. **K8s step order = Generate (2) → Point apps (3)** (the §1 refinement).
6. **State:** `target` persists in **localStorage** (`helix-configurator.target`), like `setupStep`
   — it's a flow choice, not a tenant credential. `reset-onboarding` clears it.
7. **Dashboard button stays** as a re-entry; its modal and the wizard step share one
   `K8sChartPanel` (DRY).
8. **Platform caveats** get a short inline callout + a link to the chart README, not a wall of text.

---

## 4. The target model & state (App.tsx)

```ts
type WizardTarget = 'docker' | 'kubernetes';
const [target, setTarget] = useLocalStorageState<WizardTarget | null>(
  'helix-configurator.target', null,
  (v): v is WizardTarget | null => v === null || v === 'docker' || v === 'kubernetes',
);
```

- **Selector gate:** when `!isSetupComplete && !target`, render `<TargetSelector>` *instead of* the
  Stepper + steps (there's nothing to step yet). Once `target` is set, the existing
  `Step{setupStep}` flow runs with per-target labels and bodies. `setupStep` (1–5) is **unchanged**.
- **Re-choose:** a small target chip near the Stepper / reset row — `Target: Kubernetes · change`.
  Clicking sets `target = null` (→ selector) and `setupStep = 1`. Non-destructive: creds stay in
  `.env`; switching only resets the step position (steps 2–3 differ by target, so restarting the
  branch is correct).
- **Reset-onboarding** (existing destructive flow): additionally clears
  `helix-configurator.target` so the user re-picks on the next run.

---

## 5. The selector screen — `wizard/TargetSelector.tsx` (new)

A centered card grid driven by a `TARGETS` array (extensible). Two cards this round:

| Card | One-liner | "What happens" |
|---|---|---|
| **Docker Desktop / Compose** | Run the gateway as a container next to your app. | The configurator manages a `helix-gateway` container locally and bridges it onto your app's network. |
| **Kubernetes** | Generate a Helm chart you install in your cluster. | We emit a self-contained chart pre-wired to Helix; you `helm install` it and point apps at the gateway Service. |

- Picking a card calls `onSelect(target)` → sets state → proceeds to Step 1.
- Carries the same secondary entries Step 1 has today: **"New to OpenTelemetry? Start here"** and
  **"Starting from zero?"** (`/step-zero`) — these are orthogonal to the target axis.
- No Stepper on this screen.

---

## 6. The Stepper — per-target labels (`wizard/Stepper.tsx`, small change)

`Stepper` takes a `steps: { n: number; label: string }[]` prop instead of the hardcoded `STEPS`.
Labels come from a pure helper:

```ts
// wizard/wizardTargets.ts
export function getWizardSteps(target: WizardTarget): { n: number; label: string }[] { … }
```
- **docker:** `Configure · Exporter · Connect · Verify · Link Service` (today's labels).
- **kubernetes:** `Configure · Generate · Point apps · Verify · Link Service`.

(Labels are final-tunable during implementation; the slots and counts are fixed at 5 for both.)

---

## 7. Step-by-step design

### Step 1 — Configure (shared form, forked commit)

- **Shared:** the creds form (endpoint / X-API key / X-Source) + **Test connection** (valuable on
  both targets — probes Helix from the configurator host; pure validation, no save). `Step1.tsx` is
  reused; it gains a `target`-aware primary-button label.
- **Forked commit** (`handleInitialize` branches on `target`):
  - **docker** (unchanged): `POST /api/env` → `POST /api/lifecycle/bridge` (recreate, compose reads
    `env_file` only at create) → `waitForGatewayRunning` → `GET /api/diagnostics/network` → Step 2.
    Button: **"Save & initialize →"**.
  - **kubernetes:** `POST /api/env` only → Step 2. No recreate, no network diagnostic (there is no
    local gateway relevant to the user's cluster). `POST /api/env` already reloads `process.env`
    (`backend/routes/env.js`), so the Step-2 chart preview reads the just-typed creds. Button:
    **"Save & continue →"**.
- The Step-1 recreate-failure surface (`bridgeStatus`) is Docker-only and is gated accordingly.

### Step 2 — forked entirely

- **docker — "Exporter"** (`Step2.tsx`, unchanged): smart-add to a detected collector, the exporter
  snippet (`http://helix-gateway:4318`), the namespace recipe.
- **kubernetes — "Generate"** (`Step2K8s.tsx`, new): renders the shared **`<K8sChartPanel>`**
  (§9) — viewer toggle, handoff toggle, "coming soon" Operator affordance, the 3 install steps
  (download & unzip → create secret → `helm install`), collapsible `values.yaml` / gateway-config
  previews, Download chart (.zip) — plus the wizard's Back / **"Next: Point apps →"** nav. Reads
  `GET /api/k8s/chart/preview` (fresh creds). **No gating on install** — we don't block on a cluster
  we can't see; the user can install now or later.

### Step 3 — forked entirely

- **docker — "Connect"** (`Step3.tsx`, unchanged): bridge `helix-gateway` onto the app's Docker
  network (detected / manual tabs), `step3-verify`.
- **kubernetes — "Point apps"** (`Step3K8s.tsx`, new):
  - The **Service-DNS endpoint** snippet, built by a pure helper
    `k8sGatewayEndpoint(namespace)` → `http://helix-gateway.<ns>.svc.cluster.local:4318`, with the
    in-namespace shorthand noted (`http://helix-gateway:4318` works when the app shares the gateway's
    namespace). An optional **namespace** input lets the snippet show the user's real namespace
    (default `default`).
  - **Two sub-cases**, mirroring Docker Step 2's structure:
    (a) app sends OTLP directly → set `OTEL_EXPORTER_OTLP_ENDPOINT` on the app Deployment;
    (b) app has its own collector → add the `helix-gateway` exporter to that collector's ConfigMap,
    then `kubectl rollout restart deployment/<collector>`.
  - The **namespace recipe** (distinct `service.namespace` per app for OTel-namespace rollup) is
    identical to Docker's and is shared via a small `<NamespaceRecipe>` component (§9).
  - No smart-add / Docker socket. Back / **"Next: Verify →"**.

### Step 4 — Verify (shared intent, forked body)

- **docker — "Verify"** (`Step4.tsx`, unchanged): live receiver-counter deltas + app-export-error
  scan + the `computeVerifyState` verdict.
- **kubernetes — "Verify"** (`Step4K8s.tsx`, new): a **guidance checklist** (generate-only can't
  poll the user's cluster gateway):
  1. **Gateway up?** `kubectl get pods -l app.kubernetes.io/part-of=helix-otel -n <ns>`
     (the chart's labels).
  2. **Watch locally** (if the viewer was included): `kubectl port-forward svc/helix-viewer
     3001:3001 -n <ns>` → open `http://localhost:3001/otel-data`.
  3. **See it in Helix:** the OTel-namespace dashboard deep-link (reuses the existing
     `externalApps`/`helixConfig` deep-link logic) — universal.
  - No live counters, no gating. Back / **"Next: Link your service →"**. A future "+live verify"
    affordance is noted as deferred (§13).

### Step 5 — Link Service (shared, unchanged)

`Step5.tsx` → `LinkBusinessService` — pure Helix REST, target-agnostic. No change.

---

## 8. Docker-specific effect gating (correctness)

Several `App.tsx` effects are Docker-socket / local-gateway specific and must not run on the K8s
branch (they would poll the *local configurator* gateway, not the user's cluster, and show
misleading zeros). Gate each to `target === 'docker'` (only while in the wizard; the post-onboarding
dashboard is unaffected — the configurator's own gateway always runs locally):

- the Step-4 receiver-counter + gateway-status 2 s poll;
- the Step-2/3 detected-collectors refresh (`/api/discovery/collectors`);
- `useSmartAdd` (collector config read/merge/restart);
- the Step-1 network diagnostic (already inside the docker commit branch).

The dashboard's always-on status/diagnostic polls stay as-is.

---

## 9. Component architecture & file layout

**Reuse via extraction (DRY):**
- **`components/K8sChartPanel.tsx`** (new) — the body of today's `K8sChartModal` (toggles, install
  steps, previews, download). One source of truth for the generate UX.
- **`components/K8sChartModal.tsx`** — refactored to wrap `<K8sChartPanel>` in dialog chrome
  (dashboard re-entry; behavior unchanged).
- **`wizard/Step2K8s.tsx`** — `<K8sChartPanel>` + wizard nav.
- **`wizard/NamespaceRecipe.tsx`** (new) — the multi-app `service.namespace` snippet, shared by
  Docker `Step2` and K8s `Step3K8s` (replaces the inline block in `Step2`).

**New, K8s steps:** `wizard/Step3K8s.tsx`, `wizard/Step4K8s.tsx`.

**New, selector + pure logic:** `wizard/TargetSelector.tsx`, `wizard/wizardTargets.ts`
(`WizardTarget`, `getWizardSteps`, `k8sGatewayEndpoint`, the localStorage validator).

**Render branch (App.tsx)** — minimal, low-risk ternaries on the existing slots:
```tsx
{!isSetupComplete && !target && <TargetSelector onSelect={setTarget} … />}
{target && <>
  <Stepper current={setupStep} steps={getWizardSteps(target)} onJump={setSetupStep} />
  …
  {setupStep === 2 && (target === 'kubernetes' ? <Step2K8s … /> : <Step2 … />)}
  {setupStep === 3 && (target === 'kubernetes' ? <Step3K8s … /> : <Step3 … />)}
  {setupStep === 4 && (target === 'kubernetes' ? <Step4K8s … /> : <Step4 … />)}
</>}
```
Steps 1 and 5 render once (shared), Step 1 with a `target`-aware button. The Docker components and
their props are untouched.

> **Note on `App.tsx` size.** It's already a ~1500-line wizard-state giant. We *extract* forked
> bodies into their own components and thread one `target` value rather than piling more branches in
> — targeted improvement of the file we're working in, not a gratuitous refactor.

---

## 10. Backend

**No new routes; no behavior changes.** The K8s branch reuses:
- `POST /api/env` (Step 1 commit; already reloads `process.env`).
- `GET /api/k8s/chart/preview` and `GET /api/k8s/chart` (Step 2; already support the `viewer` and
  `handoff` query params from the recent commits; `existingSecret` is a chart/`--set` value, not a
  route input).

The only backend-adjacent guarantee to preserve: K8s Step 1 must **not** call
`/api/lifecycle/bridge` (handled in the frontend commit branch). No `@kubernetes/client-node`, no
kubeconfig, no cluster calls anywhere.

---

## 11. Error handling

- **Chart preview/generate errors** (malformed live collector YAML, missing config) surface in the
  `K8sChartPanel` exactly as the modal does today (400 → inline message, etc.) — unchanged path.
- **K8s Step 1** has no recreate/diagnostic, so its only failure is a `POST /api/env` error → the
  existing `setupError` surface.
- The K8s steps make **no cluster calls**, so they have no cluster-failure states to handle — guidance
  only. This is a deliberate property of generate-only.

---

## 12. Testing strategy

- **Pure-util tests** (`wizard/wizardTargets.test.ts`, vitest — matches the repo's pure-`.test.ts`
  convention) are the TDD core, the analog of Phase 1's transform:
  - `getWizardSteps('docker' | 'kubernetes')` → correct labels, length 5, slot numbers 1–5;
  - `k8sGatewayEndpoint(ns)` → `http://helix-gateway.<ns>.svc.cluster.local:4318`; sensible default;
  - the `target` localStorage validator accepts `null | 'docker' | 'kubernetes'`, rejects junk.
- **No React component-test harness** in this repo (verified in Phase 1) → component verification is
  the **TypeScript build** (`npm --prefix frontend run build`) + manual smoke.
- **Backend:** no changes → the existing suite (k8s-routes, env, …) must stay green; run it to prove
  no regression.
- **Manual smoke** (both branches):
  - K8s: selector → pick Kubernetes → Step 1 save → Step 2 preview + download → Step 3 endpoint
    snippet (namespace input) → Step 4 guidance + Helix deep-link → Step 5 link.
  - Docker: selector → pick Docker → the existing flow is byte-for-byte unchanged.
  - Target chip re-choose resets to Step 1; `reset-onboarding` clears the target.

---

## 13. New / changed files (for the plan)

**New**
- `frontend/src/components/wizard/TargetSelector.tsx`
- `frontend/src/components/wizard/wizardTargets.ts` (+ `wizardTargets.test.ts`)
- `frontend/src/components/wizard/Step2K8s.tsx`, `Step3K8s.tsx`, `Step4K8s.tsx`
- `frontend/src/components/wizard/NamespaceRecipe.tsx`
- `frontend/src/components/K8sChartPanel.tsx`

**Changed**
- `frontend/src/components/wizard/Stepper.tsx` — `steps` prop.
- `frontend/src/components/wizard/Step1.tsx` — `target`-aware primary button.
- `frontend/src/components/wizard/Step2.tsx` — use `<NamespaceRecipe>` (extract the inline block).
- `frontend/src/components/K8sChartModal.tsx` — wrap `<K8sChartPanel>`.
- `frontend/src/App.tsx` — `target` state, selector gate, render branches, Docker-effect gating,
  target chip, reset clears target, Step-1 commit branch.
- `README.md` — short note on the branched onboarding (K8s as a first-class path).

---

## 14. Known gaps / deferred (honest)

- **Live verify for K8s** (paste reachable URL / port-forward probe) — deferred; Step 4 is guidance.
- **OTel Operator / auto-instrumentation** (brief 04) — "coming soon" affordance only.
- **OpenShift / restricted-PSA** specifics and the **viewer root-image** caveat — short inline note +
  README link; manifests unchanged (Phase 1 §8 still governs).
- **Bare-metal / systemd** target and the **raw-vs-Operator** K8s sub-flavor — selector/grid seam
  designed, not built (YAGNI).
- **In-cluster control plane** (Phase 2) — unchanged horizon; the generate-only Step 2 is the UX it
  later upgrades to "apply directly."

---

## 15. How this feeds future phases

- The **target model + card-grid selector** is the seam for bare-metal/systemd and the K8s
  Operator sub-flavor — new cards/sub-choices slot in without restructuring the wizard.
- The **`K8sChartPanel` + generate-only Step 2** is the UX wrapper Phase 2 upgrades from "download &
  `helm install`" to "apply to the cluster directly" once the configurator holds a kubeconfig /
  in-cluster ServiceAccount — the resource model (Phase 1's chart) is unchanged.
- Keeping the Docker flow untouched as the default branch means the spine can absorb a third target
  by adding one card + one set of `…<Target>` step bodies, not by re-plumbing the state machine.
