# SQLite Perf — Incremental VACUUM + 1000-Trace Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the event-loop stall caused by the periodic full `VACUUM`, raise the trace sliding window from 500 to 1000 (store + API + UI), and add two safe read-path PRAGMAs — without changing the synchronous ingest API.

**Architecture:** `backend/otelStore.js` is a synchronous `better-sqlite3` store. Replace the 30-minute full `VACUUM` with `auto_vacuum = INCREMENTAL` plus small, quiet-time-gated `incremental_vacuum(N)` cycles. Bump the single backend `TRACE_CAP` (exported) and the frontend mirror. The micro-batch ingest queue is **deferred** (see spec §7).

**Tech Stack:** Node.js + Express 5, `better-sqlite3` 12, React 18 + TypeScript + Vite, **vitest** (`backend/__tests__/*.test.mjs`, `frontend` vitest).

**Spec:** [docs/superpowers/specs/2026-05-31-sqlite-perf-trace-window-design.md](../specs/2026-05-31-sqlite-perf-trace-window-design.md)

---

## File Structure

- **Modify** `backend/otelStore.js` — `TRACE_CAP` value + export; new vacuum constants; constructor pragmas + conversion + `_lastIngestAt`; `_startMaintenance`/`_maybeIncrementalVacuum`/`stopMaintenance`; `_lastIngestAt` bump in `ingestSpans`/`ingestLogs`.
- **Modify** `backend/routes/traces.js` — import `TRACE_CAP`, use it in the `/api/traces` clamp.
- **Modify** `backend/__tests__/otelStore.test.mjs` — re-derive the cap test off `TRACE_CAP`; add auto_vacuum mode, conversion, and quiet-gate tests.
- **Modify** `frontend/src/components/otel-data/constants.ts` — `TRACE_LIST_LIMIT = 1000` + comments.
- **Modify** `docs/ARCHITECTURE.md`, `README.md` — stray "500 traces" references.
- **Maybe modify** `frontend/src/components/otel-data/TracesTab.tsx` — rendered-row cap, only if Task 7's measurement shows jank.

---

## Task 0: Branch

- [ ] **Step 1: Create a feature branch off main**

```bash
git checkout main
git checkout -b feat/sqlite-perf-trace-window
git status
```
Expected: on branch `feat/sqlite-perf-trace-window`, working tree clean except the untracked `docs/superpowers/specs/2026-05-31-sqlite-perf-trace-window-design.md` and this plan.

- [ ] **Step 2: Commit the spec + plan**

```bash
git add docs/superpowers/specs/2026-05-31-sqlite-perf-trace-window-design.md docs/superpowers/plans/2026-05-31-sqlite-perf-trace-window.md
git commit -m "docs: design + plan for incremental VACUUM and 1000-trace window

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 1: Raise the backend trace window to 1000

**Files:**
- Modify: `backend/otelStore.js:14` (constant), `backend/otelStore.js:1563` (exports)
- Modify: `backend/routes/traces.js:1-28` (import + clamp)
- Test: `backend/__tests__/otelStore.test.mjs:7` (import) and `:46-63` (cap test)

- [ ] **Step 1: Update the cap test to derive off `TRACE_CAP`**

In `backend/__tests__/otelStore.test.mjs`, change the import on line 7 from:

```js
const { OtelStore, extractSpans } = require('../otelStore');
```
to:
```js
const { OtelStore, extractSpans, TRACE_CAP } = require('../otelStore');
```

Then replace the `describe('TRACE_CAP eviction', …)` block (lines 46-64) with:

```js
  describe('TRACE_CAP eviction', () => {
    it('keeps the newest TRACE_CAP traces, evicting oldest first', () => {
      const overflow = 100;
      const total = TRACE_CAP + overflow;
      const id = (i) => `t${String(i).padStart(6, '0')}`;
      for (let i = 0; i < total; i++) {
        // Advance the clock so received_at strictly increases — eviction
        // orders by received_at ASC and ties are not guaranteed stable.
        vi.setSystemTime(Date.now() + 1);
        store.ingestSpans([makeSpan({ traceId: id(i), spanId: `s${i}` })]);
      }
      const { n } = store.countTraces.get();
      expect(n).toBe(TRACE_CAP);
      // Oldest `overflow` evicted; newest TRACE_CAP retained.
      expect(store.getTrace(id(0))).toBeNull();
      expect(store.getTrace(id(overflow - 1))).toBeNull();
      expect(store.getTrace(id(overflow))).not.toBeNull();
      expect(store.getTrace(id(total - 1))).not.toBeNull();
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "TRACE_CAP eviction"
```
Expected: FAIL — `TRACE_CAP` is `undefined` (not yet exported), so `total` is `NaN` and the assertions error / loop misbehaves.

- [ ] **Step 3: Bump the constant and export it**

In `backend/otelStore.js`, change line 14 from:
```js
const TRACE_CAP = 500;
```
to:
```js
const TRACE_CAP = 1000;
```

Change line 1563 from:
```js
module.exports = { OtelStore, extractSpans, extractLogRecords };
```
to:
```js
module.exports = { OtelStore, extractSpans, extractLogRecords, TRACE_CAP };
```

- [ ] **Step 4: Point the route clamp at `TRACE_CAP`**

In `backend/routes/traces.js`, add the require after the header comment (above `function register`):
```js
const { TRACE_CAP } = require('../otelStore');

function register(app, { otelStore, docker }) {
```

Change line 28 from:
```js
    const clampedLimit = Math.min(500, Math.max(1, Number.isFinite(requested) ? requested : 200));
```
to:
```js
    const clampedLimit = Math.min(TRACE_CAP, Math.max(1, Number.isFinite(requested) ? requested : 200));
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "TRACE_CAP eviction"
```
Expected: PASS (1 test).

- [ ] **Step 6: Run the full backend suite (no regressions)**

```bash
cd backend && npm test
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/otelStore.js backend/routes/traces.js backend/__tests__/otelStore.test.mjs
git commit -m "feat(otel-store): raise trace sliding window to 1000

Export TRACE_CAP and bump 500->1000; route clamp uses the shared constant.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Raise the frontend trace window to 1000

**Files:**
- Modify: `frontend/src/components/otel-data/constants.ts:14-18`

- [ ] **Step 1: Update the constant and comments**

Replace lines 14-18 of `frontend/src/components/otel-data/constants.ts`:
```ts
// Max traces requested for the list and retained in the live SSE merge.
// Matches the backend store ceiling (TRACE_CAP=500 in backend/otelStore.js) so
// the viewer surfaces every retained trace instead of truncating at the route
// default of 200. The /api/traces route clamps anything above 500 anyway.
export const TRACE_LIST_LIMIT = 500;
```
with:
```ts
// Max traces requested for the list and retained in the live SSE merge.
// Matches the backend store ceiling (TRACE_CAP=1000 in backend/otelStore.js) so
// the viewer surfaces every retained trace instead of truncating at the route
// default of 200. The /api/traces route clamps anything above 1000 anyway.
export const TRACE_LIST_LIMIT = 1000;
```

- [ ] **Step 2: Typecheck + build (catches any type/usage breakage)**

```bash
cd frontend && npm run build
```
Expected: `tsc` passes and `vite build` succeeds with no errors.

- [ ] **Step 3: Run frontend tests**

```bash
cd frontend && npm test
```
Expected: all tests pass (no test asserts the old 500 value).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/otel-data/constants.ts
git commit -m "feat(otel-data): raise frontend trace window to 1000

Matches the backend TRACE_CAP bump.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Constructor — incremental auto-vacuum, conversion, perf PRAGMAs

**Files:**
- Modify: `backend/otelStore.js:190-209` (constructor)
- Test: `backend/__tests__/otelStore.test.mjs` (mode + pragma asserts in the main `describe`; a new file-based conversion `describe`)

- [ ] **Step 1: Write the failing tests**

In `backend/__tests__/otelStore.test.mjs`, add these imports at the top (after the existing `createRequire` line and `const { OtelStore, … } = require('../otelStore');`):
```js
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const Database = require('better-sqlite3');
```

Inside the main `describe('OtelStore', …)` block, add:
```js
  describe('pragmas', () => {
    it('opens with incremental auto_vacuum', () => {
      expect(store.db.pragma('auto_vacuum', { simple: true })).toBe(2); // INCREMENTAL
    });
    it('uses in-memory temp store and a 16 MB page cache', () => {
      expect(store.db.pragma('temp_store', { simple: true })).toBe(2);     // MEMORY
      expect(store.db.pragma('cache_size', { simple: true })).toBe(-16000); // ~16 MB
    });
  });
```

After the main `describe('OtelStore', …)` block closes, add a new top-level block:
```js
describe('auto_vacuum conversion', () => {
  it('converts a pre-existing NONE database to INCREMENTAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otelstore-'));
    const dbPath = path.join(dir, 'legacy.db');
    // Seed a DB in auto_vacuum=NONE with a table so the mode is committed.
    const seed = new Database(dbPath);
    seed.pragma('auto_vacuum = NONE');
    seed.exec('CREATE TABLE seed (id INTEGER)');
    expect(seed.pragma('auto_vacuum', { simple: true })).toBe(0); // NONE
    seed.close();

    const store = new OtelStore({ dbPath });
    try {
      expect(store.db.pragma('auto_vacuum', { simple: true })).toBe(2); // INCREMENTAL
    } finally {
      store.stopMaintenance();
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "pragmas"
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "auto_vacuum conversion"
```
Expected: FAIL — `auto_vacuum` is `0`, `temp_store`/`cache_size` are defaults, and the existing DB is never converted.

- [ ] **Step 3: Add the pragmas + conversion in the constructor**

In `backend/otelStore.js`, change the constructor open (currently):
```js
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
```
to:
```js
    this.db = new Database(dbPath);
    // Incremental auto-vacuum: eviction's deletes move pages to the freelist,
    // reclaimed in small non-blocking chunks by _maybeIncrementalVacuum. Set
    // before any table is created so it applies for free on a new DB; an
    // existing DB is converted by the one-time VACUUM below.
    this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
```

Change (currently):
```js
    this.db.pragma('journal_size_limit = 67108864'); // 64 MB
    this._initSchema();
```
to:
```js
    this.db.pragma('journal_size_limit = 67108864'); // 64 MB
    // Read-path tuning: temp B-trees (GROUP BY/ORDER BY/CTEs) build in RAM;
    // ~16 MB page cache keeps the hot working set resident.
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -16000');
    this._initSchema();
```

Change (currently):
```js
    this._prepStatements();
    // One-shot startup eviction — covers the case where an existing DB has
```
to:
```js
    this._prepStatements();
    // Convert a pre-existing FULL/NONE database to incremental auto-vacuum.
    // The pragma above only takes effect on an existing DB after one VACUUM;
    // run it here at construct time (before app.listen) so no ingest is
    // blocked, and the DB is bounded by TRACE_CAP so it's quick.
    if (this.db.pragma('auto_vacuum', { simple: true }) !== 2) {
      try { this.db.exec('VACUUM'); }
      catch (e) { console.warn('[otelStore] auto_vacuum conversion VACUUM failed:', e.message); }
    }
    // Wall-clock of the last ingest, for the maintenance quiet-time gate.
    this._lastIngestAt = 0;
    // One-shot startup eviction — covers the case where an existing DB has
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "pragmas"
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "auto_vacuum conversion"
```
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

```bash
cd backend && npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/otelStore.js backend/__tests__/otelStore.test.mjs
git commit -m "perf(otel-store): incremental auto-vacuum + read-path PRAGMAs

Set auto_vacuum=INCREMENTAL (convert existing DBs once at startup), add
temp_store=MEMORY and a 16 MB cache_size.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Maintenance — replace full VACUUM with quiet-gated incremental reclaim

**Files:**
- Modify: `backend/otelStore.js:14` area (new constants), `:217-244` (maintenance), `:429` and `:526` (`_lastIngestAt` bump)
- Test: `backend/__tests__/otelStore.test.mjs` (quiet-gate spy tests in the main `describe`)

- [ ] **Step 1: Write the failing tests**

Inside the main `describe('OtelStore', …)` block of `backend/__tests__/otelStore.test.mjs`, add:
```js
  describe('incremental vacuum maintenance', () => {
    it('skips reclaim when ingest is recent (quiet-time gate)', () => {
      store.ingestSpans([makeSpan({ traceId: 'tq', spanId: 'sq' })]); // sets _lastIngestAt = now
      const spy = vi.spyOn(store.db, 'pragma');
      store._maybeIncrementalVacuum();
      const ranIncVac = spy.mock.calls.some(([arg]) => String(arg).includes('incremental_vacuum'));
      expect(ranIncVac).toBe(false);
      spy.mockRestore();
    });

    it('attempts reclaim once ingest has been quiet', () => {
      store.ingestSpans([makeSpan({ traceId: 'tq2', spanId: 'sq2' })]);
      store._lastIngestAt = Date.now() - 10_000; // older than the quiet window
      const spy = vi.spyOn(store.db, 'pragma');
      store._maybeIncrementalVacuum();
      const checkedFreelist = spy.mock.calls.some(([arg]) => String(arg).includes('freelist_count'));
      expect(checkedFreelist).toBe(true);
      spy.mockRestore();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "incremental vacuum maintenance"
```
Expected: FAIL — `store._maybeIncrementalVacuum` is not a function.

- [ ] **Step 3: Add the vacuum constants**

In `backend/otelStore.js`, immediately after line 14 (`const TRACE_CAP = 1000;`) add:
```js
// Incremental-vacuum maintenance: reclaim freelist pages in small,
// non-blocking chunks during ingest-quiet windows (replaces a blocking full
// VACUUM that froze the event loop — and OTLP ingest — for the whole rewrite).
// All three are tunable.
const INC_VACUUM_PAGES = 200;           // ~800 KB/cycle at the 4 KB page size
const INC_VACUUM_INTERVAL_MS = 10_000;  // how often to attempt reclaim
const VACUUM_QUIET_MS = 2_000;          // skip if ingest landed within this window
```

- [ ] **Step 4: Replace the maintenance methods**

In `backend/otelStore.js`, replace the entire `_startMaintenance()` + `stopMaintenance()` block (lines 217-244) with:
```js
  _startMaintenance() {
    // Truncate WAL every 60s — cheap, keeps the WAL file from creeping.
    this._walTimer = setInterval(() => {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); }
      catch (e) { console.warn('[otelStore] WAL checkpoint failed:', e.message); }
    }, 60_000);
    // Reclaim freed pages incrementally instead of a periodic full VACUUM.
    // On the synchronous driver a full VACUUM blocked the event loop (and thus
    // OTLP ingest) for the whole rewrite; small quiet-time chunks do not.
    this._incVacTimer = setInterval(() => this._maybeIncrementalVacuum(), INC_VACUUM_INTERVAL_MS);
  }

  // Return up to INC_VACUUM_PAGES freelist pages to the OS, but only when no
  // ingest has landed recently — so reclaim never adds latency to a burst.
  _maybeIncrementalVacuum() {
    if (Date.now() - this._lastIngestAt < VACUUM_QUIET_MS) return;
    try {
      if (!this.db.pragma('freelist_count', { simple: true })) return;
      this.db.pragma(`incremental_vacuum(${INC_VACUUM_PAGES})`);
    } catch (e) {
      console.warn('[otelStore] incremental_vacuum failed:', e.message);
    }
  }

  stopMaintenance() {
    if (this._walTimer) clearInterval(this._walTimer);
    if (this._incVacTimer) clearInterval(this._incVacTimer);
    this._walTimer = null;
    this._incVacTimer = null;
  }
```

- [ ] **Step 5: Bump `_lastIngestAt` on ingest**

In `ingestSpans` (around line 429), change:
```js
    if (!rawSpans || !rawSpans.length) return [];
    const now = Date.now();
```
to:
```js
    if (!rawSpans || !rawSpans.length) return [];
    const now = Date.now();
    this._lastIngestAt = now;
```

In `ingestLogs` (around line 526), change:
```js
    if (!rawLogs || !rawLogs.length) return 0;
    const now = Date.now();
```
to:
```js
    if (!rawLogs || !rawLogs.length) return 0;
    const now = Date.now();
    this._lastIngestAt = now;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd backend && npx vitest run __tests__/otelStore.test.mjs -t "incremental vacuum maintenance"
```
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full backend suite**

```bash
cd backend && npm test
```
Expected: all pass (the old 30-min/initial VACUUM timers are gone; existing tests already call `stopMaintenance()` in `afterEach`).

- [ ] **Step 8: Commit**

```bash
git add backend/otelStore.js backend/__tests__/otelStore.test.mjs
git commit -m "perf(otel-store): replace 30-min full VACUUM with incremental reclaim

Quiet-time-gated incremental_vacuum(N) on a 10s timer instead of a blocking
full VACUUM. Removes the periodic event-loop stall that dropped OTLP ingest.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Update stray "500-trace" references in docs

**Files:**
- Modify: `docs/ARCHITECTURE.md:315`, `README.md:214`

- [ ] **Step 1: Confirm the references (and check for VACUUM mentions)**

```bash
cd /Users/jammicha/dev/HelixConfigurator
grep -rniE "capped at 500|cap at 500 traces|500 traces|30-minute VACUUM|30 ?min.*VACUUM|VACUUM" README.md docs/ARCHITECTURE.md docs/otel-data-todo.md
```
Expected: matches at `docs/ARCHITECTURE.md:315` and `README.md:214` (cap). If any line describes the 30-minute VACUUM maintenance, update it to describe incremental auto-vacuum in Step 2's spirit.

- [ ] **Step 2: Edit the two cap references**

In `docs/ARCHITECTURE.md` line 315, change `Sliding-window cap at 500 traces` → `Sliding-window cap at 1000 traces`.

In `README.md` line 214, change `(capped at 500 traces, sliding window)` → `(capped at 1000 traces, sliding window)`.

- [ ] **Step 3: Verify no stale "500 traces" remain**

```bash
grep -rniE "500 traces|capped at 500" README.md docs/ARCHITECTURE.md
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: trace window is now 1000

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Live verification — ingest responsiveness + 1000-row render

This task uses the run/preview tooling (not a hand-off to the user). The goal is evidence: ingest stays responsive with incremental vacuum, and the viewer handles a full 1000-trace window.

- [ ] **Step 1: Start the app**

Start the backend (`cd backend && npm run dev`) and the frontend dev server (`cd frontend && npm run dev`, serves on `:3000`). Use `preview_start` pointed at the dev URL.

- [ ] **Step 2: Inject ~1100 synthetic traces via the public OTLP endpoint**

Run this against the backend's port (replace `PORT`; the frontend dev server proxies `/api`, or POST straight to the backend). Posts 1100 single-span OTLP/JSON traces so the store fills past the 1000 cap and exercises eviction + reclaim:
```bash
node -e '
const PORT = process.env.PORT || 3000;
const base = `http://localhost:${PORT}`;
const send = async (i) => {
  const now = Date.now() * 1e6;
  const body = { resourceSpans: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "loadgen" } }] },
    scopeSpans: [{ spans: [{
      traceId: i.toString(16).padStart(32, "0"),
      spanId: i.toString(16).padStart(16, "0"),
      name: "GET /work", kind: 2,
      startTimeUnixNano: String(now), endTimeUnixNano: String(now + 5e6),
      status: { code: 1 },
    }] }],
  }] };
  const r = await fetch(`${base}/api/otlp/traces`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST failed: ${r.status}`);
};
(async () => {
  const t0 = Date.now();
  for (let i = 1; i <= 1100; i++) await send(i);
  console.log(`posted 1100 traces in ${Date.now() - t0} ms`);
})();
'
```
Expected: completes without errors; prints total time. No request hangs for seconds (the old full VACUUM cadence would have produced a multi-second stall — there is none now).

- [ ] **Step 3: Confirm the store capped at 1000 and the file isn't bloating**

```bash
ls -la backend/data/otel-store.db
node -e '
const Database = require("./backend/node_modules/better-sqlite3");
const db = new Database("./backend/data/otel-store.db", { readonly: true });
console.log("traces:", db.prepare("SELECT COUNT(*) n FROM traces").get().n);
console.log("freelist_count:", db.pragma("freelist_count", { simple: true }));
console.log("auto_vacuum:", db.pragma("auto_vacuum", { simple: true }));
db.close();
'
```
Expected: `traces: 1000`, `auto_vacuum: 2`, and `freelist_count` small/bounded (the maintenance timer reclaims during quiet windows; may need a few seconds of idle).

- [ ] **Step 4: Measure the viewer render at 1000 traces**

In the preview: open `/otel-data`, Traces tab, time range "All". Use `preview_console_logs` (check for React warnings), `preview_snapshot` (confirm rows render), and exercise a filter toggle (Status dropdown) + a sort click. Capture `preview_screenshot`.
Expected: the list shows the window (header reads "… of … traces in window · most recent shown"); filter/sort interactions feel responsive (no multi-second freeze).

- [ ] **Step 5: Decide on the render gate**

- Smooth → done; no frontend change beyond Task 2. Note the observation (timings/screenshot) and **skip Task 7**.
- Janky (visible lag on filter/sort/scroll) → proceed to **Task 7**.

- [ ] **Step 6: Commit any verification notes (optional)**

If you captured timings worth keeping, add them to the spec's §8 or a short note; otherwise no commit.

---

## Task 7: (CONDITIONAL) Rendered-row cap — only if Task 6 Step 5 found jank

Keep all 1000 traces in memory (filters/search/charts need them); cap only the **rendered** rows. The Traces tab already shows a "most recent shown" header, so this fits the existing copy.

**Files:**
- Modify: `frontend/src/components/otel-data/TracesTab.tsx` (around `:60` sort memo and `:241` row map)

- [ ] **Step 1: Add a render cap and slice the rendered rows**

In `frontend/src/components/otel-data/TracesTab.tsx`, just below the `sortedTraces` `useMemo` (ends ~line 71), add:
```tsx
  // Render cap: keep the full sorted set for counts/sort, but only mount the
  // most-recent RENDER_CAP rows to keep the un-virtualized table responsive.
  const RENDER_CAP = 500;
  const renderedTraces = sortedTraces.slice(0, RENDER_CAP);
  const renderCapped = sortedTraces.length > RENDER_CAP;
```

Change the row map at line 241 from:
```tsx
              {sortedTraces.map(t => {
```
to:
```tsx
              {renderedTraces.map(t => {
```

- [ ] **Step 2: Surface the cap in the count header**

Find the header that renders "{traces.length} trace(s)" / "{n} of {total} traces in window" (around lines 164-167). Append a rendered-cap note when `renderCapped` is true, e.g. after the existing count text add:
```tsx
            {renderCapped && (
              <span className="text-gray-600" title="Showing the most recent rows for performance; filters and counts still use the full window.">
                {' '}· showing {RENDER_CAP.toLocaleString()}
              </span>
            )}
```

- [ ] **Step 3: Typecheck + build**

```bash
cd frontend && npm run build
```
Expected: passes.

- [ ] **Step 4: Re-measure in the preview**

Repeat Task 6 Step 4. Expected: filter/sort/scroll are now smooth.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/otel-data/TracesTab.tsx
git commit -m "feat(otel-data): cap rendered trace rows for a smooth 1000-trace window

Full window stays in memory for filters/counts; only the most-recent 500 rows
mount in the un-virtualized table.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Backend suite green:** `cd backend && npm test`
- [ ] **Frontend build green:** `cd frontend && npm run build`
- [ ] **Spec coverage:** incremental VACUUM (Tasks 3-4), 1000 window backend+frontend (Tasks 1-2), PRAGMA tuning (Task 3), docs (Task 5), render gate measured (Tasks 6-7). Micro-batch ingest intentionally not implemented (spec §7).
