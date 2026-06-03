# SQLite Performance: Incremental VACUUM + 1000-Trace Window

Design spec for hardening the local OTel trace store (`backend/otelStore.js`)
against the failure mode that bites under sustained telemetry volume, and for
widening the sliding window from 500 to 1000 traces.

- **Status:** approved design, pre-implementation (brainstormed 2026-05-31).
- **Scope (agreed, "use your judgement"):** high-value, low-risk hardening of
  the existing single-process sandbox — incremental VACUUM, a 500→1000 trace
  window, and two safe PRAGMA tunings. The micro-batch ingest queue is
  **deliberately deferred** (see §7).
- **Triggering feedback:** an external review flagged that the periodic
  `VACUUM` "exclusive lock will block OTLP ingest and cause immediate trace
  drops."

## 1. Background & motivation

The trace store uses `better-sqlite3` (`backend/otelStore.js:12`), which is
**synchronous** — every statement runs on the Node event loop. So a
long-running statement blocks `/api/otlp/traces` *and* every other route at the
same time. This is by design (single self-contained process) but sets the
constraint this work lives under.

The concrete problem: `_startMaintenance` runs a full `this.db.exec('VACUUM')`
every 30 minutes, plus once 30 s after boot (`backend/otelStore.js:227-236`).
`VACUUM` rewrites the entire database file; for its full duration the single
thread is busy and ingest POSTs stall (and can drop, depending on client
timeouts). The review called this a "30-minute exclusive lock" — that framing
is imprecise (the lock is held only *during* the rewrite, not for 30 minutes),
but the conclusion (ingest stalls) is correct, and the real mechanism
(event-loop block on a synchronous driver) is the sharper reason to fix it.

This `VACUUM` is the **only** multi-second event-loop block in the store. Once
it's gone, the per-request ingest cost is millisecond-scale (indexed upserts +
a bounded recompute + eviction), which is why the larger micro-batch rework is
deferred rather than built now (§7).

## 2. Goals / Non-Goals

**Goals**
- Remove the event-loop stall from periodic VACUUM (incremental auto-vacuum).
- Raise the trace window 500 → 1000 end to end (store + API + UI), keeping the
  cap sites in sync.
- Two low-risk PRAGMA tunings for the read-heavy query paths.
- Preserve correctness: existing tests pass; existing DBs migrate
  transparently; the synchronous `ingestSpans`/`ingestLogs` API is unchanged.

**Non-Goals / Deferred**
- Micro-batched / off-request ingest (deferred — §7).
- Worker threads or an external trace backend (Tempo/Jaeger).
- Raising `LOG_CAP` / `ERROR_CAP` or the SSE replay ring — independent of the
  trace window and not part of the ask.
- Virtualizing the trace table by default (measure first — §6).

## 3. Incremental VACUUM

### 3.1 Constructor (`backend/otelStore.js:186-210`)

`auto_vacuum` is a file-level mode in the DB header: free to set on a **new**
database before any table exists, but converting an **existing** database
requires one full `VACUUM`.

Set the mode immediately after opening the DB (before `_initSchema`), and add
the two perf pragmas (§5) in the same block:

```js
this.db = new Database(dbPath);
this.db.pragma('auto_vacuum = INCREMENTAL'); // free for a new DB; needs VACUUM on an existing one
this.db.pragma('journal_mode = WAL');
this.db.pragma('synchronous = NORMAL');
this.db.pragma('wal_autocheckpoint = 1000');
this.db.pragma('journal_size_limit = 67108864');
this.db.pragma('temp_store = MEMORY');   // §5
this.db.pragma('cache_size = -16000');   // §5
```

Then, after `_initSchema()`, convert a pre-existing FULL/NONE database once:

```js
// The pragma above is recorded but only takes effect on an existing DB after
// one full VACUUM. Runs at construct time, before app.listen (index.js:124),
// so no ingest is blocked; the DB is bounded by TRACE_CAP, so it's quick.
if (this.db.pragma('auto_vacuum', { simple: true }) !== 2 /* INCREMENTAL */) {
  try { this.db.exec('VACUUM'); }
  catch (e) { console.warn('[otelStore] auto_vacuum conversion VACUUM failed:', e.message); }
}
this._lastIngestAt = 0;
```

For a fresh `:memory:` DB (the test path), the mode is already `2` after the
pragma, so the conversion VACUUM is skipped.

### 3.2 Maintenance loop (`backend/otelStore.js:217-244`)

- **Keep** the 60 s `wal_checkpoint(TRUNCATE)` timer.
- **Remove** the 30-min full `VACUUM` timer and the 30 s initial VACUUM.
- **Add** a short, quiet-time-gated incremental reclaim:

```js
_startMaintenance() {
  this._walTimer = setInterval(() => {
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); }
    catch (e) { console.warn('[otelStore] WAL checkpoint failed:', e.message); }
  }, 60_000);
  this._incVacTimer = setInterval(() => this._maybeIncrementalVacuum(), INC_VACUUM_INTERVAL_MS);
}

_maybeIncrementalVacuum() {
  // WAL quiet-time check: skip if ingest landed very recently, so reclaim
  // never adds latency to an active burst.
  if (Date.now() - this._lastIngestAt < VACUUM_QUIET_MS) return;
  try {
    if (!this.db.pragma('freelist_count', { simple: true })) return;
    this.db.pragma(`incremental_vacuum(${INC_VACUUM_PAGES})`);
  } catch (e) {
    console.warn('[otelStore] incremental_vacuum failed:', e.message);
  }
}
```

`stopMaintenance()` also clears `_incVacTimer`.

Proposed module constants (tunable; validated empirically in §8):
- `INC_VACUUM_PAGES = 200` — pages reclaimed per cycle (~800 KB at the 4 KB
  page size; sub-millisecond). The review suggested 50; we keep the chunk small
  but a little larger so reclaim keeps pace with continuous eviction at the cap,
  while staying far below any perceptible block. Reclaiming the *whole* freelist
  at once would reintroduce a blocking rewrite — exactly what we're removing.
- `INC_VACUUM_INTERVAL_MS = 10_000` — small + frequent beats large + rare.
- `VACUUM_QUIET_MS = 2_000` — "no ingest in the last 2 s" = quiet.

`_lastIngestAt` is bumped at the top of `ingestSpans` / `ingestLogs` when the
batch is non-empty.

## 4. 1000-trace sliding window

The 500 cap lives in three places that must agree. Make the backend a single
exported source of truth and mirror it once on the frontend.

| Site | File:line | Change |
|---|---|---|
| Store cap (eviction + internal list clamp) | `backend/otelStore.js:14`, used at `:731` and `:872` | `TRACE_CAP = 1000`; **add to `module.exports`** |
| Route clamp | `backend/routes/traces.js:27-28` | import `TRACE_CAP` from `../otelStore`; `Math.min(TRACE_CAP, …)` instead of the hardcoded `Math.min(500, …)` |
| Frontend list / SSE-merge cap | `frontend/src/components/otel-data/constants.ts:18` | `TRACE_LIST_LIMIT = 1000`; update the "TRACE_CAP=500" sync comment (`:15`) |
| Existing unit test | `backend/__tests__/otelStore.test.mjs:46-63` | the test hardcodes "keeps newest **500** when 600 ingested" — re-derive bounds from the exported `TRACE_CAP` so it tracks the constant |

Notes:
- `_evictIfNeeded` (`:729`) and the `listTraces` clamp (`:872`) already
  reference `TRACE_CAP`, so they follow automatically.
- `otelStore.js` already exports `{ OtelStore, extractSpans, extractLogRecords }`
  (imported in `routes/otlp.js:6`); adding `TRACE_CAP` is the clean path. The
  frontend can't import a backend constant, so its mirror stays in sync by
  comment.
- Backend + frontend ship together, so the caps never disagree in practice.
- Feasibility: 1000 rows is trivial for SQLite; the frontend holds lightweight
  `TraceSummary` objects, not full spans. The only watch-item is rendering (§6).

## 5. PRAGMA tuning

Additive, low-risk, on top of the existing WAL setup
(`backend/otelStore.js:191-198`), added in the constructor block in §3.1:
- `temp_store = MEMORY` — the `GROUP BY` / `ORDER BY` / CTE work in
  `listTraces`, `tracesHistogram`, `listOperations`, etc. builds temp B-trees in
  RAM instead of temp files.
- `cache_size = -16000` — ~16 MB page cache (negative = KiB), keeping the hot
  working set resident for the frequent read queries.

Leave `mmap_size` alone (marginal, platform edge cases) unless §8 surfaces a
read bottleneck.

## 6. Frontend — rendering up to 1000 rows (measure first)

Keep all 1000 in memory so filters, search, outlier detection, and charts see
the full window. `visibleTraces` (`frontend/src/components/OtelDataPage.tsx:373`)
already filters `traces` with no render-cap; the live SSE merge caps at
`TRACE_LIST_LIMIT` (`OtelDataPage.tsx:787-788`) and the list fetch uses it
(`:504`). The table (`frontend/src/components/otel-data/TracesTab.tsx:241`,
sorting a copy at `:60`) maps rows **un-virtualized**.

Plan:
1. Raise `TRACE_LIST_LIMIT` to 1000 and measure the real render with the
   preview tooling: initial render, re-render on filter toggles, and live SSE
   merge churn.
2. Smooth → ship as-is.
3. Janky → add a rendered-row cap (e.g. ~500 with a "showing 500 of N"
   affordance). The Traces tab already shows *"{n} of {total} traces in window ·
   most recent shown"* (`TracesTab.tsx:164-167`), so a render cap fits the
   existing copy. No new dependency.
4. Virtualization (`@tanstack/react-virtual`) only if specifically wanted.

## 7. Deferred — micro-batched ingest

**Decision: not now.** Rationale:
- The feedback's stated failure (VACUUM blocks ingest → drops) is fully
  resolved by §3. That full VACUUM is the only multi-second event-loop block.
- A micro-batch queue addresses a *different*, more speculative concern (raw
  write concurrency the feedback did not raise) at real cost: a queue lifecycle,
  flush triggers, a shutdown drain (`index.js:130` `shutdown()` would need a
  `flushNow()`), and a ≤flush-interval window where an acked POST isn't yet
  persisted.
- For a single-process demo/diagnostic sandbox, that's headroom the tool won't
  realistically use. YAGNI.

**Trigger to revisit:** if live measurement (§8) shows `/api/otlp/traces`
latency rising under burst *after* §3 ships — i.e. per-request synchronous
writes, not VACUUM, become the bottleneck — add: parse + `enqueueSpans` →
return 200; a short-interval (+ size-capped) flush coalescing into one
transaction; eviction moved to the flush; `flushNow()` wired into `shutdown()`
and `stopMaintenance()`. The synchronous `ingestSpans` core stays for tests and
internal callers (its only production callers today are `routes/otlp.js:36,53`).

## 8. Testing & verification

Runner: **vitest** (`backend/package.json` → `vitest run`), tests in
`backend/__tests__/*.test.mjs`, constructing `OtelStore` on a `:memory:` DB
with `vi.useFakeTimers()` so maintenance intervals never fire mid-test
(`otelStore.test.mjs:33-44`). Fake timers also mean the new `_incVacTimer`
won't fire in tests — assertions drive `_maybeIncrementalVacuum()` /
`incremental_vacuum` directly.

Backend tests (`backend/__tests__/otelStore.test.mjs`):
- **Window cap:** ingest `TRACE_CAP + 100` traces → exactly `TRACE_CAP`
  retained, oldest evicted (replaces the hardcoded 500/600 test; derive off the
  exported constant).
- **auto_vacuum mode:** a freshly constructed store reports
  `pragma('auto_vacuum') === 2`.
- **Existing-DB conversion:** open a temp-file DB created with
  `auto_vacuum = NONE`, construct `OtelStore` on it → mode becomes `2`.
- **Incremental reclaim:** after ingesting + evicting, `freelist_count > 0`,
  then `_maybeIncrementalVacuum()` (or a direct `incremental_vacuum`) reduces it.
- Existing tests stay green unchanged (synchronous core preserved).

Live verification (preview/run tooling, not hand-off):
- Drive OTLP traffic at `/api/otlp/traces`; confirm it stays responsive across
  the vacuum cadence (no stall window like the old full VACUUM produced).
- Confirm the viewer holds/handles 1000 traces and the render is acceptable
  (§6 gate).

## 9. Migration & backward compatibility

- **Existing DBs:** convert to incremental auto-vacuum via the one-time startup
  VACUUM (§3.1). No schema change; no data migration for the cap bump — stores
  simply grow toward 1000.
- **API/UI:** shipped together; caps stay aligned.
- **Internal callers/tests:** unaffected — `ingestSpans`/`ingestLogs` keep
  synchronous semantics.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| incremental_vacuum can't keep pace with eviction → file creeps | Small chunk, frequent tick; tune `INC_VACUUM_PAGES`/interval; verify `freelist_count` stays bounded under sustained load (§8). |
| Conversion VACUUM at boot on a large legacy file | Bounded by the cap (≤1000 traces); runs before `app.listen`; wrapped in try/catch. |
| 1000 un-virtualized rows janky | Measure-first gate with a no-dependency fallback (§6). |
| Stray "500" references in docs/UI copy | Grep `docs/` + `README.md` + frontend copy for "500"/"VACUUM" during implementation; update where they describe the cap/maintenance. |
