# Remove the synthetic "Verify gateway → Helix" requirement from Step 4

**Date:** 2026-06-02
**Status:** Approved (design) — pending implementation plan

## Problem

Onboarding Step 4 ("Verify") forces the user to fire a **synthetic trace into Helix**
before they can continue. The "Verify gateway → Helix" button injects an OTLP span
through the gateway and polls for it to reach Helix; the "Next: Link your service"
button is hard-gated on that result (`disabled={!traceVerifyResult}`), so the user
literally cannot leave onboarding without an artificial trace landing in their tenant.

We don't want to force synthetic ingestion as a gate. Real telemetry observation (and
the dashboard's existing, non-synthetic "Re-verify telemetry") is the preferred signal.

## Goals

- Remove the synthetic "Verify gateway → Helix" button from Step 4.
- Remove the requirement: "Next: Link your service" is **always enabled**; onboarding
  never blocks on a synthetic trace.
- Keep Step 4 useful as a **read-only** view of whether real telemetry is flowing.
- Preserve the "is my API key valid against Helix?" capability — it already lives in
  **Step 1's "Test connection"** button, so no new UI is needed.
- Full cleanup: no orphaned handlers, state, or backend routes left behind.

## Non-goals

- Touching the Gateway Dashboard "Re-verify telemetry" button (it stays exactly as is —
  it already observes real flow, no synthetic injection).
- Re-homing or rebuilding the API-key probe (Step 1 "Test connection" already covers it).
- Preserving the "FAKE- placeholder key" heads-up (accepted drop — see below).

## Decisions (confirmed with user)

1. **Step 4 gate → none.** "Next" always enabled. Step 4 keeps its read-only live verdict.
2. **Cleanup scope → full.** Remove the button, gate, orphaned frontend handlers/state,
   AND the dead backend route.
3. **API-key probe → keep the capability in Step 1.** Step 1's "Test connection" already
   probes Helix via `test-connection → runOtlpProbe`, testing the *typed* endpoint+key
   before save (strictly better than the Step 4 probe, which tested saved `.env` values).
   So we delete the Step 4 probe and its now-orphaned `apikey-probe` route.
4. **FAKE- placeholder-key warning → accept the drop.** It only rendered inside the
   synthetic success banner; placeholder keys are an intentional demo affordance.

## What the user already has after this change

| Question | Where it's answered now |
| --- | --- |
| Is my API key/endpoint valid against Helix? | **Step 1 "Test connection"** (`test-connection` → `runOtlpProbe`) |
| Is real telemetry reaching the gateway? | **Step 4 live counters + verdict** (unchanged, read-only) |
| Is telemetry reaching Helix, post-launch? | **Dashboard "Re-verify telemetry"** + Diagnostic Health Check |

## Changes

### Frontend — `frontend/src/components/wizard/Step4.tsx`

- Remove the amber **"Verify gateway → Helix"** button (`onVerifyTelemetry`).
- Remove the entire **"Gateway → Helix"** synthetic-result section: the `exported`
  success banner, all failure banners (`rejected` / `queued_customer` / `queued_gateway`
  / `pending` / `error`), the "Run again" link, the "Not verified yet" empty state.
- Remove the **"Test API key against Helix"** probe UI: the `renderApiKeyProbe` and
  `renderTraceBanner` helpers and their supporting locals (`probeIsSuccess`,
  `probeNeedsStep1Fix`).
- Remove the FAKE- placeholder-key heads-up (lived inside the success banner).
- **Ungate "Next: Link your service":** drop `disabled={!traceVerifyResult}` and the
  gated `title`; always enabled, plain "Open the gateway dashboard" title.
- Drop now-unused props from the `Props` type and the component signature:
  `onVerifyTelemetry`, `verifyingTrace`, `traceVerifyResult`, `onProbeApiKey`,
  `apiKeyProbe`, `probingApiKey`, `envVars` (and the `TraceVerifyResult` / `ApiKeyProbe`
  local types).
- **Resulting Step 4 layout:** verdict banner → collector/bridge/gateway warnings →
  live counters (real flow) → k8s enrichment note → **Back / Next** → after-launch tips.
  Two buttons, never blocks.

### Frontend — `frontend/src/components/wizard/verifyVerdict.ts` (+ `verifyVerdict.test.ts`)

- Drop `syntheticOk`, `syntheticFailed`, `syntheticRemediation` from `VerifyInputs`.
- Remove the `else if (i.syntheticFailed)` branch ("Gateway can't reach Helix", step 1) —
  that signal now lives at Step 1's Test connection.
- Simplify `else if (i.flowing || i.syntheticOk)` → `else if (i.flowing)`. The
  `!i.flowing` sub-branches inside it (`clearedOnly` note, "The gateway can reach Helix.
  Send some app telemetry…") become dead and are removed; detail collapses to the
  `flowing && hasErrors` "catching up" copy vs. the plain "reaching the gateway and on
  to Helix" copy.
- Idle branch detail: drop "…or run the Gateway → Helix check below." (no such button now).
- `verifyVerdict.test.ts`: remove the two synthetic-specific cases ("not flowing +
  synthetic ok + cleared", "synthetic failed → bad, jump to Step 1"); remove the
  `syntheticOk`/`syntheticFailed` keys from the `base` fixture. Keep all real-flow,
  error-panel, gateway-not-running, and idle cases.

### Frontend — `frontend/src/App.tsx`

- Remove `handleVerifyTelemetry` and `handleProbeApiKey`.
- Remove state: `verifyingTrace`, `traceVerifyResult`, `apiKeyProbe`, `probingApiKey`,
  plus their resets (the `setTraceVerifyResult(null)` / `setApiKeyProbe(null)` calls in
  the onboarding-reset and config-change blocks).
- Remove the six removed props from the `<Step4 … />` element.
- **Keep `receiverBaseline`** — seeded independently when Step 4 opens
  (`App.tsx:403`, `if (!baselineSet) setReceiverBaseline(data)`); only the post-verify
  re-baseline (inside the deleted handler) goes away. There's no synthetic trace to
  subtract from the live counters anymore, so this is correct.
- **Keep the `'verify'` timeline event type** — still emitted by the diagnostic-session
  path (`App.tsx:1098`). Only the "Synthetic trace reached Helix" emitter is removed.

### Backend — `backend/routes/diagnostics.js`

- Remove the `POST /api/diagnostics/inject-trace-verify` handler (its only caller was the
  deleted Step 4 handler).
- Remove the now-orphaned `POST /api/diagnostics/apikey-probe` handler (its only caller
  was the deleted Step 4 probe).
- **Keep, do not touch (shared):**
  - `DIAGNOSTIC_NAMESPACE` — still used by `POST /api/diagnostics/inject-trace`.
  - `runOtlpProbe` + `encodeOtlpProbeTracesPayload` + the `pb*` protobuf helpers + the
    `module.exports.runOtlpProbe` — still used by `POST /api/diagnostics/test-connection`
    (Step 1's "Test connection").
  - `fetchCounters`, `fetchHelixQueueSize`, `fetchCustomerCollectorCounters`,
    `checkExporterFailing` — used by `step3-verify`, `metrics/live`, etc.

## Risk / edge cases

- **Live counters baseline:** verified seeded at `App.tsx:403` independent of verify, so
  removing the post-verify re-baseline does not break the counters.
- **`'verify'` timeline type:** still has another emitter; timeline rendering untouched.
- **Gateway→Helix confidence in onboarding:** previously "proven" by the synthetic trace.
  After this change it's covered by (a) Step 1 Test connection proving the key/endpoint
  reach Helix, and (b) collector helix-bound export errors surfacing in Step 4's verdict.
  Accepted — matches the goal of not forcing synthetic ingestion.
- **Accepted minor regression:** the FAKE- placeholder-key heads-up is gone. A FAKE- key
  will read as "valid" in Step 1 Test connection (Helix 200s everything). Intentional per
  decision 4; can be revisited as a follow-up (port the warning to Step 1).

## Verification

- `verifyVerdict.test.ts` passes (updated).
- Frontend type-check / build clean (no dangling props or imports — `CheckCircle2`,
  `X`, `Loader2`, `ArrowRight` import usage re-checked after JSX removal).
- Backend starts; `grep` confirms no remaining references to the two removed routes.
- Manual: Step 4 renders with verdict + counters + Back/Next; "Next" is enabled with no
  verify run; Step 1 "Test connection" still works.

Per the "scale verification to the change" preference, this is a typed + unit-tested UI
removal — `tsc`/build + the updated unit test + a backend grep is sufficient; no full
e2e browser proof required.

## Out of scope / follow-ups

- Optional: port the FAKE- placeholder-key warning to Step 1 next to the key field.
- No changes to the Gateway Dashboard "Re-verify telemetry" flow.
