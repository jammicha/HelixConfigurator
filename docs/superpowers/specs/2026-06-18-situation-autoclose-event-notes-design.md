# Situation auto-close + event-notes slice — design

**Date:** 2026-06-18
**Branch:** `feat/situations-autoclose-event-notes`
**Status:** Design approved (pending written-spec review)

## Problem

The configurator turns OTel trace anomalies into rich BMC Helix AIOps **Events** and rolls
them into **Situations** (via an `OTEL_TRACE_ANOMALY` class + a CORRELATION policy). The
event-level RCA content is strong, but the **Situation page itself** is sparse: `Incident
ID: N/A`, `Change: N/A`, a one-line highlight, empty Notes, and a never-closed lifecycle.

A doc-research + adversarial-verification pass (2026-06-18) established which Situation-page
fields the configurator can actually influence (see memory
`project_situation_page_configurator_addressable_fields`). The verdict:

- **Out of reach** (tenant/ML/CMDB/ITSM zone; the OTel-derived key is 401'd there): the
  Change field / Changes tab (ITSM change requests only — emitting a `CHANGE` *event* does
  **not** populate it), Incident ID (ITSM/Proactive-Service-Resolution), Impacted-Service
  binding (CMDB modeling), the ML root-cause graph, Probability %, Predictions, HelixGPT
  summary.
- **Addressable now**, on the events-service Bearer-JWT lane we already use, non-destructive:
  Situation **title/severity** (already done), **Status → Closed (auto-close)**, and
  **event-level Notes** (the Logs & Notes / "Show Notes" drill-in).

This slice builds the two genuinely new addressable levers: **auto-close** and **event-notes**.

## Goals

1. Let the operator **resolve** a sent anomaly so the underlying member event(s) close,
   which lets the correlated Situation auto-close (member events closed + correlation/
   stability window elapsed → Situation closes; ~10–15 min, not instant).
2. Write **event-level notes** to the Logs & Notes tab: a short triage note at send time,
   and a resolution note at close time — a 2-entry audit trail visible from the Situation's
   event detail.
3. Make resolution **independent of the trace viewer and the browser** — it must work even
   after the trace has been evicted from the in-memory store, from a different browser, or
   after a container restart.

## Non-goals

- Populating Change / Changes tab, Incident ID, Impacted Service, Predictions, the ML causal
  graph, or the Situation's own (manual-only) Notes box. Confirmed out of reach; do not chase.
- Closing or mutating Situations directly, or any destructive tenant op (no deleting classes
  or policies). We only transition the **status of synthetic events the configurator itself
  authored**.
- A background poller / auto-detect-recovery mechanism. Resolution is operator-initiated.
- New persistent server-side state. Resolution re-discovers events from Helix (see below).

## Key design decision: stateless resolution via `source_identifier`

Resolution must **not** depend on remembering event ids in `localStorage` or on the trace
still being in the viewer (the live viewer evicts traces at `TRACE_CAP`; `localStorage` is
per-browser; a container restart wipes the store). Instead, resolution re-discovers the open
events from Helix, keyed on the deterministic `source_identifier` each sent event already
carries:

- single-event mode: `helix-otel-trace:<traceId>`
- multi-event mode (`HELIX_MULTI_EVENT=1`): `helix-otel-trace:<traceId>:<service>` per service

The events-service event **search** API supports filtering by `status` (e.g. `OPEN`) and by
slot values, and `source_identifier` is a first-class mandatory slot — so the backend can
query for the open `OTEL_TRACE_ANOMALY` events matching a trace (or all of them) and close
each one. Helix is the source of truth for "what's open"; we ask it rather than remember.

## Architecture

All new network calls reuse the existing `situations.js` auth/host machinery
(`getHelixBearerToken` → IMS-minted Bearer JWT, `bmcHeaders`, `resolveEventsBaseUrl`). Pure,
network-free logic lives in `situations-payloads.js` and is unit-tested in isolation, matching
the existing split.

### Backend — pure builders (`situations-payloads.js`)

- `buildEventSearchBody({ sourceIdentifierPrefix, all })` → the events-service search request
  body filtering `class = OTEL_TRACE_ANOMALY` AND `status = OPEN` (AND `source_identifier`
  match when not `all`). *Exact body shape verified live before finalize (see Risks).*
- `extractEventIds(searchResponse)` → the open event ids from a search response.
- `buildTriageNote(summary, cause, traceUrl)` → concise analyst-style note string
  (probable cause + recommended next step + trace deep-link). Distinct from `details`
  (which is the event body); the note is the Logs & Notes audit entry.
- `buildResolutionNote(summary)` → the "resolved via Helix Configurator…" note string.
- `buildEventUpdateBody({ status, note })` + `buildEventByIdUrl(base, id)` → the update/close
  payload + URL. *Exact verb/body (PATCH-by-id with status + note, vs bulk `{eventIds, slots}`,
  and the `skipAddNotes` toggle) verified live before finalize (see Risks).*

### Backend — routes (`situations.js`)

- **`convert-trace` (modified):** after a successful event POST, best-effort attach the triage
  note to the created event(s) via the update op. The note write must **never** fail the send
  (wrap in try/catch; report `noteWritten: true|false` in the response). The response also
  reports how many events were created (informational; resolution does not depend on it).
- **`POST /api/situations/close-events` (new):** body `{ traceId }` or `{ all: true }`.
  1. Mint/cache Bearer (existing helper).
  2. Search events-service for OPEN `OTEL_TRACE_ANOMALY` events (matched by
     `source_identifier` prefix, or all).
  3. For each id, update to `status: CLOSED` with the resolution note.
  4. Return per-id results. **Already-closed / no-match is a soft success** (nothing to do is
     fine). Surface upstream errors verbatim like the other routes.
- **`GET /api/situations/open-events` (new):** returns the open `OTEL_TRACE_ANOMALY` events
  (id, service, msg, severity, created time, source_identifier) for the settings-drawer
  panel. Read-only.

### Frontend

- **"Sent events" panel — `HelixConnectionSettingsDrawer.tsx` (core surface):** alongside the
  existing Provision buttons, a section that loads `GET open-events` and lists each open
  configurator event with a **Close** button (→ `close-events { traceId }` derived from its
  `source_identifier`) plus a **Close all** action (→ `close-events { all: true }`). This is
  the durable, viewer-independent surface that answers "what if the viewer didn't retain it."
- **Resolve button — `TraceDetailDrawer.tsx` (convenience):** once a trace has been sent, show
  a **Resolve** button that calls `close-events { traceId }`. No `localStorage` event-ids
  needed — `traceId` is enough. Reuses the existing attempt-logging UI affordances.

## Data flow

```
Send:    Trace drawer → POST convert-trace
           → events-service POST /events (OTEL_TRACE_ANOMALY, source_identifier=helix-otel-trace:<traceId>[:svc])
           → best-effort update op: attach triage note to created event(s)
Resolve: Settings panel / Trace drawer → POST close-events {traceId|all}
           → events-service search: class=OTEL_TRACE_ANOMALY, status=OPEN [, source_identifier~prefix]
           → for each id: update op status=CLOSED + resolution note
           → member events closed → correlation ALARM closes (~10 min) → Situation auto-closes (~15 min window)
List:    Settings panel → GET open-events → events-service search (status=OPEN) → render
```

## Error handling & idempotency

- Reuse existing 412 (no API key / no endpoint) and 502 (auth/upstream) patterns from the
  other situations routes.
- `close-events`: closing an already-closed event (BMC may 400) is a soft success; zero
  matches is a soft success (`{ ok: true, closed: 0 }`).
- Triage note on send is strictly best-effort and never blocks or fails the send.
- Auth: same cached IMS Bearer JWT; same `Accept: application/json` requirement.

## Non-destructive guarantee

Every write targets only events whose `class = OTEL_TRACE_ANOMALY` AND
`source_identifier` begins with `helix-otel-trace:` — i.e. events the configurator itself
created. No class/policy deletion, no direct Situation mutation, no customer-data writes. This
sits inside the established "non-destructive event sends + idempotent provision" allowance
(memory `feedback_manual_tenant_destructive_ops`).

## Testing

- **TDD on the pure builders** (`buildEventSearchBody`, `extractEventIds`, `buildTriageNote`,
  `buildResolutionNote`, `buildEventUpdateBody`, `buildEventByIdUrl`) — unit-tested in
  isolation like the rest of `situations-payloads.js`.
- **Route tests** for `close-events` / `open-events` mirroring the existing situations route
  tests (mock axios; assert auth gating, search→close sequencing, soft-success on
  already-closed/zero-match, best-effort note on send).
- **Legacy convert-trace tests must still pass** — the triage-note and response additions are
  additive; the no-spans event shape is unchanged.

## Risks / verify-live-before-finalize

1. **Events search endpoint shape** — exact path/body to filter `class + status + source_identifier`.
   Verify against a live tenant call; the pure builder isolates it to a one-spot change.
2. **Update/close op shape** — PATCH-by-id vs bulk `{eventIds, slots}`; the `skipAddNotes`
   toggle (omit so a note IS recorded). Verify live, same as the correlation-policy schema was.
3. **ML-Situation close timing** — docs confirm the *policy*-ALARM closes when member events
   close; they do **not** explicitly promise a *pure-ML* Situation resolves on member-event
   close. Frame the UX as "closes the anomaly event(s) and lets the correlated Situation
   resolve," and verify the end-to-end close on `demotenant-neodev4`.

## Out-of-scope follow-ups (not this slice)

- Optional time-based "Closing events automatically" enrichment policy as a provision button.
- Tags/Category on events; Similar-Situations pre-seeding job.
