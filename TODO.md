# HelixConfigurator — Deferred Work

Items called out during the Overview-tab build (PR `feat(otel-data): Overview
tab — APM-grade dashboard …`, commit `059c2f5`) that were left for follow-up.
Implementation items ranked by value × ease, top first. Strategic open
questions appear at the bottom — those gate everything else if they
resolve in a way that changes the project's scope.

---

## 1. Extract `TraceDetailDrawer` + waterfall subsystem — DONE (2026-05-12)

**Status:** Shipped. Subsystem extracted into
`components/otel-data/trace-detail/` (TraceDetailDrawer, Waterfall +
SummaryCell + RollupPanel + ServiceBreakdownPanel, SpanRow, FlameView,
LogLine, palette). `OtelDataPage.tsx` dropped from 1929 → 901 lines.

---

## 2. SSE coverage for the Overview charts

**Why:** `/api/traces/stream` already pushes new traces, errors, and logs to
the lists in real time, but the volume timeline, stat cards, heatmap, and
service map only refresh on the page-wide polling interval (default 60s).
A burst of errors between poll ticks doesn't reflect on the chart — the
chart looks calm while the trace list is on fire.

**Plan:**
- Backend: extend the existing SSE channel to emit incremental
  histogram/stat deltas on each ingest. New event types like
  `overview_delta` carrying `{ bucketIdx, ok, slow, error, p95 }`.
- Frontend: `useOverview` merges deltas into its cached bundle between
  polls. Periodic full-refresh from the bundle still serves as the
  source of truth.

**Risk:** Moderate. SSE bursts can be noisy; will need throttling
(coalesce sub-second deltas into a single push).

**Reframe (per #6 resolution):** When live updates fire on the volume
timeline / stat cards, surface a small "View live in Helix AIOps →"
deep-link next to the live-stream pill. Live wow factor channels into
AIOps; it doesn't replace it.

---

## 3. Cross-correlated insights (Davis-style)

**Why:** The four insight rules in `otelStore.insights()` fire
independently. Adding the empty positive state and the `ongoing` tag helped
the surface feel less alarm-y, but the rules still look like alerts dressed
up as narrative. A real Davis-style narrator correlates signals across
services and across time.

**Plan:** Two new rule passes over the existing data:
- **Simultaneity:** latency spike AND error spike AND throughput dip in
  the same window → emit a combined "possible incident on `<service>`"
  finding instead of three separate findings.
- **Ordering:** anomaly A preceded anomaly B by N minutes → emit a
  "cascading from A to B" finding. Requires keeping a small ring buffer
  of finding history (or recomputing from per-bucket history).

**Risk:** Low. No ML. Just rule passes over existing data.

**Reframe (per #6 resolution):** Every insight card (existing four +
the two new rules) ends with an "Investigate `<service>` in Helix
AIOps →" footer when a real Helix endpoint is configured. Insights
become a launching pad, not a self-contained finding.

---

## 4. Backlog — lower-priority items

Bundled together because each is small and none is independently urgent:

- **Drill from a heatmap cell to one example trace** (Stackify-style
  "show me the slowest trace in this bucket"). Today we drill into a
  filtered Traces list; one click to find a representative trace would
  be a small improvement.
- **Force-directed service map layout** for cyclic topologies. Today's
  layered layout assumes DAG; mutual service calls degrade visually.
  ~80 LOC of Fruchterman-Reingold or similar.
- **Window-resolution helper DRY.** Five endpoints
  (`overview`, `traces/histogram`, `logs/histogram`, `latency-heatmap`,
  `service-map`, `insights`) reuse the same `start`/`end` defaulting
  logic. Factor out to one helper.
- **Pause polling during hover/interaction.** If a poll fires while the
  user is hovering a chart tooltip, the chart re-renders and the tooltip
  dismisses. Pause polling for ~1s after mouse activity.
- **"Clear store" UI affordance.** Useful for demos ("start fresh"). One
  button → `docker compose down -v` semantics via a backend route.

---

## 5. OTel-native metrics visualization

**Status:** Lower priority for now. Captured so we don't re-discover the
analysis next time.

**Current state:** The gateway already accepts OTLP metrics on 4317/4318
and forwards to Helix. The local fan-out (`otlphttp/local_store`) does NOT
include metrics today — only `traces_endpoint` + `logs_endpoint` are wired,
so metrics are dropped on the configurator side. The Overview tab's
throughput / error-rate / p95 stats are derived from traces, not from real
OTLP metrics.

**Approaches considered:**

- **A. Derive from traces (RED-from-traces).** Build a "Metrics" view that's
  per-service RED panels, per-operation latency distributions, and similar
  trace-derived analytics. Reuses existing SQLite trace store. Captures ~80%
  of what people look at on a metrics dashboard. **No new infra.** *Effort:*
  1-2 days. *Risk:* low — same patterns as Overview.

- **B. Lightweight OTLP metric ingest + viewer.** Add `/api/otlp/metrics`,
  a `metric_samples` SQLite table with count cap (same discipline as logs),
  and a new "Metrics" tab. Adds `metrics_endpoint` to the gateway's local
  fan-out. Renders catalog (one row per name+label-set with sparkline) and
  per-metric line charts; histograms as stacked-band view. **Captures
  app-emitted custom metrics + runtime metrics** (heap, GC). *Effort:* 3-5
  days. *Hard parts:* cardinality cap (label like `user_id` fans into
  millions of series), OTel exponential histogram rendering, delta-vs-
  cumulative counter semantics, aggregation across labels.

- **C. Embed Prometheus + Grafana.** Drop a real TSDB into compose, iframe
  Grafana for visualization. *Rejected:* abandons the standalone-single-
  binary feel; iframing Grafana is "we gave up."

- **D. Forward-only + deep-link to Helix.** No local viz; surface "View
  metrics for this service in Helix" links. *Rejected:* breaks demo
  isolation — can't show metrics without a working tenant.

**Recommended path:** Start with A whenever this becomes top-priority. Only
do B if there's a specific app-emitted metric a demo needs to show that
isn't trace-shaped.

**Reframe (per #6 resolution):** Whichever path ships, the Metrics tab
header carries an "Open metrics in Helix AIOps →" CTA, and per-service
panels include a deep-link to that service's AIOps metrics view.

**ADAPT compliance** mirrors the rest of `/otel-data`: palette only, single-
hue ramps for line charts, no rainbow scales, no gradients, 4px radii. Icons
likely `LineChart`, `BarChart3`, `Gauge` from Lucide.

---

## 6. Strategic positioning — RESOLVED

**Status:** Resolved. Decision recorded here so it doesn't get re-litigated.

**Slogan:** *Hybrid — Preflight for AIOps, with escape hatch.*
`/otel-data` is positioned as a preflight verifier on the way to Helix
AIOps. It stays full-fidelity locally so it remains useful in offline /
air-gapped / demo-without-tenant contexts (the escape hatch), but every
overlap surface deep-links to its richer AIOps equivalent.

**Per-surface stance (status quo on cede — nothing is removed or
downgraded):**

| Surface | Stance |
|---|---|
| Overview RED cards, sparklines | Bridge — full-fidelity + Helix CTA |
| Trace list + waterfall | Bridge — promote existing "View in Helix" |
| Operations table | Bridge — add row-level Helix link |
| Logs & Errors | Bridge — fix `hasRealHelixEndpoint` guard on chevrons |
| Service Map | Bridge — full-fidelity + Helix CTA, force-directed layout still in scope |
| Latency Heatmap | Bridge — full-fidelity + Helix CTA |
| Davis-style insights | Bridge with reframe — see #3 |
| Receiver counters, app-export errors, synthetic injection, N+1 detector | Own — surface health via Overview banner; details stay in Diagnostics |
| Demo install bundle | Own — see #7 |

**What this changes elsewhere in this doc:**
- #2 (SSE) and #3 (correlated insights) ship as planned, with AIOps
  CTAs added (see "Reframe" notes on each).
- #5 (metrics viz) ships path A with AIOps CTAs (see "Reframe" note).
- #4 backlog stays as-is — force-directed map, heatmap drill, etc. all
  remain in scope because cede stance is status quo.
- New items #8 and #9 below capture the positioning-specific work.

---

## 7. Make the demo/real plumbing boundary explicit in code

**Status (2026-05-12):** Steps 1 and 3 substantially shipped. Step 1
(commit `60581c3`) moved every AIOps install/demo route under
`/api/_demo/aiops/...` — frontend `AiopsPage`, the generated
bash/PowerShell installer scripts, and the four route handlers all
updated. Step 3 (commit `09efe65`, on `refactor/backend-modular-split`)
moved the AIOps simulator (all the `render*` functions,
`SIMULATED_INGEST_ENDPOINT`, `writePackageToArchive`, `aiopsSessions`)
out of `index.js` into `backend/routes/demo.js`. What remains: step 2
(env-flag gate), step 4 (README addendum), step 5 (optional separate
compose service — overkill flag).

**Original framing — code hygiene; matters more the longer this codebase lives.**

**The concern:** Routes labeled as demo simulations (`/api/aiops/configure`,
`/api/aiops/package/:token`, `/api/aiops/install/:token.{sh,ps1}`) sit
structurally beside real product routes. The SIMULATED prefix is only in
comments; the routes are at the same URL namespace, the handlers look
the same, the install bundle includes the simulated `FAKE-KEY-...` API
key. A new contributor reading the file has no syntactic signal which
half is the demo. Worse: the line gets harder to draw as the codebase
grows, and at some point someone treats a demo path as real (or vice
versa) and ships a bug.

**Plan (incremental, each step independently shippable):**

1. **Namespace prefix.** ✅ DONE (2026-05-12, commit `60581c3`). All
   AIOps install routes moved to `/api/_demo/aiops/*`; the generated
   bash/PowerShell installer scripts reference the new path. The
   underscore prefix is conventional for "internal / non-product"
   namespaces (Google APIs, Kubernetes).
2. **Env flag.** Add `IS_DEMO_INSTALL=true` to `.env.example`. Gate the
   `/api/_demo/*` routes behind it — return 404 when the flag is false.
   Default to true for the in-repo `.env` so existing demo flows keep
   working. When a customer eventually runs this in a real environment,
   they set it false and the demo plumbing is invisible. With step 3
   done, this is now a small change: wrap the
   `require('./routes/demo').register(...)` call in `index.js` in an
   env-flag check.
3. **Move the AIOps simulator to its own module.** ✅ DONE (2026-05-12,
   commit `09efe65`). All the `render*` functions, `SIMULATED_INGEST_ENDPOINT`,
   `writePackageToArchive`, `aiopsSessions` now live in
   `backend/routes/demo.js`. Conditional registration based on the
   step-2 env flag is what's left.
4. **README addendum.** New section explaining: what is the demo
   plumbing for, what does it simulate, what should be replaced in a
   real-product context (a real AIOps page would generate the install
   command, not us; a real Helix tenant would supply the endpoint not
   the placeholder, etc.).
5. **(Stretch) Separate compose service.** A `helix-configurator-demo`
   container alongside the real one, only present when running the
   demo flow. Definitely overkill for now — flag for when the rest
   above feels insufficient.

**Risk:** Low. Each step is non-breaking if the env flag defaults to
true. The hardest part is finding every route handler that's "demo
only" — some are obvious (`/api/aiops/configure`), some are subtler
(the `/api/health` endpoint exposes the SIMULATED_INGEST_ENDPOINT in
its response).

**What I'd watch for:** the fan-out exporter in
`helix-otel-collector.yaml` (`otlphttp/helix_local_viewer`) ALSO needs
to be evaluated. It exists for the demo's local-trace-viewer pattern.
In a real-product world, would it ship? Probably yes (local /otel-data
is useful) but it's worth being explicit that this is part of the
configurator's standalone story rather than something AIOps mandates.

---

## 8. Helix CTA promotion (positioning follow-on)

**Status (2026-05-12):** Partially shipped. The trace detail drawer
now carries a prominent "Send to AIOps" / "Send anomaly to AIOps"
button that converts the trace into a Helix Event via the Events API
(commit `d9fb3de`). The drawer also has a one-time "Provision event
class" affordance on Settings. The remaining items are smaller and
ship independently.

**Why:** Helix deep-links / actions on `/otel-data` should be
unmissable on every Bridge surface. The drawer is now covered; the
Overview header and per-surface chrome aren't.

**Still pending:**
- **Overview banner:** When `helixEnv.endpoint` and `helixEnv.tenantId`
  are both set and non-placeholder, render a top-of-Overview banner:
  "Telemetry is flowing — continue in Helix AIOps →" linking to the
  AIOps landing page for the configured tenant. Dismissible
  per-session, not per-forever.
- **Per-surface CTAs:** On each Bridge surface header (Operations,
  Service Map, Heatmap), a small "Open full view in AIOps →" link.
  Same `hasRealHelixEndpoint` guard as elsewhere.
- **Trace-row chevrons:** ✅ DONE (2026-05-12, commit `8b4d277`).
  `buildHelixTraceUrl` now checks `hasRealHelixEndpoint` internally
  so every caller's existing `if (!url) return null;` is automatically
  the guard. TracesTab's column-header gate tightened to
  `hasRealHelixEndpoint(helixEnv)` too.
- **Insights cards → AIOps:** the #3 "Reframe" note (Investigate
  `<service>` in Helix AIOps →) hasn't shipped yet — wire that up at
  the same time as the per-surface CTAs.
- **Send-to-AIOps polish (the feature shipped today, commit `d9fb3de`).**
  Three follow-ups worth tracking: (a) after a successful send, render
  a "View this event in AIOps →" link in the drawer using the
  upstream-returned event id (the events API response carries it);
  (b) keep a small retry/error log in the drawer so failed sends can
  be inspected without a page reload; (c) revisit the severity rule
  (CRITICAL on error / MAJOR on outlier / MINOR otherwise) once we
  have feedback from a real Helix tenant on whether MAJOR vs MINOR
  feels right for traces that aren't anomalous but were sent manually.

**Risk:** Low. The banner is the only new affordance; everything else
is a guard fix or a one-line link.

---

## 9. Preflight health banner (positioning follow-on)

**Why:** The "Own" surfaces (receiver counters, app-export error scan,
synthetic injection results, N+1 detection) currently live in the
Diagnostics tab. Under the Preflight positioning these are the unique
value of `/otel-data`, but they're invisible unless the user navigates
to Diagnostics.

**Plan:**
- Compute a rolled-up preflight status from existing data:
  - Receiver `refused_*` counters (warn if non-zero)
  - App-export error scan (warn if any container in the last N minutes)
  - "No traces seen in last 5 minutes" (warn)
- Render at the top of Overview:
  - **Green state:** compact "Preflight ✓" pill.
  - **Degraded state:** full-width banner with the failing checks and
    a "View in Diagnostics" link.
- No new backend data needed — both `/api/diagnostics/receiver-counters`
  and `/api/diagnostics/app-export-errors` already exist. New frontend
  hook aggregates them.

**Risk:** Low. New surface but no new data plumbing. Visual only.

**Sequencing note:** Ships alongside #8 since both live on Overview
and together establish the "Bridge with prominent CTA + Own surface
visibility" pattern that defines the Preflight positioning.

---

## 10. Streaming consistency — diagnosis

**Symptom (from review):** "OTel data doesn't seem to stream in very
consistently."

**Status (2026-05-12):** Partially mitigated by the unified stream
mode (commit `e74e77b`). Users can now pick `Live / 30s / 1m / 5m /
Paused`, so the "quick win" of shorter polling is now self-service —
no more hardcoded 60s. Live mode = SSE + 30 s rollup poll. Background
tab throttling and SSE reconnect gaps (causes 5 and 3 below) are
unchanged. The dominant cause (#1) is still pending and requires #2.

**Root causes, ranked by likely impact:**

1. **Overview surfaces are polled, not pushed.** SSE
   (`/api/traces/stream`) only emits `trace`, `error_record`, `log`,
   `trace_counts_update`. The Overview stat cards, volume chart, latency
   heatmap, and service map all come from `/api/overview-bundle`, which
   is polled on the page-wide `usePageRefresh` cadence. The trace
   *list* feels live (SSE) but every aggregate visualization is at
   best 30 s stale. Fix path: item #2 in this doc (SSE coverage for
   Overview charts). The stream mode UI partially mitigates by letting
   the user pick a faster poll, but the underlying mismatch remains.
2. **Collector batches with `timeout: 1s, send_batch_size: 1024`**
   (`helix-otel-collector.yaml`). Traces arrive in ≤1s bursts, not
   continuously. Looks jagged on a high-resolution timeline.
3. **No replay on SSE reconnect.** Server doesn't set `id:` on events
   and ignores `Last-Event-ID`. When the browser auto-reconnects after
   a network blip or tab-throttle, anything emitted during the gap is
   missing from the live list (still in the backend store). The
   "Reconnecting…" pill that surfaced this state was removed when
   stream mode shipped — silent gaps now, no UI signal of an active
   reconnect. (Worth restoring the badge if SSE reliability becomes a
   recurring complaint.)
4. **Operations tab polls every 60s.** Unchanged — Operations refresh
   doesn't yet honor stream mode for its private interval (the cadence
   is hardcoded inside `refreshOperations`'s `setInterval`). Same lag
   class as Overview but more visible because Operations is a
   deep-dive surface.
5. **Backgrounded-tab throttling.** `usePageRefresh` pauses polling
   when `document.visibilityState === 'hidden'` (correct), but SSE is
   browser-throttled in background tabs too. Coming back from a long
   background period shows stale data until the next foreground poll.
6. **No write-backpressure handling on SSE.** `res.write()` returns
   false under TCP backpressure but the server keeps queuing. A slow
   client would stall the event loop. Probably not the user's issue
   but worth knowing.

**Recommended fix path:**
- Medium: ship #2 (SSE coverage for Overview charts) and have
  Operations honor the stream-mode cadence (or get its own SSE).
- Optional: add SSE `id:` + `Last-Event-ID` replay on reconnect.
- ✅ Restore a "reconnecting…" indicator. DONE (2026-05-12, commit
  `cbe6ee8`): a 1.5×1.5 dot next to the Stream selector — cyan +
  pulsing when SSE is connected, warning yellow when reconnecting.
  Hidden in snapshot modes (which don't use SSE).

---

## 11. Finish the backend modular split

**Status (2026-05-12):** ~half done. Branch `refactor/backend-modular-split`
merged to `main` (commits `14da0bc` → `09efe65`) dropped `backend/index.js`
from 3427 → 1579 lines (−54%). Six route modules + three cross-cutting
modules carved out: `util.js`, `auth.js`, `validate.js`,
`routes/{situations,otlp,env,config,traces,demo}.js`.

**Still inline in `index.js` (~31 routes across 4 logical modules):**

- **`routes/lifecycle.js`** (6 routes): `/api/lifecycle/{restart,start,stop,
  bridge,bridge-network,restart-container,status}`. Shares the
  collector-restart-and-watch pattern with `routes/config.js` —
  `waitForGatewaySettle` is a candidate to lift back out into a shared
  helper (`backend/gateway.js`?) when the second copy lands here.
- **`routes/discovery.js`** (3 routes): `/api/discovery/{collectors,
  collector-config/:name,collector-apply/:name}`. Small, clean carve.
- **`routes/containers.js`** (7 routes): `/api/services`,
  `/api/containers{,/full,/inspect/:name,/attach,/disconnect}`. Uses
  `isValidContainerName` (already in `util.js`).
- **`routes/diagnostics.js`** (10 routes): `/api/diagnostics/*`. The
  most tangled of the remaining four — `debugTimer` /
  `revertDebugMode` toggle helpers, the live-log SSE stream that
  touches `activeLogProcesses` (declared at the top of `index.js`),
  receiver-counter probes, app-export-error scans, the inject-trace
  synthetic-telemetry path.

**Sequencing for the follow-up session:** discovery (smallest, cleanest)
→ containers → lifecycle (some shared-helper extraction needed) →
diagnostics (deserves its own focused pass). Each module is independently
shippable. After all four, `index.js` should be ~250-300 lines — pure
app setup + middleware ordering + module registration.

---

## 12. Vitest scaffold around `otelStore`

**Why:** The trace store is the surface that's been most recently
buggy this quarter — the internal-service filter, the SSE service-filter
merge, the lifetime-vs-windowed services dropdown, the search-q server-side
move. None of those regressions had a test that would have caught them.
The honest assessment in this session was that any non-trivial refactor
of this codebase is brittle without tests, and `otelStore` is the
highest-value place to start because (a) it's a single well-bounded
module, (b) it has clear invariants (TRACE_CAP=500, log retention cap,
the participant-vs-root filter), and (c) the route handlers are now
mostly thin shims over it after the modular split.

**Plan:**

- Add `vitest` to `backend/package.json` devDependencies. Or
  `node:test` if avoiding the dep is preferred — both work for a
  thin Node-only integration layer.
- Test invariants first, not happy paths:
  - `ingestSpans` enforces the 500-trace cap (write 600 traces, assert
    500 remain).
  - `listTraces` filters out all-internal traces via the "any
    non-internal participating span" rule (write a trace whose root
    is `helix-gateway` but with a downstream `customer-app` span —
    must appear).
  - `listServices` is lifetime, not windowed (write a trace, advance
    time, assert the service still appears in the dropdown).
  - SSE `participating_services` tagging on emitted summaries.
  - Slow-threshold plumbing through `tracesHistogram` + `listOperations`
    (write traces at 800/1200ms, query with `slowThresholdMs=1000` →
    one slow; query with `slowThresholdMs=500` → both slow).
- Backend-only — no Express, no docker. Tests construct `OtelStore`
  directly with an ephemeral in-memory SQLite (`:memory:`) and drive
  it through `ingestSpans` / `ingestLogs`.

**Risk:** Low. No new runtime code; tests can be added incrementally
and run on a developer machine before being wired into CI.

**Sequencing note:** Land this before #5 (OTel metrics ingest) — that
work doubles the store's surface area, and we don't want to ship more
untested code in this area.

---

## 13. Validate Send-to-AIOps against a real Helix tenant

**Status:** Not code work — user-test the feature that shipped today
(commit `d9fb3de`) against a live tenant before extending it.

**What to verify:**

- **Dedup behavior.** Provision the `OTEL_TRACE_ANOMALY` event class
  via the Settings button. Send the same trace twice from the
  drawer. Expected: BMC's auto-dedup matches on `helix_trace_id` and
  updates the existing Event instead of creating a duplicate. If it
  doesn't, check that the class definition's `helix_trace_id` slot
  is flagged `dup_detect=true` and `mandatory=true` (see
  `routes/situations.js` `provision-class` handler).
- **Severity classification.** Send an error trace → confirm
  severity=CRITICAL appears in AIOps. Send an outlier (duration > 2×
  the operation's p95) → confirm severity=MAJOR. Send a normal trace
  → confirm severity=MINOR. The frontend supplies the operation's
  p95; mismatched p95 between Operations tab and what's sent would
  surface here.
- **Business-service pin.** With `BUSINESS_SERVICE_KEY` set and the
  trace's `service.name` matching multiple AIOps Business Services
  (the duplicate-event scenario the comment in `routes/situations.js`
  references), confirm the Event lands on exactly one Business
  Service via the `service_id` / `business_service_key` slots.
- **`HELIX_EVENTS_ENDPOINT` fallback.** Tenants where ingest and
  portal share a host should work with `HELIX_ENDPOINT` alone; those
  with separate hosts need `HELIX_EVENTS_ENDPOINT` set. Verify both
  paths.

The polish items in #8 ("View in AIOps" link, retry log, severity
refinement) hinge on what this validation surfaces. Don't extend the
feature before validating it.

---

## What was deliberately NOT added

For the record, so these don't get re-proposed:

- **Statistical learned baselines** (real anomaly detection vs the
  current cosmetic μ ± σ). Separate product.
- **Multi-tenancy / multi-dashboard / edit mode / dashboard JSON
  import-export.** Not a fit for a single-tenant OTel sidecar.
- **KQL/NRQL/DQL query language.** Existing filters cover the common
  cases; building a real parser is a project.
- **Mobile / narrow-screen support.** Real audience is on laptops.
- **Alerting / notifications.** Explicitly declined.
- **Tests for the Overview surface.** Premature while rules and
  components are iterating fast.
- **PurePath-style always-on traces** (no sampling). Incompatible with
  the existing 500-row count cap.
