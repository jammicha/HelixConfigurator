# 02 — Tie CPU / memory (resource metrics) to each trace

> **Handoff brief** · Priority: **High** · Created 2026-06-03 · Status: Not started
> Shape: **brainstorm brief** — James wants you to *research the best product fit*,
> not implement a pre-decided design.
> Read [`../ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) §4 (telemetry data flow) and §8
> (SQLite store) first.

## TL;DR

In the local trace viewer, show **resource utilization (CPU / memory / …) at the
time of a trace** — so when you open a slow trace you can also see "the host/
service was pinned at 95% CPU right then." James imagines OTLP metrics as the
source and a **utilization snapshot at the trace's timestamp**, but explicitly
wants you to **research what fits best** for source, storage, and what (if
anything) to push to Helix.

## Origin (demo feedback)

> "Someone asked if it would be possible to tie metrics like CPU/Memory, etc. to
> each trace in the local viewer."

James's steer: source is *probably* OTLP metrics but open; "a utilization
timestamp at the time of the trace is what I imagine"; and "we can explore what
gets pushed to Helix here too."

## Current state (the viewer renders traces/logs, not metrics)

- **Metrics already pass through the gateway but never reach the viewer.** In
  [`../../helix-otel-collector.yaml`](../../helix-otel-collector.yaml) the
  `metrics` pipeline is `receivers:[otlp] → processors:[batch] →
  exporters:[otlphttp/bmchelix]` — **only Helix.** Traces and logs get a second
  exporter (`otlphttp/helix_local_viewer`) that fans out to the configurator;
  **metrics do not.** ARCHITECTURE.md §4 states this explicitly: "Metrics still
  flow only to Helix — the local viewer doesn't render metrics, so no fan-out."
- **No metrics table in the store.** `backend/otelStore.js` has `traces`,
  `spans`, `span_errors`, `log_records` only (ARCHITECTURE.md §8). There is
  nowhere to land a metric series today.
- **The OTLP receiver handles traces + logs only.** `backend/routes/otlp.js`
  exposes `/api/otlp/traces` and `/api/otlp/logs`; there is no
  `/api/otlp/metrics`.
- **There IS already a metrics surface — but it's the wrong metrics.** The
  gateway exposes its own **Prometheus self-telemetry on :8888** (collector
  throughput, queue sizes), surfaced via `/api/diagnostics/metrics/live`,
  `frontend/src/hooks/useRawMetrics.ts`, and
  `frontend/src/components/RawMetricsModal.tsx`. That's *pipeline health*, not
  *application/host resource usage* — but the plumbing (poll → render) and a
  ready-made **`frontend/src/components/Sparkline.tsx`** are reusable.
- **Trace detail drawer** (`.../otel-data/trace-detail/TraceDetailDrawer.tsx`)
  already renders span-derived panels (service breakdown, SQL/HTTP rollups,
  waterfall/flame). A **"Resources" panel** would slot in naturally here.

## The crux: where do per-trace CPU/mem come from?

This is the real design decision. Lay out the options, prototype, recommend:

- **Option A — App-emitted OTLP runtime metrics.** Most auto-instrumentation
  runtimes emit `process.cpu.utilization`, `process.memory.usage`, JVM/GC, etc.
  Fan metrics out to the viewer, store a downsampled series keyed by resource +
  time, then in the drawer query the series for the trace's service over its
  `[start_time_ns, end_time_ns]` window. **Pro:** per-service, "real" app metrics.
  **Con:** only exists if the app is instrumented for metrics (couples to brief
  04); cardinality.
- **Option B — Collector-side receivers (works without app instrumentation).**
  Add a `docker_stats` receiver (and/or `hostmetrics`) to the gateway so it
  *produces* container/host CPU+mem regardless of whether the app emits metrics.
  Join trace → container/host via resource attributes (`container.id`,
  `host.name`, later `k8s.pod`). **Pro:** works for *any* app today in the Docker
  scenario; great parity story. **Con:** container-level, not per-request; join
  fidelity depends on resource attributes lining up. **Likely the lowest-friction
  first spike.**
- **Option C — Exemplars.** OTel's native trace↔metric link, but it runs
  *metric → trace* (a latency-spike data point carries a sampled `trace_id`). It
  answers "show me an example trace for this spike," **not** James's "show me CPU
  *during this* trace." Useful as a complement, not the core mechanism.

James's phrasing ("utilization at the time of the trace") = a **time-window join**
between a trace and a metric series → Option A or B, not exemplars.

## What "tie to each trace" could look like (UX to brainstorm)

- A **"Resources" strip** in the trace detail drawer: a CPU + memory `Sparkline`
  spanning the trace's wall-clock window, with the trace's start/end marked, plus
  a single "peak / at-T" number. Reuse `Sparkline.tsx`.
- Possibly an **inline badge** on the trace row ("CPU 95% during this trace") and
  a filter ("traces during high CPU").
- Stretch: overlay the resource series *under the waterfall* so you can see a GC
  pause line up with a slow span.

## Open questions & decisions (the research James asked for)

- **Source:** Option A vs B vs both? (Recommend spiking B first for universal
  coverage, layering A where the app emits runtime metrics.)
- **Storage & retention:** metrics are far higher volume than the 1000-trace cap
  model. Need a downsampled/windowed `metric_points` table or ring buffer, an
  eviction policy, and a sane resolution (e.g. 1–5s). Don't let it bloat the
  SQLite store.
- **Resource identity / the join key:** what reliably maps a trace to "the thing
  whose CPU we show"? `service.name` vs `container.id` vs `host.name` vs k8s pod.
  Get this right or the join is misleading.
- **Which metrics:** CPU utilization, memory RSS/working-set, maybe GC pause,
  fd/thread counts? Start narrow (CPU + mem).
- **Push to Helix?** Helix already receives metrics. The *new* value is the
  **trace_id ↔ resource-pressure correlation** — which is exactly the kind of
  signal that makes a richer Situation (**strong tie to brief 03**: "slow trace
  AND host at 95% CPU" is a probable-cause hint). Decide whether that correlation
  is computed locally only, or emitted to Helix.

## Constraints & known blockers

- **Store hygiene:** the SQLite store self-heals by wiping on corruption and has
  a 60s grace period on shutdown; a high-write metrics table must not jeopardize
  that. Consider a separate table/db or in-memory ring buffer with periodic flush.
- **Fan-out symmetry:** adding `otlphttp/helix_local_viewer` to the metrics
  pipeline means the receiver must decode OTLP **JSON** metrics (the fan-out uses
  `encoding: json`), mirroring how traces/logs are handled.
- Reading the live store with a read-write `sqlite3` CLI corrupts it — use the
  API or `?immutable=1` (existing project gotcha).

## Suggested first moves

1. **Spike Option B end to end on one app:** add a `docker_stats` receiver to the
   gateway, fan metrics to the viewer, prove CPU/mem for the app's container
   arrives.
2. Add `/api/otlp/metrics` (`backend/routes/otlp.js`) + a downsampled
   `metric_points` table in `backend/otelStore.js` (resource key, metric name,
   ts, value), with an eviction policy.
3. Add a **Resources panel** to `TraceDetailDrawer.tsx` that queries the series
   over the trace window and renders with `Sparkline.tsx`.
4. Validate the **join key** on real data; document which attribute lined up.
5. Write up the source A/B/C recommendation + the Helix-push decision for the team.

## Related prior art & files

- [`../../helix-otel-collector.yaml`](../../helix-otel-collector.yaml) — the
  metrics pipeline to extend (add the local-viewer exporter and/or `docker_stats`/
  `hostmetrics` receivers).
- [`../ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) §4 (metrics-not-fanned-out), §8
  (store schema + eviction).
- `backend/routes/otlp.js` (receiver to extend), `backend/otelStore.js` (schema).
- `frontend/src/components/Sparkline.tsx`, `.../hooks/useRawMetrics.ts`,
  `.../components/RawMetricsModal.tsx` (existing metrics render plumbing — note:
  these show *collector self-metrics*, not app/host resource metrics).
- `.../components/otel-data/trace-detail/TraceDetailDrawer.tsx` (where a Resources
  panel lands).
- **External:** OTel `docker_stats` / `hostmetrics` / `kubeletstats` receivers;
  OTel runtime metric semconv (`process.*`); exemplars spec.

## Cross-links

- **Brief 03 (AIOps):** the trace↔resource correlation is high-value Situation
  enrichment — coordinate what gets emitted.
- **Brief 01 (K8s):** in K8s the resource source becomes `kubeletstats`/
  `hostmetrics` — keep the metric model portable across Docker and K8s.
- **Brief 04 (auto-instrumentation):** Option A depends on the app emitting
  runtime metrics, which auto-instrumentation can turn on for free.

## How to use this brief

Brainstorm the **source question (A/B/C)** first — everything downstream
(storage, join key, Helix push) follows from it. Bias toward the option that
gives **coverage without requiring the customer to do anything** (Option B), then
enrich. Reuse `Sparkline` and the existing metrics-poll plumbing rather than
building fresh.
