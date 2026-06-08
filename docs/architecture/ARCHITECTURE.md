# Helix Configurator — Architecture & Concepts

A complete tour of what this project is, why it exists, and how it works — from
the user-visible workflow down to the SSE event names. Aimed at someone who has
just cloned the repo and needs full context before opening a file.

> Companion docs:
> - **`README.md`** (repo root) — quickstart, env-var reference, feature summary.
> - **`docs/COMPREHENSIVE-GUIDE.md`** — the full new-contributor guide (concepts, history, roadmap, gotchas).
> - **`docs/architecture/Blueprints-v1.md`** — per-component technical reference (engineers).
> - **`docs/roadmap/otel-data-todo.md`** — backlog for the `/otel-data` feature area.
> - **`docs/README.md`** — the documentation folder map.

---

## 1. What problem does this solve?

BMC Helix accepts OpenTelemetry data from customer environments via OTLP HTTP.
Onboarding by hand is tedious and error-prone — a customer has to spin up an
OTel collector with the right exporter, embed an API key, decide between
gRPC/HTTP/headers, then debug the inevitable network and config mismatches.

The **Helix Configurator** is the local sidecar that does this for them. It
runs as a **host process** (the configurator UI/API, no Docker required to run
it) and manages a **`helix-gateway`** OTel collector container when the Docker
onboarding target is chosen. It gives users a web UI to wire their app to the
gateway, validates that traces are reaching Helix, and — once the pipe is hot —
provides a built-in APM-style trace explorer (**View OTel Data**) so they can
introspect their telemetry without standing up Jaeger or Tempo.

The configurator is intentionally a *sidecar*: it never modifies the customer's
application. Customer apps point at `helix-gateway:4318` (or `:4317`); the
gateway adds the API key and forwards to Helix, while also fanning a copy of
traces and logs to the configurator for the local viewer (in Docker mode via `helix-configurator:3001`; in K8s local mode via `host.docker.internal:8765`).

---

## 2. Component map

**Native path (primary)** — the configurator is a host process, not a container:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Host                                                                     │
│                                                                          │
│  ┌──────────────────────┐        ┌──────────────────────┐                │
│  │  helix-configurator  │        │    helix-gateway     │   ┌──────────┐ │
│  │  (Express + React)   │◀──────▶│  (otel/contrib coll) │──▶│   BMC    │ │
│  │                      │        │                      │   │  Helix   │ │
│  │  host process :8765  │        │  Docker container    │   └──────────┘ │
│  │  SQLite ./data/      │        │  OTLP gRPC :4317     │                │
│  │  /var/run/docker.sock│◀───────│  OTLP HTTP :4318     │                │
│  │  (Docker target only)│        │  Prom metrics :8888  │                │
│  └─────────┬────────────┘        └──────────────────────┘                │
│            │                           fan-out →                         │
│            │                     host.docker.internal:8765               │
│            │ dockerode: create/attach networks,                          │
│            │ inspect containers, restart upstream collectors              │
│            ▼                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  Customer app(s) and (optionally) their own OTel collector       │    │
│  │  on whatever compose network they came up on                     │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

The configurator binds `PORT` (default **8765**) directly as a host process.
The Docker image path sets `ENV PORT=3001` and keeps the `8765:3001` host
mapping — the same code runs both ways; the port is the only difference.

In the native path the configurator **creates `helix-gateway` itself** via
dockerode (`createGatewayFromScratch`) on the first Docker-target save —
pulling the contrib collector image if absent, creating `helix-bridge`, and
publishing ports 4317/4318/8888. The gateway's local fan-out endpoint is
`http://host.docker.internal:8765` (the configurator is on the host); an
`ExtraHosts: host.docker.internal:host-gateway` entry makes this resolve on
Linux Docker Engine as well as Docker Desktop.

To make the gateway reachable to/from the customer's apps, the configurator's
bridge endpoints attach `helix-gateway` to the customer's existing compose
network (or vice versa) at runtime.

---

## 3. Repository layout

```
HelixConfigurator/
├── docker-compose.yml          # secondary Docker-image deployment
├── Dockerfile                  # builds the helix-configurator image (secondary path)
├── helix-otel-collector.yaml   # gateway pipeline config (env-var-templated)
├── README.md                   # quickstart + feature summary
│
├── packaging/                  # native launcher scripts
│   ├── start.command           # macOS: ./node backend/index.js
│   ├── start.sh                # Linux: ./node backend/index.js
│   └── start.bat               # Windows: node.exe backend\index.js
│
├── backend/                    # Node 22 + Express
│   ├── index.js                # thin entry: port bind + auth gate + route mounts
│   ├── portConfig.js           # resolvePort() — default 8765; Docker image sets PORT=3001
│   ├── statePaths.js           # resolveDataDir() — /app/data (Docker) or ./data (native)
│   ├── collectorFanout.js      # rewriteLocalViewerToHost() — shared host.docker.internal rewrite
│   ├── routes/                 # one module per surface: otlp, traces, config,
│   │                           # env, diagnostics, discovery, lifecycle,
│   │                           # gatewaySpec, containers, situations(+payloads),
│   │                           # business-service, k8s, version, step-zero/*
│   ├── otelStore.js            # better-sqlite3 schema + ingest/query methods
│   ├── situations-payloads.js  # pure builders for AIOps events/Situations
│   ├── package.json
│   └── data/                   # gitignored; trace store at otel-store.db
│
├── frontend/                   # React 19 + Vite + TypeScript
│   ├── src/
│   │   ├── main.tsx            # path-based switch into top-level pages
│   │   ├── App.tsx             # Onboarding wizard + Gateway Dashboard
│   │   └── components/
│   │       ├── OtelDataPage.tsx  # /otel-data — the local APM viewer
│   │       ├── UpdateBanner.tsx  # "update available" banner (GET /api/version)
│   │       └── LoginScreen.tsx
│   ├── public/
│   │   ├── bmc-logo.svg
│   │   └── bmc-chevron.svg
│   ├── tailwind.config.*       # ADAPT design tokens
│   └── package.json
│
├── templates/                  # YAML config templates loadable from the editor
│
└── docs/                       # version-controlled (Markdown only)
    ├── COMPREHENSIVE-GUIDE.md   # the full new-contributor guide
    ├── README.md               # documentation folder map
    ├── architecture/           # this file + Blueprints-v1.md + native-packaging-diagram.md
    ├── guides/  roadmap/  handoffs/
    ├── history/  superpowers/   # completed records & design archive
    └── deprecated/             # superseded docs, kept for reference
```

`docs/` is version-controlled but scoped to **Markdown only** (`docs/.gitignore`):
the demo deck, its `build_deck.py` generator, the Python virtualenv, and other
artifacts stay on local disk. See `docs/README.md` for the full folder map.

---

## 4. Data flow — telemetry

The fan-out pattern is the core of how `/otel-data` works without Jaeger.

```
                                ┌─────────────────────────────────────────────┐
[customer app]                  │ helix-gateway pipelines (in YAML config):    │
   │                            │                                              │
   │  OTLP gRPC/HTTP            │   traces:                                    │
   ▼                            │     receivers: [otlp]                        │
[helix-gateway:4317/4318] ─────▶│     processors: [batch]                      │
                                │     exporters: [otlphttp/bmchelix,           │
                                │                 otlphttp/helix_local_viewer]       │
                                │                                              │
                                │   metrics:                                   │
                                │     exporters: [otlphttp/bmchelix]          │
                                │                                              │
                                │   logs:                                      │
                                │     exporters: [otlphttp/bmchelix,           │
                                │                 otlphttp/helix_local_viewer]       │
                                └────────┬────────────────────────────┬───────┘
                                         │                            │
                                         │ X-Api-Key + X-Source       │ JSON-encoded
                                         ▼                            ▼
                                  ┌─────────────┐         ┌──────────────────────┐
                                  │  BMC Helix  │         │ helix-configurator   │
                                  │  ingestion  │         │   /api/otlp/traces   │
                                  └─────────────┘         │   /api/otlp/logs     │
                                                          │                      │
                                                          │   parses → SQLite    │
                                                          │   emits SSE events   │
                                                          └──────────────────────┘
```

**Headers are added by the gateway**, not the customer. So when a customer
collector or SDK sends to `helix-gateway:4317/:4318` it does *not* need to
include `X-Api-Key`/`X-Source`. The gateway holds them (loaded from `.env`
via `${env:HELIX_API_KEY}` substitution at collector startup) and applies them
on the outbound `otlphttp/bmchelix` hop.

Metrics still flow only to Helix — the local viewer doesn't render metrics, so
no fan-out for that pipeline.

---

## 5. The Gateway YAML

`helix-otel-collector.yaml` is the single source of truth for the gateway. The
file lives at the repo root, mounted into the gateway container at startup. Key
properties:

* **Env-var substitution** — all secrets reference `${env:HELIX_*}` so they
  stay in `.env` (gitignored) and never land in committed files.
* **Two exporters per fan-out pipeline** — `otlphttp/bmchelix` (out to Helix)
  and `otlphttp/helix_local_viewer` (HTTP to the configurator's `/api/otlp/*`
  endpoints at `http://host.docker.internal:8765`). The `host.docker.internal`
  address reaches the host-process configurator from inside the gateway
  container; `ExtraHosts: host.docker.internal:host-gateway` is set on the
  container spec so this resolves on Linux Docker Engine (not just Docker
  Desktop).
* **No queueing on helix_local_viewer** — `sending_queue: enabled: false` and
  `retry_on_failure: enabled: false` so a brief configurator restart can't
  accumulate a backlog. The bmchelix exporter does keep its sending queue,
  since dropped Helix data is visible to the customer.
* **JSON encoding on helix_local_viewer** — the configurator's OTLP receiver only
  decodes JSON; the gateway is configured to send it that shape explicitly.

The customer can edit this YAML freely from the dashboard's Monaco-based
editor; saving validates with `js-yaml` and runs structural lint (e.g.
detects `recievers` / undefined pipeline references / missing `service`).

---

## 6. Onboarding workflow

The configurator UI walks first-time users through a **five-step** wizard. State
lives in `App.tsx` (`setupStep`, persisted to
`localStorage['helix-configurator.setupStep']`); each step is a component under
`frontend/src/components/wizard/` (`Step1`–`Step5`, plus `Stepper`). The stepper
is clickable for any step already reached.

### Step 1 — Configure

* Captures `HELIX_ENDPOINT`, `HELIX_API_KEY`, `X_SOURCE`, optional
  `BUSINESS_SERVICE_KEY`. Validates each field as you type and auto-rebuilds the
  canonical `tenant::seg1::seg2` key from a pasted Helix-portal bundle.
* **Test connection** (`useTestConnection` → `POST /api/diagnostics/test-connection`,
  backed by `runOtlpProbe`) probes the *typed* endpoint + key against Helix —
  informational, never blocks Save.
* Save writes `.env` (`POST /api/env`) and recreates `helix-gateway` so the
  env-var substitution rebinds.

### Step 2 — Exporter (Route Your Telemetry)

* Copy-paste `otlphttp` exporter snippets pointed at `helix-gateway:4318`
  (headers are added by the gateway, not the app; the collector container needs
  a restart so gRPC/HTTP re-resolve).
* **Smart-add**: when exactly one upstream collector is detected, reads its
  config, computes the merge, previews the diff, and applies it (writing a
  `.helix-bak` and restarting the container).

### Step 3 — Connect

* Ensures `helix-gateway` shares a Docker network with the app/collector.
  Surfaces the auto-bridge result and offers one-click attach to any detected
  collector network via `POST /api/lifecycle/bridge-network`, with a manual
  fallback. Detects Kubernetes-based collectors and offers the K8s Attribute
  Enrichment template.

### Step 4 — Verify

* Live span/metric/log counters (delta since the step opened) plus app-side OTel
  export-error detection and a **Launch Dashboard** button. **Read-only
  observation** — *Next* is always enabled. (The old forced synthetic
  `Gateway → Helix` round-trip gate was removed in 2026-06; key/endpoint
  validation now lives in Step 1's Test connection.)

### Step 5 — Link Service

* Guided flow (`LinkBusinessService`, also surfaced as a dashboard card) that
  links the app's OTel namespace to an AIOps Business Service and captures
  `BUSINESS_SERVICE_KEY`. Makes **no** authenticated Helix calls — the OTel
  ingest key can't reach the CMDB/service-model layer — so it reads local
  telemetry, builds a deep-link + checklist, and writes only `.env`.

Launching the dashboard sets the onboarded flag so future visits skip the wizard.

---

## 7. /otel-data — the local APM viewer

The headline feature. A separate top-level page (not nested under the
dashboard) at `/otel-data`. Path-based switch in `main.tsx` mounts
`OtelDataPage` instead of `App`.

### Three top-level tabs

* **Traces** — filterable, searchable, paginated SSE-fed list. Each row shows
  service, operation, duration, span count, status pill, age, and inline
  rollup badges (errors / DB calls / log records / outlier). Filters: service,
  status (Error/Slow/OK/Outlier), min duration (preset dropdown), time range,
  free-text search. URL state preserves filters and the selected trace.
* **Operations** — `service · operation` aggregates over the selected time
  range. Count, p50, p95, max, error %, slow %. Sortable by every column.
  Click an operation to jump to a pre-filtered Traces view.
* **Logs & Errors** — two sub-tabs sharing the same Stream pause toggle:
  - **Logs** — every OTel log record. Severity filter and body+service search.
    Each row links back to its parent trace.
  - **Errors** — span exception events grouped by `exception_type × service`
    by default (count, first-seen, last-seen, sample expander), toggleable to
    Flat for the chronological timeline.

### Trace detail drawer

Opens as a side drawer. From top to bottom:

1. **Summary cells** — service, duration, spans, status pill.
2. **N+1 alert** — fires when 5+ spans share a `db.operation`.
3. **Service breakdown** — stacked bar of wall-clock per service, with
   intervals merged so parallel spans don't double-count.
4. **SQL rollup** — DB spans grouped by `system + statement|operation`. Reads
   both old (`db.statement`) and new semconv (`db.query.text`) keys.
5. **HTTP outbound rollup** — client-kind spans grouped by
   `method + normalized path` (path IDs/UUIDs collapsed to `{id}`). Status
   pills color-coded by class.
6. **Waterfall ↔ Flame view toggle**:
   - **Waterfall** — one row per span, depth-indented, timeline bars.
     Off-path spans dim to ~30% alpha; on-path spans render at ~80%.
     CRISP overlay paints the actually-blocking portion in `bg-black/40`.
     "Critical path only" filter collapses to just the chain.
   - **Flame** — same data, icicle layout. Each row is a tree depth, x-axis
     is wall time, color is per-service. Off-path spans dim. Hover tooltip.
7. **Span expansion** — exception events with stack traces, span attributes,
   per-span attached logs (severity-tinted), and a dedicated **DB call**
   panel for spans with `db.system` but no statement (Redis, Valkey, .NET,
   Mongo SDKs commonly omit raw commands).

### Diagnostics popover

Top-right of the page, opens a list of detected upstream OTel collectors with
per-collector **Restart** buttons. Backed by `/api/lifecycle/restart-container`
(validates against the discovery list before calling `docker.restart()`).
Useful when the demo collector's `memory_limiter` trips after long runs and
the trace stream stalls.

### Live update event types

Single SSE on `/api/traces/stream`:

| Event | Producer | Consumer behavior |
|---|---|---|
| `connected` | server start | flips Stream pill to Live |
| `trace` | `ingestSpans` after row recompute | upsert into traces list (gated by tracesPaused) |
| `error_record` | `ingestSpans` per exception | append to errors feed (gated by logsPaused) |
| `log` | `ingestLogs` per log record | append to logs feed (gated by logsPaused) |
| `trace_counts_update` | `ingestSpans` / `ingestLogs` after each batch | merge fresh log/error/db counts into the existing trace summary |

Heartbeat comments every 15s keep proxies from killing idle SSE connections.

---

## 8. SQLite store

Single file resolved by `statePaths.resolveDataDir()`: `/app/data/otel-store.db`
in the Docker image (volume-mounted from `./data/`) or `<installRoot>/data/otel-store.db`
natively (the `data/` folder in the extracted package). `OTEL_DB_PATH` env
override wins. Four tables:

* `traces` — one row per trace, recomputed on every span batch. Columns:
  `trace_id` (PK), `service_name`, `root_operation`, `start_time_ns`,
  `end_time_ns`, `duration_ms`, `span_count`, `has_error`, `received_at`.
* `spans` — every span with `(span_id, trace_id)` PK; upserted on re-ingest so
  retries don't duplicate. Columns include `kind`, `status_code/message`,
  `attributes_json`, `events_json`.
* `span_errors` — derived from spans that have `status_code === 2` OR an
  `exception` event. Dedup logic in `buildErrorRecords` prefers exception
  events (which carry the actual type/message) over the generic `span.error`
  fallback when both are present.
* `log_records` — OTel-native logs, keyed loosely to spans by
  `(trace_id, span_id)` when present.

Sliding-window cap at 1000 traces (`TRACE_CAP`); eviction deletes oldest by
`received_at` and cascades to spans / errors / logs.

Indexes: `idx_traces_service`, `idx_logs_trace`, `idx_errors_trace`,
`idx_errors_received`. Every cross-trace query the UI needs hits an indexed
column.

---

## 9. API surface (cheat sheet)

Public (mounted before the auth gate):
* `GET /api/health` — liveness.
* `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/status`.
* `POST /api/otlp/traces`, `POST /api/otlp/logs` — gateway fan-out.

Auth-gated under `/api`:
* **Trace store:**
  `GET /api/traces`, `GET /api/traces/:traceId`, `GET /api/traces/services`,
  `GET /api/traces/errors`, `GET /api/traces/stream`,
  `GET /api/logs?…`, `GET /api/logs/:traceId`, `GET /api/operations`.
* **Discovery + lifecycle:**
  `GET /api/discovery/collectors`,
  `POST /api/lifecycle/{restart,start,stop,bridge,bridge-network,restart-container}`.
* **Config + env:**
  `GET/POST /api/config`, `GET/POST /api/env`.
* **Diagnostics:**
  `GET /api/diagnostics/{collector,network,receiver-counters,metrics/live,inject-trace-verify}`,
  `GET /api/diagnostics/logs/stream`,
  `POST /api/diagnostics/toggle-debug`.
* **Discovered services panel:**
  `GET /api/containers/discovered`, `POST /api/containers/attach`, etc.

---

## 10. Conventions & gotchas

* **Auth gate ordering matters.** Public endpoints must be declared *before*
  `app.use('/api', requireAuth)` in `backend/index.js`. The OTLP receivers and
  health/auth endpoints are intentionally above that line.
* **Both old and new OTel semconv keys are read together** — `db.system` vs
  `db.system.name`, `db.statement` vs `db.query.text`, `db.operation` vs
  `db.operation.name`, `http.method` vs `http.request.method`,
  `http.url` / `url.full` / `http.target` / `url.path`.
* **Internal services are filtered by default** — `helix-gateway`,
  `helix-configurator`, `helix-configurator-verify`, `otelcol-contrib` are
  treated as pipeline noise, not application telemetry. "Show internal"
  toggle reveals them.
* **No Jaeger.** The OTel demo (used as a reference deployment) bundles its
  own Jaeger UI at `:16686` — that's unrelated to this project. The
  configurator does its own SQLite-backed querying.
* **The configurator never modifies the customer's app config.** The bridge
  endpoint connects helix-gateway to the customer's network rather than
  asking them to switch networks. The Step 2 snippet is suggestive, not
  enforced.
* **Tailwind classes need to be statically present in source.** Concatenated
  class strings like `` `bg-${color}/${alpha}` `` won't survive the JIT
  scanner — use full conditional classes (`bg-danger/30` vs `bg-danger/80`).

---

## 11. Local development

```bash
# Backend (auto-reload) — binds the default PORT 8765
cd backend && npm install && npm run dev   # :8765

# Frontend (Vite dev server, proxies /api → :8765)
cd frontend && npm install && npm run dev  # :3000
```

The dev server proxies `/api/*` to the backend at `:3001`, so you can iterate
on the UI without a Docker build.

To validate the Docker image path:

```bash
docker compose up -d --build helix-configurator
```

— which rebuilds the configurator image (frontend bundle baked in at build
time) and recreates the container without touching `helix-gateway`. The
gateway only needs `docker compose restart helix-gateway` if you've edited
the YAML or `.env`.

To validate the **native path** locally, either run the launcher scripts from
`packaging/` directly or download the built zip from CI.

The frontend runs `tsc --noEmit` on type-check. Backend has Vitest unit tests
(`npm test` in `backend/`). CI runs on release tags via `native-release.yml`;
`publish.yml` builds the Docker image on push. Type-check + backend tests are
the primary safety net.

---

## 12. Known external flake

The OTel demo's collector (`otel-collector` in the demo's compose) has a
`memory_limiter` processor at 80% that trips after several hours of demo
runtime, refusing all incoming data. The configurator can't prevent this, but
the **Diagnostics popover** on `/otel-data` lets you restart the upstream
collector with one click. Symptom: Stream pill stays Live but the gateway's
receiver counters stop incrementing. There's a TODO to auto-detect this and
banner the user — see `docs/otel-data-todo.md`.
