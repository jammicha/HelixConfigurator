# Failing operation on the trace list — design

**Date:** 2026-05-31
**Status:** Approved (brainstorm) → ready for implementation plan
**Builds on:** `2026-05-30-synthetic-error-span-rca-enrichment-design.md` (the exception/`code.*`
enrichment that makes the originating error span identifiable) and the existing
`deriveProbableCause` origin selection in `backend/routes/situations-payloads.js`.

## Problem

The Traces list ([TracesTab.tsx](../../../frontend/src/components/otel-data/TracesTab.tsx))
shows, per trace, the **root** span's service + operation plus error/DB/log count badges. A row
reads "`mysql`, 4 errors, root op `Request Ride`" — it tells you *where* a trace failed and *that*
it failed, but never *what* downstream operation actually errored (`SELECT drivers`, `POST
/v1/charges`, …). To learn that today you must open each trace's detail drawer. Every serious
tracing UI (Jaeger, Datadog, Tempo) surfaces the failing/leaf operation in the result list itself.

The data already exists locally: spans live in SQLite with `name` + `status_code`
([otelStore.js:263](../../../backend/otelStore.js:263)) and error spans are also in `span_errors`.
The list query just doesn't surface it. No remote Helix call and no per-row detail fetch (N+1) are
involved.

## Goal

Surface the **failing operation** as a muted subline under the existing **Service** cell of the
trace list, for error traces only, in the unfiltered (trace-level) view:

```
STATUS   SERVICE                      ROOT OPERATION
Error    ⛃ mysql   △4 ▣1 ▣2          Request Ride
           └ SELECT drivers            ← failing op (origin error span)
```

## Selection rule — what "the failing operation" is

Mirror `deriveProbableCause` exactly so the list, the detail drawer, and the BHOM Situation all
name the **same** span:

1. Error spans = spans with `status_code >= 2` **or** carrying an `exception` event.
2. Pool = error spans that carry an `exception` event, if any exist; otherwise all error spans.
3. **Origin = the latest-started span in the pool** (`MAX(start_time_ns)`), tie-broken by `span_id`
   for determinism.
4. `failing_operation` = origin span's `name`; `failing_service` = origin span's `service_name`.

SQL equivalence note: a span carries an `exception` event iff it has a `span_errors` row whose
`exception_type <> 'span.error'` (the status-only fallback in
[`buildErrorRecords`](../../../backend/otelStore.js:153) uses the literal `'span.error'`; real
exception events never do). Every error span produces at least one `span_errors` row, so the two
representations describe the same set.

## Non-goals (YAGNI)

- No "downstream/bottleneck operation" for **slow** (non-error) traces — different, fuzzier
  definition; defer.
- No subline under an active **Service filter** — that view already renders each row from the
  filtered service's own entry span (`svc_operation`), so a trace-wide failing op would be
  confusing/redundant.
- No new standalone column (keeps the already-tight table from needing a width re-tune).
- No change to the detail drawer, Situations, or the synthetic generators.

## Backend changes — `backend/otelStore.js`

**Implemented (revised from the plan below):** computed at *query time* in
`listTraces` — two correlated `COALESCE` subqueries selecting `… AS
failing_operation` / `… AS failing_service` — **not** denormalized in
`recomputeTrace`. The recompute-denormalize path (items 1–2 below) was built and
tested first but stored NULL in practice; the query-time form needs no schema
migration, never goes stale, and runs against committed spans. The *selection
SQL* (pool = exception-bearing span via `span_errors.exception_type <>
'span.error'`, latest-started; else latest-started `status_code >= 2` span;
shared `ORDER BY start_time_ns DESC, span_id DESC`) is exactly as specified
below — only its location moved into the `listTraces` SELECT (correlated on
`t.trace_id`). The recompute plan is kept below for context.

1. **Schema migration** (in `_initSchema`, next to the existing `addColumn('traces', …)` calls
   around [line 334](../../../backend/otelStore.js:334)):
   ```js
   addColumn('traces', 'failing_operation', 'TEXT');
   addColumn('traces', 'failing_service', 'TEXT');
   ```
   Additive; pre-existing rows are NULL until their next ingest recomputes the summary (same
   contract already documented for `service_namespace`).

2. **Denormalize in `recomputeTrace`** (the `INSERT INTO traces (…) SELECT …`,
   [line 364](../../../backend/otelStore.js:364)). Add `failing_operation, failing_service` to the
   column list and two COALESCE expressions to the SELECT (origin = pool-then-fallback, latest
   start):
   ```sql
   -- failing_operation: origin error span's name (mirrors deriveProbableCause)
   COALESCE(
     (SELECT s.name FROM span_errors e
        JOIN spans s ON s.trace_id = e.trace_id AND s.span_id = e.span_id
       WHERE e.trace_id = @traceId AND e.exception_type <> 'span.error'
       ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1),
     (SELECT s.name FROM spans s
       WHERE s.trace_id = @traceId AND s.status_code >= 2
       ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1)
   ),
   -- failing_service: same origin span's service (identical WHERE/ORDER → same row)
   COALESCE(
     (SELECT s.service_name FROM span_errors e
        JOIN spans s ON s.trace_id = e.trace_id AND s.span_id = e.span_id
       WHERE e.trace_id = @traceId AND e.exception_type <> 'span.error'
       ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1),
     (SELECT s.service_name FROM spans s
       WHERE s.trace_id = @traceId AND s.status_code >= 2
       ORDER BY s.start_time_ns DESC, s.span_id DESC LIMIT 1)
   )
   ```
   Add both to the `ON CONFLICT(trace_id) DO UPDATE SET` clause
   (`failing_operation = excluded.failing_operation`, `failing_service = excluded.failing_service`).
   Lookups are covered by `idx_spans_trace` and `idx_errors_trace`; this matches the file's existing
   per-trace correlated-subquery pattern.

3. **No `listTraces` change** — it already `SELECT t.*` ([line ~810](../../../backend/otelStore.js:770)),
   and the list route passes rows straight through (`res.json({ traces })`,
   [traces.js:38](../../../backend/routes/traces.js:38)). The new columns flow automatically.

## Frontend changes

1. **Type** — add to `TraceSummary` ([types.ts:15](../../../frontend/src/components/otel-data/types.ts:15)):
   ```ts
   failing_operation?: string | null;
   failing_service?: string | null;
   ```

2. **Pure helper** in `utils.ts` (sits beside `serviceTraceView`, unit-tested like it):
   ```ts
   export const failingOperationView = (
     trace: TraceSummary,
     serviceFilter: string,
   ): { operation: string; service: string | null } | null => {
     if (serviceFilter) return null;              // only the unfiltered trace-level view
     if (!trace.has_error) return null;
     const op = trace.failing_operation;
     if (!op) return null;
     if (op === trace.root_operation) return null; // don't echo the Root Operation column
     return { operation: op, service: trace.failing_service ?? null };
   };
   ```

3. **Render** — in `TracesTab.tsx`, wrap the Service `<td>` content
   ([lines 271-308](../../../frontend/src/components/otel-data/TracesTab.tsx:271)) in a vertical flex
   and append the subline when `failingOperationView(t, serviceFilter)` is non-null. Muted/danger-tinted,
   monospaced, truncated, with a `title` of `"{service}: {operation}"` (or just the operation when
   `service` is null) so a failing service differing from the row's root service stays discoverable.

## Data flow

`spans` ingested → `recomputeTrace` denormalizes `failing_operation`/`failing_service` onto the
`traces` row → `listTraces()` (`SELECT t.*`) → `/api/traces` → `TraceSummary` →
`failingOperationView` → subline. SSE-pushed brand-new rows show no subline until the next recompute
settles — identical to how the existing count badges behave.

## Testing (TDD)

**Backend** (`backend/__tests__/otelStore.test.mjs`, matching its existing ingest helpers):
- Cascade: OK root → status-only error span (parent) → deeper error span *with* an `exception` event
  that starts later. Assert `listTraces()[0].failing_operation` / `failing_service` = the deeper
  exception span (pool preference + latest start).
- No exception events: two status-only error spans. Assert the **latest-started** one wins (fallback
  branch).
- No errors: assert `failing_operation` is null/undefined.
- Root span itself errors: assert `failing_operation === root_operation` (the frontend helper then
  suppresses the subline — covered by the helper test, not here).

**Frontend** (`frontend/src/components/otel-data/utils.test.ts`):
- `failingOperationView` returns null under a service filter, null when no error, null when
  `failing_operation` absent, null when it equals `root_operation`, and `{operation, service}`
  otherwise.

## Verification (after implementation)

Backend: `cd backend && npm test` green. Frontend: `cd frontend && npx vitest run` green. Then run
the app, generate synthetic traces, and confirm the error rows show the `└ <failing op>` subline
under Service in the unfiltered list (and that it disappears under a service filter).

## Risks / notes

- The repo has unrelated uncommitted work (`SpanRow.tsx`, `verify-waterfall.*`). Stage only this
  feature's files; do not commit those.
- `failing_operation`/`failing_service` are computed by two separate COALESCE blocks; the shared
  `ORDER BY start_time_ns DESC, span_id DESC LIMIT 1` guarantees both resolve to the same span.
- Demo optics: in the canned synthetic scenarios the failing op is ~constant per scenario; that's
  expected and reads as "same query failing every time." Variety appears with real tenant data.
