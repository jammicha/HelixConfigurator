# HelixConfigurator — Deferred Work

Items called out during the Overview-tab build (PR `feat(otel-data): Overview
tab — APM-grade dashboard …`, commit `059c2f5`) that were left for follow-up.
Ranked by value × ease, top first.

---

## 1. Extract `TraceDetailDrawer` + waterfall subsystem

**Why:** `frontend/src/components/OtelDataPage.tsx` is still ~1724 lines.
About a thousand of those are the trace detail viewer (`TraceDetailDrawer`,
`Waterfall`, `RollupPanel`, `ServiceBreakdownPanel`, `FlameView`, `SpanRow`,
`SummaryCell`, `LogLine`, `SERVICE_PALETTE`, `colorForService`) — same
pattern as the sub-tabs we already pulled out into `components/otel-data/`.

**Plan:** Move the above into `components/otel-data/trace-detail/`. Pure
mechanical refactor, no logic changes. Drops `OtelDataPage.tsx` to ~700
lines.

**Risk:** Low. Same shape as the sub-tab extraction done in `059c2f5`.

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
- **`hasRealHelixEndpoint` guard on trace-row Helix deep-links.** Same
  fix we did on the dashboard buttons but for the in-table chevron
  links in Traces/Logs/Errors views. Currently they render unconditionally
  as long as `helixEnv.endpoint` is non-empty.
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

**ADAPT compliance** mirrors the rest of `/otel-data`: palette only, single-
hue ramps for line charts, no rainbow scales, no gradients, 4px radii. Icons
likely `LineChart`, `BarChart3`, `Gauge` from Lucide.

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
