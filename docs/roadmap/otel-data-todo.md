# /otel-data — Backlog

## Open

### Auto-detect upstream stalls (banner)
The Diagnostics menu now lets you manually restart an upstream OTel collector
when its `memory_limiter` trips, but you have to notice the symptom first.
Auto-detect by tracking helix-gateway's `otelcol_receiver_accepted_spans_total`
rate over time: if the rate falls to zero for ≥2 minutes while the SSE pill
still shows Live, surface a yellow banner on `/otel-data` saying *"Gateway
hasn't received traces in 2 minutes — upstream collector may be back-pressured"*
with a one-click **Restart [collector-name]** CTA reusing
`/api/lifecycle/restart-container`.

False-positive risk (no traces could mean no traffic) is real but the
2-minute idle threshold is a reasonable trade-off. Backend addition: a
small in-memory rate tracker on the receiver counter scrape that's already
running. Frontend addition: poll a new `/api/diagnostics/stream-health`
endpoint every 30s and render the banner when stalled.

## Shipped log

For posterity, the work that closed out the previous backlog items:

### Trace list / discovery
- URL state for filters + selected trace (shareable, reload-resilient)
- Free-text search across `root_operation`, `service_name`, `trace_id`
- Min-duration preset filter
- Per-tab pause toggle (Stream pill in the filter row)
- Click-to-deep-link from the operation cell
- Internal-services filter (helix-gateway / configurator / verify)
- Status filter (Error / Slow / OK)
- Trace-level rollup count badges (errors / DB / logs) inline next to service
- Outlier badge for traces > 2× p95 of their operation
- Helix deep-link per trace row + drawer (with BMC chevron)

### Trace detail (drawer)
- Service breakdown panel (wall-clock per service, merged intervals)
- SQL rollup panel (group by `db.system + statement|operation`, count + total + slowest)
- HTTP outbound rollup panel (group by `method + normalized url`, status pills)
- N+1 detection alert (already existed; folded into the same area)
- DB-call panel for spans missing `db.statement` (Redis/Valkey/.NET case)
- Span-level log indicator (count badge tinted by max severity)
- CRISP-accurate critical path (darker overlay on blocking portion only)
- "Critical path only" toggle in waterfall header
- Flame graph view (Waterfall ↔ Flame toggle)

### Logs & Errors tab
- Logs sub-tab (severity filter, body+service search, click-to-jump-to-trace)
- Backend `/api/logs` cross-trace endpoint
- Error grouping by `exception_type × service_name` with sample expander
- Toggle between Grouped and Flat view
- Exception/error dedup fix (no more double-counting when status=ERROR + exception event)
- Per-span error rows replaced on re-ingest (no accumulation on retries)

### Operations tab
- New top-level tab between Traces and Logs & Errors
- Per (service + root_operation) aggregates: count, p50, p95, max, error rate, slow rate
- Sortable columns; click an operation to jump to filtered trace list

### Live updates
- `trace_counts_update` SSE event (errors / DB / logs counts merge into existing rows in real time)
- `log` SSE event for the Logs sub-tab
- Per-tab pause refs gate trace / log+error feeds independently

### Cross-cutting
- Helix `OTelTraceDetails` deep-link with `var-TraceTimestamp`, `var-TraceId`, etc.
- BMC chevron asset (`/public/bmc-chevron.svg`) used wherever Helix links appear
- `helix-otel-collector.yaml` templated with `${env:HELIX_ENDPOINT|HELIX_API_KEY|X_SOURCE}` so secrets stay in `.env` (which is gitignored)
- Onboarding rewrites: APP_URL clarification, network-share callout, detected-collectors widget, restart hints, bridge endpoint handles localhost / IP gracefully
- Nav reorganized (Onboarding | Gateway Dashboard | View OTel Data, left-aligned, with active-state highlight)
