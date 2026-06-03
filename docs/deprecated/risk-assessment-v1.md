# Helix Configurator — Risk & Weak-Point Assessment

## Context

You asked for a read-only assessment of stability, performance, usability, and functionality risks across the project. This is a report, not an implementation plan — nothing below changes code. Findings are prioritized P1 (ship-blocking / data-loss / security), P2 (significant degradation), P3 (polish). Items already tracked in `TODO.md` are marked `[known]`; the rest are new.

Three parallel Explore agents covered backend (stability/security), backend+frontend (performance), and frontend (usability/functionality). I spot-verified the highest-impact claims directly (auth comparison, wizard state persistence, TRACE_CAP).

---

## P1 — Critical

### Security

1. **Login password comparison is not constant-time** — [`backend/auth.js:75`](backend/auth.js:75)
   Uses plain `password !== process.env.UI_AUTH_PASSWORD`. Vulnerable to remote timing-side-channel inference. Verified. Fix: `crypto.timingSafeEqual` on equal-length Buffers, with a length-mismatch short-circuit *after* the compare (or hash both sides first).

2. **Path traversal in `writeFileViaBusyboxSidecar` host-mount resolution** — [`backend/routes/discovery.js:489`](backend/routes/discovery.js:489) → used at line 541-542
   `resolveHostMountPath()` returns the bind-mount `Source` unsanitized. If a target container's compose mount is attacker-controllable, smart-add can be coerced into writing arbitrary files on the host. Threat model is local-only today, but smart-add is *exactly* the feature that touches "files you didn't pick" — needs canonicalization + an allow-prefix check against the discovered container's expected config dir.

### Stability / data correctness

3. **Wizard step state is not persisted; refresh sends user back to Step 1** — [`frontend/src/App.tsx:23-24`](frontend/src/App.tsx:23)
   `isSetupComplete` and `setupStep` are `useState` only. There's a `helix-configurator.onboarded` localStorage flag (line 258/1631) but it's a *completion* flag, not in-progress state. Verified. Mid-wizard refresh re-runs bridge/verify with subtly different state.

4. **OTel ingest doesn't surface stream failures in the UI** — [`frontend/src/components/OtelDataPage.tsx:515-603`](frontend/src/components/OtelDataPage.tsx:515)
   `EventSource.onerror` only sets `setSseConnected(false)`. No toast, no "reconnecting…" pill, no retry CTA. User assumes "no traces" when really the backend or stream crashed. `[known]` — TODO.md #10 root-cause #3 calls this out ("Reconnecting… pill was removed when stream mode shipped — silent gaps now").

5. **Smart-add failures dismiss silently with no retry path** — [`frontend/src/components/Step2.tsx:42-50`](frontend/src/components/Step2.tsx:42)
   `smartAddProposal.error` evaporates after ~4s; user is left looking at the manual-snippet fallback with no signal that smart-add tried and failed. This actively pushes users toward the *more fragile* manual path (copy-paste into the wrong file is a recurring footgun).

### Performance — backend

6. **`/api/overview-bundle` serializes 6 full-table scans per request** — [`backend/routes/traces.js:151-192`](backend/routes/traces.js:151)
   Histograms (current + prior), overview headline, logs histogram, latency heatmap, service map — all sequential, all scanning. At the documented cap (500 traces / 20k logs) this is fine; the moment caps grow (see #7), bundle latency goes superlinear. Fan out with `Promise.all` and/or pre-compute buckets on ingest.

7. **`listTraces()` rolls up logs/errors/db-system via correlated subqueries per row** — [`backend/otelStore.js:625-641`](backend/otelStore.js:625)
   Three `(SELECT COUNT(*) FROM …)` subqueries per result row, one of which does `json_extract` on span attribute blobs. At 200-row default × 3 = 600 correlated subqueries per request. Default cadence is 30s. Replace with a single CTE or pre-aggregated columns; or denormalize `log_count`/`error_count` onto the traces row at ingest.

### Performance — frontend

8. **Live SSE + 30s polling double-write the trace list with O(n) array ops, no dedup** — [`frontend/src/components/OtelDataPage.tsx:512-603`](frontend/src/components/OtelDataPage.tsx:512)
   `setTraces(prev => [summary, ...filtered].slice(0, 200))` runs per SSE event. With Live mode + 30s poll, bursts trigger duplicate trace rows (no `trace_id` dedup) and trigger React reconciliation across the full list. Either dedup by `trace_id` in the SSE handler or short-circuit the 30s poll while SSE is healthy.

---

## P2 — High

### Backend stability

9. **Network attach failures during gateway recreate are logged-and-ignored** — [`backend/routes/lifecycle.js:85-94`](backend/routes/lifecycle.js:85)
   Recent commits (`81b8bfe`, `4b4787a`) moved network-attach *before* start — good. But an attach failure on a non-primary network is still warned-and-continued, so the gateway boots half-bridged and downstream collectors get connection-refused after Step 3 reports success.

10. **No timeouts on Docker daemon calls** — [`backend/routes/diagnostics.js:124`](backend/routes/diagnostics.js:124), [`backend/routes/lifecycle.js:102-110`](backend/routes/lifecycle.js:102)
    `container.restart()`, `listContainers()`, `inspect()` — all unbounded. A slow/wedged Docker socket hangs the Express handler up to the default 120s and the user sees a generic spinner. Wrap in `Promise.race` with a 10–15s deadline and surface "Docker socket slow/unreachable" specifically.

11. **`docker.listContainers()` runs on every collector-discovery refresh** — [`backend/routes/discovery.js:427`](backend/routes/discovery.js:427), [`backend/routes/diagnostics.js:410`](backend/routes/diagnostics.js:410)
    On a host with 50+ containers this blocks the event loop for 50–200ms per refresh. Cache for 3–5 min with explicit "refresh now" invalidation; current cadence is wasteful and not necessary for the wizard's needs.

12. **Unbounded `limit` accepted from query string into `listTraces()`** — [`backend/routes/traces.js:19`](backend/routes/traces.js:19) → [`backend/otelStore.js:639`](backend/otelStore.js:639)
    `Math.min(Math.max(1, limit | 0), TRACE_CAP)` clamps at the store layer, but only `TRACE_CAP=500`. A `limit=499` matched against a query that does the rollup subqueries (#7) is still 1500 subqueries per request. Combine with #7 fix.

### Performance — frontend

13. **Heatmap recomputes 720 cell colors and rerenders all SVG rects on hover** — [`frontend/src/components/Heatmap.tsx:43-220`](frontend/src/components/Heatmap.tsx:43)
    No `useMemo` on `colorFor`; `setHover` rerenders the whole SVG. Memoize colors keyed by `count`; render hover as a sibling overlay rect rather than re-emitting all cells.

14. **`TimelineChart` sorts each bucket on every render** — [`frontend/src/components/TimelineChart.tsx:82-141`](frontend/src/components/TimelineChart.tsx:82)
    60 buckets × sort-per-render. Cheap individually, painful when the parent re-renders on SSE events. Memoize the sorted buckets keyed by histogram identity.

### Usability / accessibility

15. **Form inputs miss `aria-invalid` / `aria-describedby` on validation errors** — [`frontend/src/components/Step1.tsx:78-94`](frontend/src/components/Step1.tsx:78) and siblings
    Screen-reader users don't hear errors until refocus. Wire `aria-invalid={!!err}` + `aria-describedby={errId}` and link the error `<p>` with that id.

16. **`ConfirmDialog` doesn't close on Escape** — [`frontend/src/components/ConfirmDialog.tsx:15-49`](frontend/src/components/ConfirmDialog.tsx:15)
    `useEscClose` hook exists ([`frontend/src/hooks/useEscClose.ts`](frontend/src/hooks/useEscClose.ts)) and is used elsewhere, just not wired here. Keyboard-only users are stuck unless they tab to Cancel.

17. **`AiopsPage` not gated on `IS_DEMO_INSTALL`** — [`frontend/src/components/AiopsPage.tsx`](frontend/src/components/AiopsPage.tsx)
    Backend returns 404 when the flag is false (correct), but the frontend exposes the route regardless, so disabling demo mode in prod leaves a dead-end UI. `[known, partially]` — TODO.md line ~191 mentions the dead-end risk.

18. **Empty-state on Overview is indistinguishable from loading-no-data** — [`frontend/src/components/OverviewTab.tsx:133-146`](frontend/src/components/OverviewTab.tsx:133)
    When `!loading && data && data.totals.spans === 0`, user sees "No overview data available yet" with no CTA (change time range / send a test trace / check gateway). The verify-flow already has a synthetic-trace button; reuse it here.

---

## P3 — Polish

19. **YAML smart-add fallback to `yaml.dump()` loses user comments** — [`backend/routes/discovery.js:370`](backend/routes/discovery.js:370). The text-patch path preserves formatting; the fallback silently rewrites the file. Surface in the diff preview which engine is being used.

20. **Toast cap of 3 hides older messages during error bursts** — [`frontend/src/App.tsx:36-40`](frontend/src/App.tsx:36). Smart-add → bridge → restart failures in quick succession lose the earliest one.

21. **Modal focus trap missing on `WizardModals`** — `aria-modal` not set, tab can escape behind the modal.

22. **SSE writes to closed streams in `routes/traces.js:88`** — heartbeat interval keeps writing on disconnect until the close event fires. Clear the interval inside the `close` listener.

23. **`otelStore` eviction strategy is correct but coarse** — [`backend/otelStore.js:554-565`](backend/otelStore.js:554). TRACE_CAP=500 is fine for a wizard tutorial, but the README ("View OTel Data" page is an APM-style viewer) sets the user's expectation higher. Either keep the cap and label the limit in the UI, or move the OTel store to a roll-up window (e.g. 15 min) and bound by time rather than count.

---

## Already-tracked items in `TODO.md` (no new finding, just cross-reference)

- **#2 SSE coverage for Overview charts** — Overview tab still polls; see #6/#8 above for the throughput implications.
- **#10 Streaming consistency** — covers #4 and the Operations-tab cadence concern.
- **#11 Finish backend modular split** — routes are already extracted; lifecycle.js/discovery.js are the remaining heavy files and they're where most P1/P2 backend findings concentrate.
- **#12 Vitest scaffold around `otelStore`** — only `__tests__/otelStore.test.mjs` exists today. Eviction and concurrent-ingest paths (relevant to #7 and the rollup rewrite) are untested.
- **#13 Validate Send-to-AIOps against a real tenant** — functional risk; out of scope for this audit beyond noting it.

---

## What I would do next if asked to act

Smallest-blast-radius fixes that buy the most:
1. **`auth.js`** → `timingSafeEqual` (15 lines, no behavior change).
2. **Wizard step persistence** → write `setupStep` to localStorage on change, hydrate in `App.tsx` init, clear on completion.
3. **SSE "reconnecting…" pill** — bring back the indicator TODO.md #10 already noted was removed.
4. **`listTraces` rollup rewrite** → one CTE; biggest single perf win.
5. **Docker call timeouts** → wrap in a shared `withDockerTimeout(15_000)` helper used across `routes/lifecycle.js`, `routes/diagnostics.js`, `routes/discovery.js`.

Everything else can wait or be folded into TODO.md items #10/#11/#12 work.

---

## Verification

This is an assessment, not an implementation. To verify any specific finding before acting:
- **#1 auth timing**: `grep -n "timingSafeEqual\|UI_AUTH_PASSWORD" backend/auth.js`
- **#3 wizard state**: open the UI, complete Step 1, refresh — confirm landing on Step 1.
- **#4 SSE silent failure**: `docker stop helix-gateway` while the OTel Data page is open in Live mode — confirm no toast, no banner.
- **#7 `listTraces` cost**: run `EXPLAIN QUERY PLAN` on the prepared statement at `otelStore.js:625-641` against a fixture with 500 traces; count correlated subqueries.

No tests need to run for the audit itself.
