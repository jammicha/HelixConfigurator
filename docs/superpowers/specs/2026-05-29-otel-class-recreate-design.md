# OTEL_TRACE_ANOMALY class + policy recreate — design

**Date:** 2026-05-29
**Status:** ⛔ SUPERSEDED — the destructive recreate was rejected (user wants tenant teardown
done manually; BMC also blocks deleting a class with open events). Shipped instead as a
non-destructive fix to the existing `provision-class` button (resolve class UUID → PUT
attributes by id; exclude the built-in `priority` attr). See branch
`feat/situations-class-slot-update`. Kept for the discovery record.
**Builds on:** `2026-05-28-otel-situation-correlation-policy-design.md`, `2026-05-29-situations-rca-enrichment-design.md`

## Problem

The RCA-enrichment slice added 8 new first-class slots to the `OTEL_TRACE_ANOMALY`
event class (`probable_cause_service`, `probable_cause_operation`, `error_type`,
`error_message`, `code_location`, `anomaly_factor`, `affected_services`,
`component_count`) and rewrote the correlation policy's Situation title to lead with
reliably-populated slots.

But on a tenant where the class **already exists**, neither change lands:

- **Class:** the events-service update endpoint (`PUT …/events/classes/<name>`)
  rejects slot additions. By-name it 500s `Invalid UUID string: OTEL_TRACE_ANOMALY`
  (it parses the path as a UUID and ignores `?idType=name`). The live class is stuck
  at 13/21 expected slots; the 8 RCA slots show in BHOM "Unmapped Data" and made the
  policy Situation title render "[Invalid Slot]".
- **Policy:** `provision-correlation-policy` only POSTs; an existing policy returns
  `POLICY_ALREADY_EXIST` and its title is never updated.

Verified live on 2026-05-29: class `id 0376ea69-5af8-11f1-a087-5b3c44d5e1b3`, 13/21
slots, the 8 RCA slots missing.

## Goal

One user-triggered action that **recreates** both the class and the policy, so the
class picks up all 21 slots and the policy picks up the new title. Recreate (not
update) because update-class rejects slot additions and POST-only policy provisioning
never refreshes a title.

## Non-goals (YAGNI)

- No confirmation dialog / dry-run / preview (danger styling + explicit label is the guard).
- No generic "recreate any class" tool — this manages only the configurator-owned
  `OTEL_TRACE_ANOMALY` class + `HelixConfigurator-OTel-Trace-Anomaly` policy.
- No auto-heal / drift detection — strictly user-triggered.
- Old events are not backfilled — only events sent after recreate carry the new slots.

## Build level

Tenant-agnostic + pragmatic. Portable **by construction**: the flow keys on the
class/policy *names* (constants the configurator owns) plus per-tenant auth (IMS
bearer from `HELIX_API_KEY`) and base URL (`HELIX_ENDPOINT`) that existing code
already resolves generically. The class UUID is resolved by name at runtime — never
hardcoded — which is the only thing that would otherwise make it tenant-specific.

## Architecture

### New endpoint

`POST /api/situations/reprovision` in `backend/routes/situations.js`.

- No request body — operates on the class/policy name constants.
- Same auth/host pattern as the other three handlers: `getHelixBearerToken` →
  `bmcHeaders(bearer)` → `resolveEventsBaseUrl()`.
- Returns a structured per-step trail so the UI can render exactly what happened:
  `{ ok: boolean, steps: [{ step, action, status, ok, soft, upstream }] }`.

### Orchestration (ordered, server-side)

The four operations are order-dependent: the policy selector references the class, so
the policy must be deleted before the class, and the class recreated before the policy.

1. **Find + delete policy.** Policies are addressable only by internal id (live
   discovery: name-addressing 400s `"Invalid id format"`; the collection has no GET).
   `POST {base}/events-service/api/v1.0/event_policies/search` body `{}` →
   `{policies:[{id,name,…}]}`; match by name; `DELETE …/event_policies/{id}`. Policy
   absent (our policy does not currently exist on this tenant) → skip to create.
2. **Resolve class UUID** —
   `GET {base}/events-service/api/v1.0/events/classes/OTEL_TRACE_ANOMALY?idType=name`
   → `.eventClass.id`. Class not found → skip step 3, proceed to create (so this
   endpoint also serves clean first-time provisioning).
3. **Delete class** by UUID —
   `DELETE {base}/events-service/api/v1.0/events/classes/{uuid}`. UUID is the default
   idType, sidestepping the `Invalid UUID string` bug. 404 / "not found" →
   soft-success.
4. **POST class** — full `buildClassDefinition()` (all 21 slots). Existing pattern /
   payload.
5. **POST policy** — `buildCorrelationPolicy()` (new title). Existing pattern / payload.

### The one real unknown — delete semantics

Not yet verified live: whether BHOM allows deleting a class that **has events**, and
the exact policy-delete shape (by-name+idType vs by-id). Handling:

- Implement the best-guess URLs above; `validateStatus: () => true` everywhere.
- Read-only discovery during implementation: `GET` the policy by name to confirm it
  exists and capture its `id` as a fallback delete key if name+idType is rejected.
- The actual deletes run **behind the endpoint the user clicks** — never ad-hoc curl.
- If class-delete is **blocked by "has events"**, surface the upstream message verbatim
  and **STOP before the create steps** (otherwise POST-class would return a misleading
  "already exists"). Adapt from what the live response reveals (e.g. a force param, or
  deleting events first).

### Error / partial-failure semantics

- **Soft-success** (continue): a delete returns 404 / body matches
  `not found` / `does not exist` / `no policy` → treat as already-gone.
- **Hard failure** (stop): a delete fails for a real reason (class-has-events block,
  auth, 5xx without an already-gone signal) → record the step, stop before creates,
  return `ok:false` + the step trail with HTTP 502 (matches existing handlers).
- If **POST-class** returns "already exists," a delete silently no-op'd → surface as a
  warning in that step rather than a hard failure.
- Full success → HTTP 200 `{ ok:true, steps }`.

## Components & isolation

### Pure, unit-tested (in `backend/routes/situations-payloads.js`)

Mirrors the codebase convention — pure payload/decision logic lives in
`situations-payloads.js` and is unit-tested; network glue lives in `situations.js`
and is verified live.

- `classifyDeleteResponse({ status, body })` → `'deleted' | 'already-gone' | 'failed'`.
  The soft-success matrix. Unit-tested: 200/204 → deleted; 404 → already-gone; body
  containing "not found"/"does not exist" → already-gone; 500 with "has events"/other
  → failed.
- `buildClassDeleteUrl(base, uuid)` and `buildPolicyDeleteUrl(base, policyName)` — URL
  builders. Trivial but keeps `situations.js` declarative and pins the `?idType=name`
  / by-UUID shapes in a tested spot.
- (Optional, low-risk) factor the existing inline "already exists" check in
  `provision-class` into a shared `classifyCreateResponse` so the create steps and the
  existing handler share one tested classifier. Only if it doesn't perturb the passing
  legacy tests.

### Network glue (in `backend/routes/situations.js`)

`reprovision` handler wires the five steps, delegating every decision to the tested
classifiers above. Follows the existing defensive pattern (`validateStatus: () => true`,
surface upstream verbatim).

### UI (in `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx`)

A third control in the "AIOps Provisioning" section, visually separated and
**danger-styled** (red border/text), below the two existing provision buttons:

- Button: **"Recreate class + policy"**.
- Caption: *"Destructive: deletes & rebuilds the OTEL_TRACE_ANOMALY class (drops its
  events) and the correlation policy — registers all RCA slots and the latest policy
  title."*
- Reuses the existing `provision()` state helper (running / error / message). On
  completion, render a short per-step summary from the returned `steps[]`.
- No confirm dialog (per build-level choice) — the danger styling + explicit label is
  the guard.

## Testing

- **Unit (vitest, `backend/__tests__/situations-payloads.test.mjs`):**
  `classifyDeleteResponse` matrix; `buildClassDeleteUrl` / `buildPolicyDeleteUrl`
  shapes; (if added) `classifyCreateResponse`. All existing 159 tests stay green.
- **Live verification (after `docker compose up -d --build helix-configurator`):**
  1. User clicks "Recreate class + policy".
  2. Re-run the read-only slot probe → expect **21/21 slots, 0 missing**.
  3. `GET` policy by name → confirm new title.
  4. Send a **fresh** errored trace (new trace_id; dedup is on `helix_trace_id`) →
     convert-trace → confirm in BHOM the 8 slots are first-class fields and the
     Situation title names the cause.

## Risks

- **Delete API guesswork:** mitigated by defensive handling + the policy-id fallback +
  surfacing upstream verbatim; the live click is the moment of truth and reports
  precisely what happened.
- **Class-has-events may block delete:** handled by stop-and-surface; if hit, we learn
  the real constraint and adapt (force param / delete-events-first) in a follow-up.
- **Recreate drops any out-of-band custom slots** on the class — acceptable; the
  configurator owns this class.
