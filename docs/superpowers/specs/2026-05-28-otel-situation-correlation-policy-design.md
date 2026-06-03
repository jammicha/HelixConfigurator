# OTel Trace Anomalies → AIOps Situations — configurator-provisioned correlation policy

## Context

The configurator can already turn a trace into a well-formed AIOps **event**.
`backend/routes/situations.js` does two things today:

- `POST /api/situations/provision-class` registers a custom `OTEL_TRACE_ANOMALY`
  event class (child of `EVENT`) with first-class slots: `helix_trace_id`
  (dedup), `root_operation`, `duration_ms`, `p95_ms`, `span_count`,
  `has_error`, `service_id`, `business_service_key`, `x_source`.
- `POST /api/situations/convert-trace` builds an event from a stored trace —
  severity mapping (error→CRITICAL, outlier→MAJOR, else MINOR),
  `source_hostname = service_name`, a unique `source_identifier` per trace, and
  a clickable configurator trace link stuffed into the `details` string.

So the "blank Event Details / nothing to correlate on" problem from earlier
investigation is **already solved in code**. The remaining gap is downstream:

1. **Situation creation.** Events are not Situations. The code deliberately
   stops at sending events ("we don't (and shouldn't) create Situations
   directly"). Today a Situation forms only if ML correlation picks the event
   up via topology (probabilistic, needs the service model populated — see the
   X‑Source→business-service linking dependency) or a human hand-builds a
   correlation policy in BHOM. The configurator creates neither.
2. **Trace surfacing in the Situation.** The trace context rides along in
   `details` text + the `helix_trace_id` slot, but there is no clickable
   trace affordance on the Situation's secondary events.

Research confirmed BMC Helix Operations Management exposes an **Event Policy
REST API**, and correlation policies are simply policies of `type:
"CORRELATION"`, on the **same `events-service` base** the configurator already
calls. So the gap can be closed deterministically and configurator-owned.

## Intended outcome

From the Helix settings drawer a user clicks **Provision event class**, then
**Provision correlation policy**, and the configurator creates (idempotently)
a deterministic BHOM correlation policy that aggregates `OTEL_TRACE_ANOMALY`
events **per service** into a Situation. Each anomaly event also carries a
clickable `trace_url`, so the operator can jump from the Situation's secondary
events straight back into the configurator's trace view — prototyping the
26.2 Trace Analyzer experience without waiting for it.

## Decisions locked during brainstorm

- **Scope:** durable, configurator-owned capability (not a demo throwaway, not
  ML-correlation-only).
- **Mechanism:** the configurator provisions a BHOM correlation policy via the
  Event Policy REST API, mirroring the existing `provision-class` pattern.
- **Grouping:** by service — match incoming vs. open events on
  `service_name` (+ `service_namespace` to disambiguate same-named services).
  One Situation per misbehaving service. (Operation-level grouping considered
  and deferred; see Out of scope.)
- **Trace surfacing:** bundle a first-class `trace_url` slot into the event and
  reference it in the aggregated message — included in this work, not deferred.

---

## Architecture

### What already exists (do NOT rebuild)

- `resolveEventsBaseUrl()` — resolves the `events-service` host from
  `HELIX_EVENTS_ENDPOINT` / `HELIX_ENDPOINT`. Reuse verbatim.
- `provision-class` + `convert-trace` endpoints and their auth pattern
  (`Authorization: apiKey <HELIX_API_KEY>`). Extend, don't duplicate. Note:
  `provision-class` is **backend-only today** — the "Settings page button" in
  its code comment was never built; it's currently callable only via API.
- The `OTEL_TRACE_ANOMALY` class definition and its slot list.
- `TraceDetailDrawer` "Send to AIOps" flow (unchanged by this work).

### New: `provision-correlation-policy` endpoint

`POST /api/situations/provision-correlation-policy` (no body required).
Builds the correlation-policy payload (below) and upserts it on the tenant:

1. `GET` existing event policies; find one whose `name` matches our
   deterministic name `HelixConfigurator-OTel-Trace-Anomaly`.
2. If found → `PUT` (update in place). If not → `POST` (create).
3. Soft-success on a 409 / "already exists" body, exactly like `provision-class`.

Idempotent by design: re-running converges the tenant to the desired policy.

### Event enrichment: new always-present slots

The grouping slots must be present on **every** event, unconditionally. Today
`service_id` is only set when `BUSINESS_SERVICE_KEY` is configured, and
`service_name`/`service_namespace` are not first-class slots at all
(`service_name` only rides in `source_hostname`). So:

- Add slots to the `OTEL_TRACE_ANOMALY` class def: `service_name`,
  `service_namespace`, `trace_url` (all `STRING`).
- Populate them in `convert-trace`:
  - `service_name` ← `summary.service_name`
  - `service_namespace` ← `summary.service_namespace` (now available — the
    trace summary was denormalized to carry the root span's namespace).
  - `trace_url` ← the same `${APP_URL}/otel-data?selected=<traceId>` link
    already built for `details`, promoted to a slot.
- `provision-class` must be able to **add these slots to an already-registered
  class** (BMC allows adding — not renaming/retyping — slots). Today it only
  POSTs and soft-succeeds on "already exists", which will NOT add new slots to
  an existing class. Enhance it to update the class (add missing slots) when it
  already exists. Tenants that provisioned the older class re-run the button.

### Frontend: provisioning controls

There is **no provisioning UI today** — `provision-class` is backend-only, and
the only `/api/situations/*` call from the frontend is `convert-trace` in
`TraceDetailDrawer`. So this work adds the provisioning controls to the
existing **`HelixConnectionSettingsDrawer`** (where the Helix endpoint/API key
already live):

- A **"Provision event class"** button (new) → `POST /provision-class`.
- A **"Provision correlation policy"** button (new) → `POST /provision-correlation-policy`,
  sequenced after the class (the policy selects on `class equals
  'OTEL_TRACE_ANOMALY'`), with copy that says so.

Reuse the loading / sent / error inline-status pattern from `TraceDetailDrawer`'s
"Send to AIOps" button for both.

---

## Correlation policy payload

`POST {base}/events-service/api/v1.0/event_policies`

```json
{
  "name": "HelixConfigurator-OTel-Trace-Anomaly",
  "description": "Aggregates OTEL_TRACE_ANOMALY events per service into a Situation. Managed by Helix Configurator.",
  "types": ["CORRELATION"],
  "enabled": true,
  "executionOrder": 100,
  "selectorCriteriaList": [
    "( class equals 'OTEL_TRACE_ANOMALY' )"
  ],
  "configurations": [
    {
      "type": "CORRELATION",
      "configOrder": 1,
      "definition": {
        "type": "root",
        "label": "policy",
        "children": [
          {
            "type": "aggregate",
            "within": 15,
            "minCount": 3,
            "conditions": [
              { "slotName": "$NEW.service_name",      "slotOperator": "equals", "slotValue": "$OLD.service_name" },
              { "slotName": "$NEW.service_namespace", "slotOperator": "equals", "slotValue": "$OLD.service_namespace" }
            ],
            "newEvent": {
              "newEventClass": "ALARM",
              "severity": "MAJOR",
              "priority": "PRIORITY_3",
              "status": "OPEN",
              "msg": "OTel anomaly cluster on %service_name% (%service_namespace%) — %msg%"
            }
          }
        ]
      }
    }
  ]
}
```

Notes:
- `newEventClass` must NOT be `Anomaly`/`Prediction`/`Situation` (restricted as
  aggregate output) — `ALARM` is the safe choice; the aggregated ALARM is what
  surfaces as the Situation on the AIOps console.
- `within` 15 min ≈ 3 anomaly cycles; `minCount` 3 = events required to fire.
  Both are constants in the policy builder, easy to tune later.
- The aggregated `msg` headlines the service; each contributing anomaly event
  (with its `trace_url` and `helix_trace_id`) appears as a secondary event.

---

## Idempotency & auth (the de-risking work — do this FIRST)

Two unknowns must be validated against a real tenant before building the rest,
because they shape the endpoint:

1. **Auth scheme.** The Event Policy docs show `Authorization: Bearer <JWT>`,
   while the configurator's `events`/`classes` calls use `apiKey <HELIX_API_KEY>`.
   Plan: try `apiKey` first (consistent with the existing endpoints); if
   `/event_policies` rejects it, add a JWT exchange via Helix's access/auth
   endpoint and thread the token through. The endpoint must surface a clear
   error if auth fails rather than silently no-op.
2. **CRUD shape for upsert.** Confirm `GET /event_policies` (list) and
   `PUT /event_policies/{id}` (update) shapes for the idempotent
   match-by-name → update path. If list/update isn't available, fall back to
   POST + soft-success-on-conflict (loses true update, keeps idempotent create).

Also note BMC's caveat: creating a policy via API may require refreshing the
Event Policies page to settle execution order. `executionOrder: 100` keeps our
policy late and out of the way of hand-built tenant policies.

---

## Backend API surface

| Method + path | Purpose |
|---|---|
| `POST /api/situations/provision-class` (existing, **enhanced**) | Register OR update the `OTEL_TRACE_ANOMALY` class; now adds `service_name`, `service_namespace`, `trace_url` slots. |
| `POST /api/situations/convert-trace` (existing, **enhanced**) | Now also populates `service_name`, `service_namespace`, `trace_url` slots. |
| `POST /api/situations/provision-correlation-policy` (**new**) | Idempotently upsert the per-service correlation policy. |

All three: `412` when `HELIX_API_KEY` / events endpoint unset; upstream status
surfaced verbatim on failure; soft-success on already-exists.

---

## Files to create / modify

### Modify
- `backend/routes/situations.js` — add the policy builder + `provision-correlation-policy`
  handler; add the three slots to the class def; populate them in `convert-trace`;
  enhance `provision-class` to add slots to an existing class.
- `frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx` — add
  "Provision event class" (new) and "Provision correlation policy" (new)
  buttons + their fetch/status wiring. No provisioning UI exists today, so both
  are net-new (implementer to confirm this drawer is the right home).

### Create
- `backend/__tests__/situations-policy.test.mjs` — unit-test the pure
  policy-payload builder and the convert-trace slot population.

### Reuse (do NOT duplicate)
- `resolveEventsBaseUrl()`, the `apiKey` auth header pattern, the
  status/soft-success handling from `provision-class`.

---

## Error handling

- Missing `HELIX_API_KEY` or events endpoint → `412` with an actionable message
  pointing at the Settings page (matches existing endpoints).
- Upstream non-2xx → `502` with `upstream` body echoed verbatim.
- Auth rejection on `/event_policies` → distinct, clear error (don't mask as
  generic 502) so the JWT-vs-apiKey path is diagnosable.
- Policy already exists (no list/update available) → soft-success.

## Testing plan

- **Backend unit (pure):** policy-payload builder — assert `types: ["CORRELATION"]`,
  selector on `OTEL_TRACE_ANOMALY`, both `$NEW/$OLD` service conditions present,
  `within`/`minCount` values, and `newEventClass` is not a restricted class.
- **Backend unit:** `convert-trace` payload now includes `service_name`,
  `service_namespace`, `trace_url` slots (mock `otelStore.getTrace`).
- **Manual smoke (once auth validated):** provision class → provision policy →
  send a burst of ≥3 anomalies for one service in <15 min → confirm a Situation
  forms, secondary events carry `trace_url`, and the link round-trips to the
  trace view.

---

## Out of scope (deferred)

- **Operation-level grouping** (a second, narrower policy). Service-level first;
  revisit if demos want per-operation Situations.
- **De-provisioning / policy deletion** from the configurator.
- **Replacing the 26.2 Trace Analyzer** — the `trace_url` slot is an interim
  cross-launch, not native in-Situation span analysis.
- **ML-correlation tuning** — orthogonal; the deterministic policy coexists with
  whatever ML correlation does.

---

## Open risks to validate first

1. `apiKey` vs `Bearer JWT` on `/event_policies` (de-risk before building UI).
2. `GET`/`PUT` availability for the idempotent upsert.
3. Whether `provision-class` can add slots to an existing class via the API, or
   whether tenants must drop/recreate the class (affects upgrade story).
4. `minCount` exact semantics (minimum-to-fire assumed = 3).

## Sources

- [Event policy management endpoints in the REST API — BMC (BHOM 23.3)](https://docs.bmc.com/xwiki/bin/view/IT-Operations-Management/Operations-Management/BMC-Helix-Operations-Management/bhom233/Policy-event-data-and-metric-data-management-endpoints-in-the-REST-API/Event-policy-management-endpoints-in-the-REST-API/)
- [Situation configuration management endpoints in the REST API — BMC Helix AIOps 26.1](https://docs.bmc.com/xwiki/bin/view/IT-Operations-Management/Operations-Management/BMC-Helix-AIOps/aiops261/Managing-services-and-situations-by-using-REST-APIs/Situation-configuration-management-endpoints-in-the-REST-API/)
- [Creating and enabling event policies — BMC (BHOM 23.3)](https://docs.bmc.com/docs/helixoperationsmanagement/233/en/creating-and-enabling-event-policies-1222654424.html)
