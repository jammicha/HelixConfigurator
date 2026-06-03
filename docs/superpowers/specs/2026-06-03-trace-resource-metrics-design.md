# Per-trace resource metrics (CPU / memory) — v1 design

> Status: **Approved (design)** · Created 2026-06-03 · Source brief:
> [`docs/handoffs/02-trace-resource-metrics.md`](../../handoffs/02-trace-resource-metrics.md)
> Grounding: [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) §4 (telemetry data
> flow), §8 (SQLite store).

## Problem

In the local trace viewer, when you open a slow trace you cannot see what the
service's resources were doing at that moment ("the service was pinned at 95%
CPU right then"). Metrics already pass through the gateway but are exported to
Helix only — the viewer renders traces/logs, never metrics. There is no
`/api/otlp/metrics` receiver and no place in the store to land a metric series.

## Goals

- Show **CPU + memory utilization for the trace's service over the trace's
  wall-clock window** in the trace detail drawer.
- **Universal across environments** — must not be specific to Docker. The
  mechanism has to work identically on Docker, Kubernetes, a VM, or bare metal.
- Reuse existing plumbing (`Sparkline`, the OTLP receiver shape, the trace-query
  pattern) rather than building fresh.
- Keep the SQLite trace store's self-heal/corruption safety intact.

## Non-goals (v1)

Deferred to fast-follows (see end): the `hostmetrics` fallback for
un-instrumented apps, an inline trace-row badge, a "traces during high CPU"
filter, an under-waterfall overlay, pushing the trace↔resource correlation to
Helix (brief 03), and any on-disk persistence of metrics.

## Key decisions

### Source: app-emitted `process.*` runtime metrics over OTLP (brief's Option A)

The "universal" requirement is the deciding test — *will the metric reliably
join to a trace in any environment?*

| Source | Runs everywhere? | Join key | Verdict |
|---|---|---|---|
| **A — app `process.*` over OTLP** | ✅ rides the app's existing OTLP export | **`service.name` / `service.namespace`** | ✅ metric + trace share the same resource from the same SDK; `service.name` exists in every env |
| B — gateway `hostmetrics` | ✅ runs anywhere | `host.name` | ⚠️ app spans often lack `host.name`; in K8s the gateway measures its own node |
| B — gateway `docker_stats` / configurator polls Docker | ❌ Docker-only | container.id/name | ❌ fails the universal requirement |
| C — exemplars | n/a | runs metric→trace | ❌ opposite direction of what's wanted |

The mechanism is framed as **one source-agnostic OTLP-metrics ingestion path**
with a **pluggable producer**. v1's producer is the app's `process.*` metrics;
the viewer doesn't care who emitted them, so `hostmetrics`/`kubeletstats` can
feed the same store later. `service.name` (+ `service.namespace`) is the join
key because it is the only identity shared by a trace and its resource metric in
every environment.

This deliberately moves off the brief's "spike B first" suggestion: B's only
*universal* receiver (`hostmetrics`) has the weak join key, and its strong-join
receiver (`docker_stats`) is the Docker-specific one the universal requirement
rules out. A delivers universal coverage **and** a reliable join for the same
decode/fan-out plumbing cost. Its cost — "only exists if the app emits runtime
metrics" — is validated in Phase 0 and backfilled by the `hostmetrics`
fast-follow where an app emits nothing.

### Storage: in-memory ring buffer (not the SQLite store)

The brief allows "a `metric_points` table **or** ring buffer"; store hygiene
settles it.

- **Chosen — in-memory ring**, keyed `(namespace∥service) → metricName →
  [{tsNs, value}]`, bounded by age + max points per series. Zero disk writes, so
  it **cannot jeopardize the store's self-heal/corruption path**; eviction is
  trivial; volume is tiny (tens of services × 2 metrics × a few hundred points).
- **Rejected — `metric_points` in `otel-store.db`**: adds continuous write load
  to a store that wipes-on-corruption. Against the brief's store-hygiene caution.
- **Upgrade path if persistence is ever needed** (e.g. for the Helix-push
  follow-up): a **separate** `metrics.db`, never the shared `otel-store.db`.

Accepted trade-off: metric history is lost on configurator restart. Not
demo-critical, and bounded anyway — traces age out at the 1000-trace cap, so
only recent windows are ever queried.

### Surface: a "Resources" strip in the trace detail drawer

Reuse [`Sparkline.tsx`](../../../frontend/src/components/Sparkline.tsx). Two
sparklines (CPU %, memory) spanning the trace window with start/end marked, plus
a single peak / at-end number each. Graceful empty state when the service
emitted no `process.*` in the window.

## Architecture

### 1. Ingestion path (one source-agnostic pipe)

- **Gateway YAML** ([`helix-otel-collector.yaml`](../../../helix-otel-collector.yaml)):
  add `metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics` to the
  existing `otlphttp/helix_local_viewer` exporter and add that exporter to the
  `metrics` pipeline — mirroring exactly how traces/logs already fan out (JSON,
  `sending_queue` disabled, no retry). The `otlphttp/bmchelix` export to Helix is
  unchanged.
- **Receiver** ([`backend/routes/otlp.js`](../../../backend/routes/otlp.js)):
  new `POST /api/otlp/metrics`, public (above the auth gate, like the existing
  OTLP routes), reusing `decodeOtlpBody`.
- **Parser** (`extractMetricPoints(body)` in
  [`backend/otelStore.js`](../../../backend/otelStore.js), sibling to
  `extractSpans`/`extractLogRecords`): walks
  `resourceMetrics[] → resource.attributes (service.name/service.namespace) →
  scopeMetrics[] → metrics[]`, filters to the v1 allowlist, reads `gauge` and
  `sum` `dataPoints[]` (`timeUnixNano`, `asDouble ?? Number(asInt)`), and returns
  `{ resourceKey, metricName, tsNs, value }[]`.
- **v1 metric allowlist:** `process.cpu.utilization` (gauge, 0–1 fraction) and
  `process.memory.usage` (bytes). The allowlist (`RESOURCE_METRIC_NAMES`) is the
  single seam for adding alternate spellings. (See Risks for the
  `process.cpu.time` counter case.)

### 2. Store API (in-memory ring on the OtelStore instance)

- `ingestMetricPoints(points)` — append into the ring, prune per series by age
  (`METRICS_RETENTION_MS`, default ~1h, env-overridable) and a per-series point
  cap; defensively cap total series count.
- `getResourceSeries(traceId)` — look up the trace's service + window, return the
  CPU and memory point arrays sliced to `[startNs − pad, endNs + pad]` (pad ≈ 90s
  context, configurable — runtime metrics sample ~every 10s while traces are
  sub-second, so a tight window would yield ≤1 point), each with `peak` (max in
  window) and `atTrace` (last point at/just before `endNs`).

### 3. Query endpoint

`GET /api/traces/:traceId/resources` (auth-gated, alongside the other trace
queries in [`backend/routes/traces.js`](../../../backend/routes/traces.js)):
loads the trace's `service_name`/`service_namespace` + `[start_time_ns,
end_time_ns]`, calls `getResourceSeries`, returns:

```jsonc
{
  "window": { "startNs": ..., "endNs": ... },
  "cpu":    { "points": [{ "tsNs": ..., "value": 0.0–1.0 }], "peak": ..., "atTrace": ..., "unit": "ratio" },
  "memory": { "points": [{ "tsNs": ..., "value": <bytes> }],  "peak": ..., "atTrace": ..., "unit": "bytes" },
  "empty": false
}
```

Queried **once on drawer open** — the trace is historical, so its window is
fixed; no live streaming.

### 4. UX — `TraceDetailDrawer.tsx`

Resources strip slots in after the Summary cells / N+1 alert, before Service
breakdown. Two `Sparkline`s (CPU as %, memory bytes → human-readable), each with
the trace window marked and a peak / at-end figure. Empty state: a quiet "No
resource metrics for this service in this window — enable runtime metrics (or the
hostmetrics fallback)."

## Phased implementation

- **Phase 0 — validate the join (gate).** On live data, confirm the demo app
  emits `process.cpu.utilization` / `process.memory.usage` and that the metric's
  `service.name` matches the trace's. Document which attribute lined up (brief
  step 4). If an app emits nothing → that is exactly what the `hostmetrics`
  fast-follow backfills.
- **Phase 1 — ingestion.** YAML fan-out + `/api/otlp/metrics` +
  `extractMetricPoints` + ring (`ingestMetricPoints`). Unit-tested.
- **Phase 2 — query/join.** `getResourceSeries` + `GET
  /api/traces/:traceId/resources`. Unit-tested.
- **Phase 3 — UX.** Resources strip + empty state in `TraceDetailDrawer.tsx`.
- **Phase 4 — verify + write up.** End-to-end check via the preview workflow;
  write the A/B source recommendation + the join finding for the team (brief
  step 5).

## Testing

- Unit (extend [`backend/otelStore.test.js`](../../../backend/otelStore.test.js)):
  `extractMetricPoints` over a sample OTLP-metrics JSON payload (gauge + sum,
  multiple resources, allowlist filtering, `asInt`/`asDouble`); ring eviction
  (age + per-series cap); `getResourceSeries` window slice + `peak`/`atEnd`.
- `tsc --noEmit` for the frontend.
- `preview` check of the panel against injected metric data.

## Risks & mitigations

- **App emits no `process.*`** → empty panel. Mitigation: `hostmetrics`
  fast-follow; the empty state degrades gracefully in the meantime.
- **CPU exposed as `process.cpu.time` (counter, seconds) instead of the
  `process.cpu.utilization` gauge** → utilization needs a rate computation. A
  Phase-0 finding; if present, Phase 1 adds a delta/interval rate for that series.
- **`service.name` on the metric ≠ the trace's** (e.g. a collector relabels) →
  Phase 0 catches it; adjust the resource key accordingly.
- **In-memory loss on restart** → accepted; bounded by the trace window.

## Fast-follows (explicitly out of v1)

1. `hostmetrics` (and K8s `kubeletstats`) producer into the same ring — universal
   coverage for un-instrumented apps; needs a host/pod join key.
2. **Helix push** — emit the trace↔resource-pressure correlation ("slow trace AND
   95% CPU") to Helix to enrich a Situation (brief 03).
3. Inline trace-row badge ("CPU 95% during this trace").
4. "Traces during high CPU" filter.
5. Resource series overlaid under the waterfall (GC pause vs. slow span).
6. Persistence via a separate `metrics.db`.

## References

- Brief: [`docs/handoffs/02-trace-resource-metrics.md`](../../handoffs/02-trace-resource-metrics.md)
- [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) §4, §8
- Files: `helix-otel-collector.yaml`, `backend/routes/otlp.js`,
  `backend/otelStore.js`, `backend/routes/traces.js`,
  `frontend/src/components/Sparkline.tsx`,
  `frontend/src/components/otel-data/trace-detail/TraceDetailDrawer.tsx`
- External: OTel runtime metric semconv (`process.*`); `hostmetrics` /
  `kubeletstats` receivers (fast-follow).
