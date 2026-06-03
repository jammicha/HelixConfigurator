# Helix Configurator Technical Blueprint

> Snapshot of the implementation as it stands today. The companion `ARCHITECTURE.md`
> at the repo root is the canonical project overview; this file is the deeper
> per-component reference for engineers working in the codebase.

## 1. Technology Stack

### Frontend
* Framework: React 19 + Vite (TypeScript).
* Styling: Tailwind CSS, mapped to ADAPT Design System tokens (see `frontend/tailwind.config.*` for the color palette).
* Code editor: Monaco for the gateway YAML editor (with line-precise parse errors and structural-lint warnings).
* Icons: `lucide-react` for UI glyphs; the orange BMC chevron is rendered as an inline SVG component (`BmcChevron`) so Tailwind size utilities apply consistently.
* Routing: filename-based switch in `frontend/src/main.tsx` — `/`, `/otel-data`, `/aiops` each map to a top-level component without React Router.

### Backend
* Runtime: Node.js 20 + Express.
* Docker integration: `dockerode` over the host socket (`/var/run/docker.sock`) for container lifecycle, network, and inspect operations.
* Trace store: `better-sqlite3` with a single-file DB at `/app/data/otel-store.db` (volume-mounted; persists across restarts).
* OTLP parsing: hand-rolled JSON decoder for the JSON-encoded OTLP shape that helix-gateway forwards. Protobuf decoding is not supported by the local store endpoint by design.
* YAML parsing/lint: `js-yaml` for the gateway config editor; structural lint catches typos like `recievers`, undefined pipeline references, and missing `service` blocks.
* Realtime: native Server-Sent Events from a single endpoint (`/api/traces/stream`) carrying `trace`, `error_record`, `log`, and `trace_counts_update` event types.

## 2. System Architecture & Packaging

### Containers
The distribution is a Docker Compose pair plus a host-facing `.env`:
* `helix-configurator` — the Express + React app. Image is built from the repo `Dockerfile`. Exposes the UI + API on host port `8765` (container `3001`).
* `helix-gateway` — `otel/opentelemetry-collector-contrib`, configured by the mounted `helix-otel-collector.yaml`. Exposes OTLP gRPC (`4317`), OTLP HTTP (`4318`), and a Prometheus metrics endpoint (`8888`) used by the diagnostic counters.

Both containers join the `helix-bridge` Docker network. Application containers — or a customer-owned OTel collector that already runs on a different compose network — are attached either to `helix-bridge` or, more commonly, helix-gateway is attached to *their* network via the bridge endpoints (`/api/lifecycle/bridge`, `/api/lifecycle/bridge-network`).

### Volume mounts
`docker-compose.yml` mounts:
* `/var/run/docker.sock:/var/run/docker.sock` so the configurator backend can issue lifecycle commands to other containers.
* `./helix-otel-collector.yaml:/app/helix-otel-collector.yaml` (read by the configurator UI) and `:/etc/otelcol-contrib/config.yaml` (consumed by the gateway).
* `./.env:/app/.env` (env vars + the AIOps token).
* `./data:/app/data` for the SQLite trace store.

### Secrets
`HELIX_ENDPOINT`, `HELIX_API_KEY`, `X_SOURCE` live only in `.env` (gitignored). `helix-otel-collector.yaml` references them via `${env:HELIX_ENDPOINT}` etc., which the OTel collector substitutes at startup. No secret material lands in committed files.

## 3. Frontend Implementation

### Theme & ADAPT
ADAPT design tokens are folded into Tailwind via `tailwind.config.*`:
* Brand: `primary` `#4040d9`, `active` `#3759d8`, `state` `#ff5a4e` (BMC orange).
* Status: `success` `#11845b`, `warning` `#ffd200`, `danger` `#b2001e`, `info` `#389be1`.
* Helix navigation chrome: `helixNav` `#18222d`, `helixDivider` `#555868`.
* `adapt-card`, `adapt-badge-{success,info,warning,danger}` utilities are defined in the global CSS for cards and pill badges.

### Top-level pages
* `App.tsx` (`/`) — host for the onboarding wizard and the Gateway Dashboard. State machine is driven by `isSetupComplete` + `setupStep`; URL query `?view=onboarding` forces the wizard from any nav.
* `OtelDataPage.tsx` (`/otel-data`) — the local APM viewer. Composed of `TracesTab`, `OperationsTab`, `LogsAndErrorsTab` (with `LogsView` and `ErrorsView` sub-tabs), `TraceDetailDrawer` (with `Waterfall` + `FlameView`), `RollupPanel`, `ServiceBreakdownPanel`, `BmcChevron`.
* `AiopsPage.tsx` (`/aiops`) — mock of the BMC Helix "Manage Opentelemetry" install wizard; produces the install command + zip bundle.

### Live updates
`OtelDataPage` opens a single `EventSource` on `/api/traces/stream` and dispatches event types:
* `trace` → upserts the trace into the list (gated by `tracesPausedRef`).
* `error_record` and `log` → appended to in-memory feeds (gated by `logsPausedRef`).
* `trace_counts_update` → merges errors / db / logs counts into the existing trace summary (always applied — counts are state-of-record, not feed events).

The page also polls `/api/operations` every 60s (regardless of active tab) so the trace list's outlier badge stays current with each operation's p95.

## 4. Backend Implementation & APIs

### Route surface (auth-gated under `/api` unless noted)
* **OTLP ingest (public; gateway fan-out):**
  * `POST /api/otlp/traces` — JSON-encoded OTLP traces; spans inserted, trace summary recomputed, `trace`/`span_error` events emitted.
  * `POST /api/otlp/logs` — JSON-encoded OTLP log records; written to `log_records`, `log` events emitted.
* **Public health:**
  * `GET /api/health` — liveness probe (`{ ok: true, version }`).
* **Auth:**
  * `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/status` — session cookie auth gated by `UI_AUTH_PASSWORD`.
* **Trace store queries:**
  * `GET /api/traces` (filters: `service`, `sinceMs`, `untilMs`, `limit`).
  * `GET /api/traces/:traceId` — full span detail.
  * `GET /api/traces/services` — distinct services participating in any trace (queries `spans`, not `traces`).
  * `GET /api/traces/errors` — flat error list.
  * `GET /api/traces/stream` — SSE multiplex of trace/log/error/counts events.
  * `GET /api/logs` — cross-trace log feed (filters: `severity`, `q`, `sinceMs`, `limit`).
  * `GET /api/logs/:traceId` — per-trace log feed for the drawer.
  * `GET /api/operations` — `service × root_operation` aggregates with p50/p95/error/slow rates over a time window.
* **Container & lifecycle:**
  * `GET /api/discovery/collectors` — host-wide scan for OTel-collector-shaped containers + which networks they live on.
  * `POST /api/lifecycle/restart` (gateway), `start`, `stop`, `bridge`, `bridge-network`, `restart-container`.
  * `GET /api/diagnostics/{collector,network,receiver-counters,metrics/live}` for the dashboard's diagnostic checks and trend sparklines.
* **Config:**
  * `GET /api/config`, `POST /api/config` — YAML editor read/write with parse + structural lint.
  * `GET /api/env`, `POST /api/env` — env var management (saved to `.env`, triggers a gateway restart).

### SQLite schema (`backend/otelStore.js`)
```sql
traces       (trace_id PK, service_name, root_operation,
              start_time_ns, end_time_ns, duration_ms, span_count, has_error, received_at)
spans        (span_id, trace_id, parent_span_id, service_name, name, kind,
              start/end/duration, status_code, status_message,
              attributes_json, events_json,  PK(span_id, trace_id))
span_errors  (id PK, trace_id, span_id, service_name, exception_type, message, stack, ts_ns, received_at)
log_records  (id PK, trace_id, span_id, service_name, severity, body, attributes_json, ts_ns, received_at)
```
Indexes on `trace_id` for spans/errors/logs; index on `service_name` for traces. The traces row is recomputed on every span batch via a single `INSERT … ON CONFLICT … DO UPDATE` that pulls min/max/count/error from the spans table.

`buildErrorRecords(span)` deduplicates: when a span has both `status_code === 2` AND an exception event, only the exception event materializes (status would otherwise produce a generic `span.error` shadow row). Re-ingestion is idempotent — `deleteErrorsForSpan` runs before inserting fresh error rows, so SDK retries don't accumulate.

Eviction: `_evictIfNeeded` keeps the trace count at or below `TRACE_CAP = 1000` (raised from 500 in the 2026-05-31 perf work) by deleting the oldest by `received_at` and cascading the deletes through `spans` / `span_errors` / `log_records`.

## 5. Discovered Services & Bridge Logic

The frontend's "Discovered Services" sidebar surfaces local Docker containers via `dockerode.listContainers()`. The backend filters out system / configurator / gateway containers; click "Attach to bridge" runs `getNetwork('helix-bridge').connect({ Container: name })`.

The reverse direction — attaching helix-gateway to the user's app or collector network — is what `/api/lifecycle/bridge` and `/api/lifecycle/bridge-network` do. The first takes `APP_URL`, parses the hostname, finds the matching container, picks its most-specific user network (driver=bridge, longest name), and connects helix-gateway to it. `localhost` / IP / loopback hostnames are treated as a clean `{ skipped: true, reason }` response so the UI's bridge-status banner can explain it as expected, not a 404.

## 6. /otel-data internals

* **Critical path** — walks the span tree from the latest-ending root, picks the latest-ending child at each level. The set of spans on this chain is stored once and reused for the bar dimming logic and the "Critical path only" filter.
* **CRISP-style overlay** — for each on-path span, the "blocking portion" is `[onPathChild.endTimeNs, span.endTimeNs]` (or the whole span if no on-path child). Rendered as a `bg-black/40` overlay inside the regular bar.
* **N+1 detection** — `detectNPlusOne` looks at all spans in a trace and flags 5+ shared `db.operation` + `db.name`.
* **Service breakdown** — per-service intervals from spans are merged (sweep-line union) before summing, so parallel work doesn't double-count.
* **SQL / HTTP rollups** — pure client-side aggregation over the loaded span list; key normalization in HTTP collapses `/users/42` and `/users/{uuid}` into a single bucket.
* **Helix deep-link** — `buildHelixTraceUrl` produces `${HELIX_ENDPOINT}/dashboards/d/OTelTraceDetails/otel-trace-details?orgId=<tenantId>&var-BusinessService=<X_SOURCE>&var-OTelNamespace=<X_SOURCE>&var-OTelService=<service>&var-TraceTimestamp=<YYYY-MM-DD HH:MM:SS.NNNNNNNNN local>&var-TraceId=<UPPERCASE>`.

## 7. Conventions

* **Auth gate ordering** — public endpoints (`/api/health`, `/api/auth/*`, `/api/otlp/*`) are mounted before `app.use('/api', requireAuth)`; everything after is session-gated.
* **OTel attribute coverage** — both old and new semconv keys are read together (`db.system` vs `db.system.name`, `db.statement` vs `db.query.text`, `db.operation` vs `db.operation.name`, `http.method` vs `http.request.method`, `http.url`/`url.full`/`http.target`/`url.path`).
* **Internal service filter** — `INTERNAL_SERVICES = { helix-gateway, helix-configurator, helix-configurator-verify, otelcol-contrib }`. Hidden by default in `/otel-data`; toggleable via "Show internal".
* **No Jaeger anywhere** — local trace querying is entirely SQLite-backed; the OTel demo's bundled Jaeger UI is unrelated to this project.

## 8. Open / future

Tracked in `docs/otel-data-todo.md` — the largest open item is an auto-detect "stalled stream" banner that watches gateway receiver-counter rate and surfaces a one-click upstream-collector restart when the rate flatlines despite the SSE showing live.
