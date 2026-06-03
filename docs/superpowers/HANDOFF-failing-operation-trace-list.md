# Handoff — "failing operation" subline on the Traces list

**Date:** 2026-05-31 · **Repo:** /Users/jammicha/dev/HelixConfigurator

## TL;DR status
Feature is **implemented, committed, and test-verified.** Not browser-verified. No PR opened.

- **Branch:** `feat/failing-operation-trace-list` — **1 commit ahead of `main`**, commit **`1e07ee5`**.
- **Verified (JSON reporters):** backend **201/201**, frontend **47/47**, `tsc --noEmit` **clean**.
- **Worktree:** clean except a **pre-existing, unrelated** change to
  `frontend/src/components/otel-data/trace-detail/SpanRow.tsx` — do NOT touch/commit it.

## What the feature does
An error row in the Traces list now shows the *originating error span's operation* as a muted
subline under the **Service** cell (e.g. `mysql` → `└ SELECT drivers`), so you see *what* failed,
not just *which* service. Shown only in the unfiltered (trace-level) view, for error traces, and
only when it adds info beyond the Root Operation column.

## Files in the commit (6)
| File | Change |
|---|---|
| `backend/otelStore.js` | `listTraces()` SELECT computes `failing_operation`/`failing_service` at **query time** via two correlated `COALESCE` subqueries. |
| `backend/__tests__/otelStore.test.mjs` | 4 tests under `describe('failing operation (listTraces)')`. |
| `frontend/src/components/otel-data/types.ts` | `failing_operation?` / `failing_service?` on `TraceSummary`. |
| `frontend/src/components/otel-data/utils.ts` | `failingOperationView(trace, serviceFilter)` helper. |
| `frontend/src/components/otel-data/utils.test.ts` | 6 tests under `describe('failingOperationView')` (self-contained trace factory). |
| `frontend/src/components/otel-data/TracesTab.tsx` | renders the subline inside the Service `<td>`. |

## Selection rule (mirrors `deriveProbableCause`)
Origin error span = **prefer a span carrying an exception event** (a `span_errors` row whose
`exception_type <> 'span.error'`, the status-only fallback), **latest-started**; else the
**latest-started `status_code >= 2` span**. `failing_operation`=its name, `failing_service`=its
service. Shared `ORDER BY start_time_ns DESC, span_id DESC` so both resolve to the same span.
Reference: `backend/routes/situations-payloads.js:163` (`deriveProbableCause`).

## Codebase facts worth NOT re-discovering
- Trace data is a **local SQLite store** (`backend/otelStore.js`), *not* a Helix proxy. No N+1,
  no remote dependency for this feature.
- `spans` table has `name`, `status_code` (2=error), `parent_span_id`; `span_errors` rows are
  derived from spans (exception events → real type; status-only error → `'span.error'`).
- `listTraces` builds SQL dynamically: base `SELECT t.* …`, plus `svcCte/svcSelect/svcJoin` when a
  service filter is active. The list route returns rows straight through (`res.json({ traces })`),
  so new SELECT columns flow to the frontend automatically.
- **`makeTrace` in `utils.test.ts` is scoped *inside* a `describe` block, NOT module-level.** Don't
  reference it from a sibling `describe` (that caused `ReferenceError: makeTrace is not defined`).
  The `failingOperationView` tests use their own inline trace literal — keep it that way.
- Frontend has **no RTL/jsdom** — tests are pure-function only (node env). No component-render tests.
- `docs/` is **gitignored** (this handoff + the design spec are local-only).
- Design spec (may still describe the abandoned recompute-denormalize approach):
  `docs/superpowers/specs/2026-05-31-failing-operation-trace-list-design.md`. **Implemented approach
  is query-time in `listTraces`** — the recompute-denormalize path stored NULL in practice.

## What's left
1. **Visual/browser verification** (not done). App needs full stack + synthetic error data, OR a
   mock-data Vite harness — precedent exists: `frontend/verify-waterfall.html` +
   `frontend/src/verify-waterfall.tsx` (untracked). A `verify-failing-op.*` harness was drafted but
   may not have persisted; recreate if needed.
2. **Open a PR** if desired (`gh pr create`).
3. Optional polish: tune subline styling (currently `text-danger-text/80`, mono, truncated,
   `title` carries the failing service).

## OPERATIONAL WARNING for the next session (this is why the last one burned ~30% of usage)
The tool layer in the prior session was **unreliable**: Bash stdout was intermittently corrupted
(doubled/repeated tokens) and some tool results were **fabricated** (fake "tests passing"
summaries, fake preview screenshots/a11y snapshots for runs that never executed). Guard against it:

- **Verify via JSON, read from a file.** Run `vitest --reporter=json --outputFile=/tmp/x.json`,
  extract counts with `node -e`, write to a `/tmp` file, then **Read that file** — Read-of-file was
  reliable; raw Bash stdout was not.
- **Confirm edits actually persisted.** `Edit`/`Write` sometimes reported success without sticking
  (and `git checkout`/cancelled batches reverted them). After editing, `grep -c` the file → write
  to `/tmp` → Read to confirm.
- **One tool call per message when a Bash might error.** A Bash that exits non-zero (e.g.
  `grep -c` with 0 matches) **cancels all sibling parallel calls** in that message. End diagnostic
  Bash with `true`; never batch `Bash` + `Read`.
- **Absolute paths only** in `cd` (a relative `cd backend` failed once cwd moved, triggering a
  cancellation cascade).
- **Never claim "verified" without a JSON count read back from a file.**

## Quick re-verify (copy/paste)
```
cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run --reporter=json --outputFile=/tmp/b.json >/dev/null 2>&1; node -e "const r=require('/tmp/b.json');console.log('BE',r.numTotalTests,r.numFailedTests)"
cd /Users/jammicha/dev/HelixConfigurator/frontend && npx vitest run --reporter=json --outputFile=/tmp/f.json >/dev/null 2>&1; node -e "const r=require('/tmp/f.json');console.log('FE',r.numTotalTests,r.numFailedTests)"; npx tsc --noEmit; echo "tsc=$?"
```
