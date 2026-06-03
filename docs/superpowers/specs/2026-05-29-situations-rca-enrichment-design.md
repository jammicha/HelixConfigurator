# Situations RCA-Enrichment — Design Spec

**Date:** 2026-05-29
**Status:** Approved (design), pending spec review
**Scope:** one implementation slice (the first of several from
`docs/situations-gartner-mapping.md`)

## Problem

The configurator emits one `OTEL_TRACE_ANOMALY` event per anomalous trace, and a
correlation policy clusters ≥3 of them (same `service_name` + `service_namespace`
within 30s) into a generic CRITICAL / PRIORITY_2 Situation titled "OTel trace
anomaly cluster on <service>." The resulting Situation **names no root cause,
links nowhere, and has flat severity** — so it can't feed the Deep-RCA / agentic
/ blast-radius experiences the BMC demo is built around (see the mapping doc,
elements 4–9).

## Goal

Enrich each anomaly event (and the Situation title) so it reads like an incident:
**names its probable cause, links to its trace, and carries a dynamic priority +
blast-radius hints** — using only data already returned by
`otelStore.getTrace(traceId)`. No new telemetry, no tenant-side dependency, no
network calls added to the pure builder module.

End-state example (event `msg`):
> `OTel anomaly: payment/PaymentClient.charge — NullPointerException (12.3× p95), 3 services affected`

with `class_slots.trace_url`, `class_slots.priority`, `class_slots.error_type`,
etc., and an "Open trace: <url>" line in `details`.

## Verified foundation (read this session, not assumed)

- **Test runner:** vitest. `cd backend && npm test` (`vitest run`). 10 tests in
  `backend/__tests__/situations-payloads.test.mjs` pass on `main` today.
- **Builder module:** `backend/routes/situations-payloads.js` — "pure builders,
  no network, no `process.env`; all inputs passed in." Exports:
  `OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy,
  splitApiKey`.
- **Current builder signature:**
  `buildAnomalyEventPayload({ summary, p95Ms, businessServiceKey, xSource })`
  → returns a one-element array `[event]`. Severity: error→CRITICAL,
  duration>2×p95→MAJOR, else MINOR.
- **Trace data:** `otelStore.getTrace(id)` → `{ summary, spans }`.
  - `summary`: `{ trace_id, service_name, service_namespace, root_operation,
    start_time_ns, end_time_ns, duration_ms, span_count, has_error, received_at }`.
  - `spans[]` (already parsed — NOT JSON strings):
    `{ spanId, traceId, parentSpanId, serviceName, name, kind, startTimeNs,
    endTimeNs, durationMs, statusCode, statusMessage, attributes, events }`.
    - `attributes`: flat object, e.g. `{ 'code.filepath': '…', 'code.function':
      '…', 'code.lineno': 42, 'http.route': '…' }`.
    - `events`: array of `{ name, timeUnixNano, attributes }`; an exception event
      is `name === 'exception'` with `attributes['exception.type' | '.message' |
      '.stacktrace']`. (Mirrors `buildErrorRecords` in otelStore.js:153.)
    - Note: the mapped span has **no** `serviceNamespace`; the trace namespace
      comes from `summary.service_namespace`.
- **Deep-link contract (port, don't invent):** frontend
  `buildHelixTraceUrl` (`frontend/src/components/otel-data/utils.ts:149`) builds:
  `${endpoint}/dashboards/d/OTelTraceDetails/otel-trace-details?` with params
  `orgId=<tenantId>`, `var-BusinessService=<source>`,
  `var-OTelNamespace=<namespace || source>`, `var-OTelService=<serviceName>`,
  `var-TraceTimestamp=<formatHelixTimestamp(timeNs)>`,
  `var-TraceId=<traceId.toUpperCase()>`; then `.replace(/\+/g, '%20')`.
  Returns null unless `endpoint`, `tenantId`, `traceId` present and the endpoint
  isn't the install placeholder `your-tenant.onbmc.com`.
  - `formatHelixTimestamp(ns)` (utils.ts:96): `''` if falsy; else UTC
    `YYYY-MM-DD HH:MM:SS.mmm000000` from `new Date(ns/1e6)`.
- **Route:** `backend/routes/situations.js` `/api/situations/convert-trace`
  already calls `otelStore.getTrace(traceId.toLowerCase())` (has `trace.summary`
  AND `trace.spans` in scope), resolves `baseUrl` via `resolveEventsBaseUrl()`,
  and has `apiKey` (→ `splitApiKey(apiKey).tenantId`).

## Architecture

All enrichment logic is **pure functions** added to `situations-payloads.js`,
unit-tested in isolation (consistent with the module's existing contract). The
route change is a thin wiring step: pass the already-fetched `spans`, `baseUrl`,
and `tenantId` into the builder. No new module, no otelStore change.

```
getTrace(id) ──▶ { summary, spans }
                      │
   route passes summary, p95Ms, businessServiceKey, xSource,
                spans, baseUrl, tenantId
                      ▼
   buildAnomalyEventPayload(...)
     ├─ deriveProbableCause(spans)        → cause slots + msg
     ├─ blastRadius(spans)                → affected_services, component_count
     ├─ anomalyFactor(duration, p95)      → anomaly_factor
     ├─ priorityForTrace({...})           → priority (P1–P5)
     └─ buildHelixTraceUrlFromSummary(...)→ trace_url + "Open trace:" line
```

## New pure helpers (in `situations-payloads.js`)

1. **`deriveProbableCause(spans)` → object.** Error span = `statusCode === 2` OR
   has an `exception` event. Originating span = among error spans, the one with
   the latest `startTimeNs` (most downstream); prefer a span that has an
   `exception` event over one that only has error status. Returns:
   - `probable_cause_service` (span.serviceName), `probable_cause_operation`
     (span.name)
   - `error_type` (exception.type; `''` if only status-error),
     `error_message` (exception.message, else statusMessage; trimmed to ≤200 chars)
   - `code_location` (`file:function:lineno` from `code.filepath`/`code.function`/
     `code.lineno` when present, else `''`)
   - No error spans → every field `''` (latency-only anomaly).
   - Guards: missing/empty `spans`, missing `events`/`attributes`.

2. **`blastRadius(spans)` → `{ affected_services, component_count }`.**
   Distinct non-empty `serviceName`s. `component_count` = distinct count (number).
   `affected_services` = comma-joined, capped at 5 names / 120 chars (append `…`
   when truncated).

3. **`anomalyFactor(durationMs, p95Ms)` → number | null.** `round1(duration /
   p95)` when `p95Ms` is a number > 0; else `null`.

4. **`priorityForTrace({ hasError, anomalyFactor, blastCount })` → string.**
   `PRIORITY_1` if hasError && (factor ≥ 4 || blastCount ≥ 3); `PRIORITY_2` if
   hasError; `PRIORITY_3` if factor ≥ 4; `PRIORITY_4` if factor ≥ 2; else
   `PRIORITY_5`. (`anomalyFactor` may be null → treated as 0.)

5. **`buildHelixTraceUrlFromSummary({ baseUrl, tenantId, source, summary })` →
   string.** Port of the frontend contract above, returning `''` (not null —
   backend slots are strings) when `baseUrl`/`tenantId`/`summary.trace_id` are
   missing or `baseUrl` is the `your-tenant.onbmc.com` placeholder. Uses
   `summary.service_namespace || source` for `var-OTelNamespace`,
   `summary.service_name` for `var-OTelService`, `summary.start_time_ns` for the
   timestamp, `summary.trace_id.toUpperCase()` for `var-TraceId`. Spaces → `%20`.
   A private `formatHelixTimestamp(ns)` helper ports utils.ts:96 exactly.

## Wiring changes

**`buildAnomalyEventPayload`** gains optional `spans`, `baseUrl`, `tenantId` in
its options object. Behavior:
- When `spans` is a non-empty array: compute cause / blast / factor / priority /
  url; add `class_slots` **only for non-empty values**:
  `probable_cause_service, probable_cause_operation, error_type, error_message,
  code_location, anomaly_factor, affected_services, component_count, trace_url,
  priority`; add top-level `priority`; rewrite `msg` to name the cause (error
  variant names `error_type`+operation; latency variant names operation+factor);
  append a cause block and `Open trace: <url>` line to `details` (url line only
  when non-empty).
- When `spans` is absent/empty: **output is byte-for-byte identical to today**
  (so all 10 existing tests stay green without modification).

**`buildClassDefinition`** registers the new slots as STRING attributes
(`probable_cause_service, probable_cause_operation, error_type, error_message,
code_location, anomaly_factor, affected_services, component_count, trace_url,
priority`). `helix_trace_id` dup_detect/mandatory facets untouched. `ADDED_SLOTS`
is left as-is (it documents the older service_name/service_namespace patch and is
asserted exactly in a test).

**`buildCorrelationPolicy`** — `newEvent.msg` interpolates the new slots, e.g.
`'OTel anomaly on %service_name%/%service_namespace%: %error_type% in
%probable_cause_operation% (%anomaly_factor%× p95) — investigate correlated
traces.'` **`selectorCriteriaList` (no parens) and every condition's
`conditionBracket: ''` / `endBracket: ''` are NOT touched** — these are the
live-tenant-validated quirks. (Takes effect only after the user re-runs
`POST /api/situations/provision-correlation-policy`.)

**`backend/routes/situations.js`** — in `/convert-trace`, pass the already-fetched
`trace.spans`, `baseUrl`, and `tenantId` (from `splitApiKey(apiKey).tenantId`)
into `buildAnomalyEventPayload`. No other route logic changes.

## Backward compatibility

- The 10 existing tests call `buildAnomalyEventPayload` **without** `spans`, so
  they exercise the unchanged path and must continue to pass untouched. One
  existing test even asserts `class_slots` has no `trace_url` in the no-spans
  case — that invariant holds.
- No otelStore / schema / migration changes. No change to auth, dedup
  (`helix_trace_id` stays the dup slot), or the events/classes/policies HTTP
  flow.
- Re-provisioning the class/policy is the user's explicit action; nothing
  auto-pushes to the tenant.

## Testing strategy (vitest, `cd backend && npm test`)

New tests in `backend/__tests__/situations-payloads.test.mjs` (vitest
`describe/it/expect`, matching the file's style), using a small `span()` factory:
- `deriveProbableCause`: exception event → type/message/operation/service/
  code_location; status-error only → falls back to statusMessage, empty type;
  most-downstream selection; no-error → all empty.
- `blastRadius`: distinct services, component_count, cap/truncation.
- `anomalyFactor`: ratio rounding; null when no p95.
- `priorityForTrace`: each P1–P5 tier.
- `buildHelixTraceUrlFromSummary`: correct dashboard URL, `var-TraceId`
  uppercased, namespace fallback to source, `%20` not `+`, `''` for
  missing/placeholder baseUrl.
- `buildAnomalyEventPayload` with `spans`: slots populated + `msg` names cause +
  `details` has "Open trace:"; latency-only (no error spans) sets `anomaly_factor`
  but no `error_type`; **no-spans path byte-identical to current output**.
- `buildClassDefinition`: includes the new slot names.
- `buildCorrelationPolicy`: `newEvent.msg` contains `%error_type%` /
  `%probable_cause_operation%`; selector + brackets unchanged.

## Out of scope (explicit — follow-up slices)

Change/deploy correlation (E8), transaction-path grouping (E6/E9), fingerprint
dedup (E4), auto-close / CLEAR events (E9), CI/affected-host model linkage. These
are listed in `docs/situations-gartner-mapping.md` as items 4–6.

## Rollback

`git checkout -- backend/routes/situations-payloads.js
backend/routes/situations.js backend/__tests__/situations-payloads.test.mjs`.
No data migration; tenant state unchanged until the user re-provisions.
