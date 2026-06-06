# Helix Configurator — The Comprehensive Guide

> A single, detailed, all-in-one reference for someone new to the team. It
> assumes no prior context and walks from "what is this and why does it exist"
> down to the engineering decisions, the BMC Helix integration internals, the
> project's history, and where it's going. Where the short canonical docs and
> this guide overlap, this guide is the connective tissue; where any doc and the
> **code** disagree, trust the code.
>
> Canonical companions: root [`README.md`](../README.md) (quickstart),
> [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) (architecture
> tour), [`architecture/Blueprints-v1.md`](architecture/Blueprints-v1.md)
> (per-component deep reference). Folder map: [`docs/README.md`](README.md).
>
> _Last consolidated: 2026-06-05._

---

## Table of contents

1. [What the Helix Configurator is](#1-what-the-helix-configurator-is)
2. [Quickstart](#2-quickstart)
3. [Core concepts & terminology](#3-core-concepts--terminology)
4. [Architecture deep dive](#4-architecture-deep-dive)
5. [Codebase map](#5-codebase-map)
6. [Feature tour](#6-feature-tour)
7. [The BMC Helix / AIOps integration](#7-the-bmc-helix--aiops-integration)
8. [Key engineering decisions & gotchas](#8-key-engineering-decisions--gotchas)
9. [Development workflow](#9-development-workflow)
10. [Demo operations](#10-demo-operations)
11. [Known risks & limitations](#11-known-risks--limitations)
12. [Roadmap & open work](#12-roadmap--open-work)
13. [Project history & timeline](#13-project-history--timeline)
14. [Where to find things (doc map)](#14-where-to-find-things-doc-map)
15. [Glossary](#15-glossary)

---

## 1. What the Helix Configurator is

**BMC Helix** ingests OpenTelemetry (OTel) data from customer environments over
OTLP/HTTP and turns it into topology, dashboards, and AIOps **Situations**.
Onboarding that data by hand is tedious and error-prone: a customer must stand
up an OTel collector with the right exporter, embed an API key, choose between
gRPC/HTTP and the right headers, then debug the inevitable network and config
mismatches.

The **Helix Configurator** is a local sidecar that does this for them. It runs
as a **host process** (no Docker required to run the configurator itself) and
manages a `helix-gateway` OTel collector container when the Docker onboarding
target is chosen. It gives users a web UI to wire their app to Helix, validate
that telemetry is flowing, and — once the pipe is hot — explore that telemetry
locally in a built-in, APM-style trace viewer (no Jaeger or Tempo required). It
also reaches "up" into Helix to provision the AIOps plumbing (an event class +
correlation policy) so anomalies in the customer's traces surface as enriched,
root-cause-ready Situations.

Two ideas define the product:

- **It is a _sidecar_, not an agent.** It never modifies the customer's
  application. Customer apps point their OTel exporter at `helix-gateway:4318`
  (or `:4317`); the gateway adds the API key + source header and forwards to
  Helix. The configurator's network "bridge" connects the gateway to the
  customer's Docker network rather than asking them to change theirs.
- **The demo experience is a separate project.** The `helix-aiops-mock`
  standalone app (port `:9000`) simulates the BMC Helix AIOps "Manage
  OpenTelemetry" install page and points to GitHub Releases for the native
  package. The configurator itself has no demo routes or demo flags — it is
  purely the product tool. See [§10](#10-demo-operations).

What the UI gives you, end to end:

- A **five-step onboarding wizard** (Configure → Exporter → Connect → Verify →
  Link Service).
- A **Gateway Dashboard** to manage the collector, run diagnostics, edit the
  pipeline YAML, stream logs, and copy a support bundle.
- **View OTel Data** — a local trace/log/error explorer with waterfall + flame
  views, RED-style (Rate/Errors/Duration) operation aggregates, SQL/HTTP rollups, N+1 detection, and
  Helix deep-links.
- **Step Zero** — a one-click synthetic e-commerce telemetry generator (and a
  guide for instrumenting your own apps) so the demo has interesting data
  immediately.
- **AIOps integration** — "Send to AIOps" from a trace, plus configurator-
  provisioned correlation policy so anomalies cluster into enriched Situations.

---

## 2. Quickstart

> Full reference is in the root [`README.md`](../README.md); this is the
> orientation version.

**Primary path — native package (no Docker Desktop required to run the
configurator):**

1. Download `helix-configurator-<platform>.zip` from **GitHub Releases**.
2. Extract and run the launcher: `./start.command` (macOS), `./start.sh`
   (Linux), or `start.bat` (Windows).
3. The browser opens to `http://localhost:8765`.

**1. Configure `.env`** in the extracted package directory (or the repo root):

```env
# Required
HELIX_ENDPOINT=https://your-tenant.onbmc.com          # bare tenant URL; gateway appends the OTLP path
HELIX_API_KEY=TenantID::AccessKey::SecretKey          # three parts joined by ::
X_SOURCE=your-business-service-name                   # telemetry source header (namespace fallback)

# Optional
BUSINESS_SERVICE_KEY=                                 # AIOps service key for deep-links + event topology pin
HELIX_EVENTS_ENDPOINT=                                # only if Events live on a different host than HELIX_ENDPOINT
UI_AUTH_PASSWORD=                                      # blank = open access (see §10)
TARGET_CONTAINER_NAME=helix-gateway                   # the managed collector container
```

Secrets stay in `.env` (gitignored); `helix-otel-collector.yaml` references them
via `${env:HELIX_ENDPOINT}` etc., substituted by the collector at startup.

**Docker image path (secondary):**

```bash
docker-compose up -d
```

Starts the pre-built GHCR image (container port 3001, mapped to host 8765) and
the gateway. No local build required.

**3. Open** `http://localhost:8765` (or `ssh -L 8765:localhost:8765 …` for
remote). First run launches the wizard; the nav bar
(`Onboarding | Gateway Dashboard | View OTel Data`) moves between surfaces.

**Local development** (outside Docker):

```bash
cd backend  && npm install && npm run dev   # :8765 (the default PORT)
cd frontend && npm install && npm run dev   # :3000 (Vite; proxies /api → :8765)
```

`tsc --noEmit` is the frontend's primary safety net (there is no UI test suite).
The backend has unit tests (`npm test` in `backend/`). See [§9](#9-development-workflow).

---

## 3. Core concepts & terminology

### The configurator + the gateway + the bridge

| Deployment | Component | Where it runs | Ports | Role |
|---|---|---|---|---|
| **Native (primary)** | `helix-configurator` | Host process | `8765` (default; `PORT` env to override) | UI + API + SQLite trace store; talks to Docker socket via `dockerode` (Docker target only). |
| **Native (primary)** | `helix-gateway` | Docker container (created by configurator) | `4317` gRPC, `4318` HTTP, `8888` metrics | Managed OTel collector; forwards to Helix and fans a copy to the host configurator at `host.docker.internal:8765`. |
| **Docker image (secondary)** | `helix-configurator` | Container on `helix-bridge` | `8765→3001` | Same role; `ENV PORT=3001` in the image. |
| **Docker image (secondary)** | `helix-gateway` | Container on `helix-bridge` | `4317` / `4318` / `8888` | Same role; fan-out target is `helix-configurator:3001` (container DNS). |

In the native path the configurator **creates `helix-gateway` itself** on the
first Docker-target save via `createGatewayFromScratch()` (dockerode), so no
Compose file is needed. After first creation, all existing lifecycle routes
(restart/stop/bridge) work unchanged because the container now exists.

To reach the customer's apps, the configurator attaches `helix-gateway` to the
customer's existing compose network at runtime (the "bridge"), rather than
moving the customer's containers.

### The OTel namespace model (the single most important concept)

In Helix, ingested data is organized **Business Service → OTel Namespace → OTel
Service**:

- **OTel Service** = the `service.name` resource attribute.
- **OTel Namespace** = the `service.namespace` resource attribute.
- **Business Service** = an AIOps construct that **binds one or more OTel
  Namespaces** (via "Default Blueprint for OTel Service" dynamic content).

**`X-Source`** is a coarse, per-export-connection header ("source of this
telemetry"). It becomes the OTel Namespace **only as a fallback**, for spans
that carry no `service.namespace`. This has a critical consequence:

> The configurator runs **one** gateway with **one** `X_SOURCE`. A single
> un-namespaced app shows up under `X_SOURCE`. But if several apps share the
> gateway and none set `service.namespace`, they all collapse into that one
> namespace. **To keep apps distinct, give each its own `service.namespace`** —
> at the app (`OTEL_RESOURCE_ATTRIBUTES=service.namespace=<app>`) or via a
> `resource` processor in the app's collector. One Business Service can then
> bind many namespaces. (This is why a new tenant whose apps don't set a
> namespace can ingest fine yet show empty dashboards — the X-Source→namespace
> link wasn't made.)

### Headers are added by the gateway

When a customer SDK or collector sends to `helix-gateway:4317/:4318`, it does
**not** include `X-Api-Key`/`X-Source`. The gateway holds them (from `.env`) and
applies them on the outbound hop to Helix. This is what makes onboarding a
copy-paste of an exporter endpoint, not a credential-handling exercise.

### The fan-out

The gateway's traces and logs pipelines each have **two** exporters:
`otlphttp/bmchelix` (out to Helix) and `otlphttp/helix_local_viewer` (HTTP to the
configurator's `/api/otlp/*` endpoints at `http://host.docker.internal:8765`).
The local copy is what powers **View OTel Data** — no external trace store needed
(no Jaeger/Tempo). `ExtraHosts: host.docker.internal:host-gateway` is set on
the gateway container spec so this resolves on Linux Docker Engine as well as
Docker Desktop. **Metrics flow only to Helix** (the viewer doesn't render
metrics today — see [handoff 02](handoffs/02-trace-resource-metrics.md)).

### Events vs. Situations

- An **Event** is a single signal posted to Helix's events-service (e.g. "this
  trace was anomalous").
- A **Situation** is an AIOps aggregation of related events. The configurator
  does **not** create Situations directly; it posts events **and** provisions a
  deterministic **correlation policy** so Helix clusters per-service anomaly
  events into a Situation. See [§7](#7-the-bmc-helix--aiops-integration).

### The demo boundary

The demo workflow (simulating the BMC AIOps install page) lives in the
**`helix-aiops-mock` standalone project** (port `:9000`), not in this repo. The
configurator has **no `/api/_demo/aiops/*` routes, no `/aiops` SPA page, and no
`IS_DEMO_INSTALL` flag**. The fan-out exporter that feeds the local viewer is not
demo plumbing — it ships in all deployments.

---

## 4. Architecture deep dive

### Component map

**Native path (primary):**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Host                                                                       │
│  ┌──────────────────────┐        ┌──────────────────────┐   ┌──────────┐   │
│  │  helix-configurator  │        │    helix-gateway     │   │   BMC    │   │
│  │  (Express + React)   │◀──────▶│  (Docker container)  │──▶│  Helix   │   │
│  │  host process :8765  │        │  OTLP gRPC :4317     │   └──────────┘   │
│  │  SQLite ./data/      │◀───────│  OTLP HTTP :4318     │                  │
│  │  /var/run/docker.sock│        │  Prom metrics :8888  │                  │
│  │  (Docker target only)│   fan-out → host.docker.internal:8765            │
│  └─────────┬────────────┘        └──────────────────────┘                  │
│            │ dockerode: create/attach networks, inspect/restart containers  │
│            ▼                                                                │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │  Customer app(s) and (optionally) their own OTel collector        │      │
│  └──────────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────┘
```

The configurator is a host process on `PORT` (default 8765). The Docker image
sets `ENV PORT=3001` and keeps `8765:3001`; same code, different port.
See [`docs/architecture/native-packaging-diagram.md`](architecture/native-packaging-diagram.md)
for an end-to-end flowchart.

### Telemetry data flow (the fan-out)

```
[customer app] ──OTLP──▶ [helix-gateway pipelines]
                              traces:  receivers:[otlp] processors:[batch]
                                       exporters:[otlphttp/bmchelix, otlphttp/helix_local_viewer]
                              metrics: exporters:[otlphttp/bmchelix]            (Helix only)
                              logs:    exporters:[otlphttp/bmchelix, otlphttp/helix_local_viewer]
                                                   │                     │
                                          X-Api-Key + X-Source     JSON-encoded OTLP
                                                   ▼                     ▼
                                            [ BMC Helix ]      [ configurator /api/otlp/* ]
                                                                  parse → SQLite → SSE
```

### The gateway YAML

`helix-otel-collector.yaml` (repo root, mounted into the gateway) is the single
source of truth for the pipeline. Key properties:

- **Env-var substitution** — secrets reference `${env:HELIX_*}`, kept in `.env`.
- **Two exporters per fan-out pipeline** — `otlphttp/bmchelix` and
  `otlphttp/helix_local_viewer`.
- **No queueing on the local-viewer exporter** (`sending_queue.enabled: false`,
  `retry_on_failure.enabled: false`) so a brief configurator restart can't
  accumulate backlog. The `bmchelix` exporter **does** keep its sending queue
  (dropped Helix data is customer-visible).
- **JSON encoding on the local-viewer exporter** — the configurator's OTLP
  receiver decodes **JSON only** (a hand-rolled decoder; protobuf is
  unsupported by design).

The customer can edit this YAML from the dashboard's Monaco editor; saving
validates with `js-yaml` and runs structural lint (catches `recievers`,
undefined pipeline references, missing `service` block, and warns when the
`transform` processor appears — it's unsupported by BMC Helix AIOps).

### The SQLite store

Single file resolved by `backend/statePaths.js`: `/app/data/otel-store.db` in
the Docker image (volume-mounted from `./data/`) or `<installRoot>/data/otel-store.db`
natively. `OTEL_DB_PATH` env override wins. Driven by **synchronous**
`better-sqlite3`. Four tables:

- `traces` — one row per trace, recomputed on every span batch via a single
  `INSERT … ON CONFLICT … DO UPDATE` that pulls min/max/count/error from spans.
- `spans` — every span, PK `(span_id, trace_id)`, upserted so retries don't
  duplicate.
- `span_errors` — derived from spans with `status_code === 2` **or** an
  `exception` event. Dedup prefers the exception event (real type/message) over
  the generic `span.error` shadow; `deleteErrorsForSpan` runs before re-insert.
- `log_records` — OTel-native logs, loosely keyed to spans by `(trace_id, span_id)`.

**Sliding-window cap `TRACE_CAP = 1000`** (raised from 500 in the 2026-05-31
perf work). Eviction deletes oldest by `received_at` and cascades to
spans/errors/logs. `TRACE_CAP` is the single exported source of truth (backend),
mirrored by a frontend constant.

**Performance hardening (2026-05-31):** because `better-sqlite3` blocks the Node
event loop on every statement, the old periodic full `VACUUM` stalled OTLP
ingest for the whole rewrite. It was replaced with `auto_vacuum = INCREMENTAL`
plus small `incremental_vacuum(N)` chunks on a 10s timer, gated by a 2s
ingest-quiet window. (A pre-existing DB needs one full `VACUUM` to convert to
incremental; that runs once at construct time, before `app.listen`.) Read-path
PRAGMAs: `temp_store = MEMORY`, `cache_size = -16000` (~16 MB). The store also
**self-heals on startup** if corrupted (don't ever open the live DB with a
read-write `sqlite3` CLI — use `?immutable=1` or the API, or you'll trigger a
self-heal wipe).

### SSE event types

A single `EventSource` on `/api/traces/stream` multiplexes:

| Event | Producer | Consumer behavior |
|---|---|---|
| `connected` | server start | flips the Stream pill to Live |
| `trace` | `ingestSpans` after row recompute | upsert into the traces list (gated by `tracesPaused`) |
| `error_record` | `ingestSpans` per exception | append to the errors feed (gated by `logsPaused`) |
| `log` | `ingestLogs` per record | append to the logs feed (gated by `logsPaused`) |
| `trace_counts_update` | after each batch | merge fresh log/error/db counts into a trace summary (**always applied** — state-of-record, not a feed event) |

Heartbeat comments every 15s keep proxies from killing idle SSE connections.

### API surface (cheat sheet)

**Public (mounted _before_ the auth gate):** `GET /api/health`;
`POST /api/auth/{login,logout}` + `GET /api/auth/status`;
`POST /api/otlp/{traces,logs}` (gateway fan-out).

**Auth-gated under `/api`:**
- Trace store: `GET /api/traces`, `/traces/:id`, `/traces/services`,
  `/traces/errors`, `/traces/stream`, `/logs`, `/logs/:traceId`, `/operations`.
- Discovery + lifecycle: `GET /api/discovery/collectors`;
  `POST /api/lifecycle/{restart,start,stop,bridge,bridge-network,restart-container}`.
- Config + env: `GET/POST /api/config`, `GET/POST /api/env`.
- Diagnostics: `GET /api/diagnostics/{collector,network,receiver-counters,metrics/live,system-health,test-connection,…}`,
  `/diagnostics/logs/stream`.
- Business service: namespace detection + guided-link routes (see [§7](#7-the-bmc-helix--aiops-integration)).
- Situations: event/policy provisioning routes (see [§7](#7-the-bmc-helix--aiops-integration)).

> **Auth gate ordering matters.** Public endpoints are declared before
> `app.use('/api', requireAuth)` in `backend/index.js`. The OTLP receivers and
> health/auth endpoints are intentionally above that line — moving them below
> would 401 the gateway's fan-out.

---

## 5. Codebase map

> Verified against the tree on 2026-06-03. The backend was modularized from a
> ~2400-line `index.js` monolith into thin route modules — `index.js` is now
> ~150 lines.

```
HelixConfigurator/
├── docker-compose.yml            # secondary Docker-image deployment
├── Dockerfile                    # builds helix-configurator (secondary path)
├── helix-otel-collector.yaml     # gateway pipeline config (env-templated)
├── README.md                     # quickstart + feature summary (canonical)
├── packaging/                    # native launcher scripts
│   ├── start.command             # macOS: ./node backend/index.js
│   ├── start.sh                  # Linux: ./node backend/index.js
│   └── start.bat                 # Windows: node.exe backend\index.js
├── helix-aiops-mock/             # standalone demo app (port :9000)
│   ├── server.js                 # session store, /configure, /install routes
│   ├── installScripts.js         # bash + ps1 script renderers
│   └── public/index.html         # mock "Manage OTel" form
├── templates/                    # loadable YAML templates: default-sidecar,
│                                 #   prometheus-scrape, tail-sampling, k8s-attributes
│
├── backend/                      # Node 22 + Express
│   ├── index.js                  # thin entry: port bind + auth gate + route mounts
│   ├── portConfig.js             # resolvePort() — default 8765; Docker image sets PORT=3001
│   ├── statePaths.js             # resolveDataDir() — /app/data vs ./data (native)
│   ├── collectorFanout.js        # shared host.docker.internal YAML rewrite
│   ├── routes/
│   │   ├── otlp.js               # POST /api/otlp/{traces,logs} (fan-out receiver)
│   │   ├── traces.js             # trace store queries + SSE stream
│   │   ├── config.js             # YAML read/write + lint, gateway settle/rollback
│   │   ├── env.js                # .env management
│   │   ├── diagnostics.js        # checks, counters, test-connection, system-health
│   │   ├── discovery.js          # scan host for collector-shaped containers
│   │   ├── lifecycle.js          # start/stop/restart/bridge via dockerode;
│   │   │                         #   createGatewayFromScratch() for Docker-target first-run
│   │   ├── gatewaySpec.js        # pure builder for the gateway createContainer spec
│   │   ├── containers.js         # Discovered Services panel
│   │   ├── version.js            # GET /api/version — update-check vs GitHub Releases
│   │   ├── situations.js         # AIOps events + correlation-policy provisioning (HTTP)
│   │   ├── situations-payloads.js# PURE builders/classifiers (unit-tested, no network)
│   │   ├── business-service.js   # guided OTel-namespace → Business Service linking
│   │   └── step-zero/
│   │       ├── synthetic.js      # /step-zero synthetic-burst endpoints
│   │       ├── synthetic-scenario.js # the 8-pattern e-commerce trace generator
│   │       ├── instrument.js     # detect/snippet endpoints
│   │       ├── instrument-templates.js # per-language auto-instrumentation snippets
│   │       └── helix-link.js
│   ├── otelStore.js              # better-sqlite3 schema + ingest/query (~1900 lines)
│   ├── otelStore.test.js         # store unit tests
│   ├── auth.js, envFile.js, errorLog.js, exportErrorScan.js, util.js, validate.js
│   ├── business-service-payloads.js
│   └── __tests__/                # backend unit tests
│
├── frontend/                     # React 19 + Vite + TypeScript (Tailwind/ADAPT)
│   └── src/
│       ├── main.tsx              # path-based switch: / , /otel-data , /otel-data/embed
│       ├── App.tsx               # onboarding wizard host + Gateway Dashboard
│       ├── hooks/                # useTestConnection, useBusinessServiceLink, …
│       ├── utils/                # incl. buildHelixTraceUrl deep-link helpers
│       └── components/
│           ├── wizard/           # Step1–Step5, Stepper, verifyVerdict
│           ├── dashboard/        # HelixConnectionSettingsDrawer, …
│           ├── business-service/ # LinkBusinessService (wizard Step 5 + dashboard card)
│           ├── step-zero/        # synthetic-burst + instrument UI
│           ├── otel-data/        # the /otel-data viewer (Traces/Operations/Logs+Errors,
│           │                     #   trace-detail/{Waterfall,FlameView,RollupPanel,…})
│           ├── UpdateBanner.tsx  # "update available" banner (polls /api/version)
│           ├── OtelDataPage.tsx, OverviewTab.tsx, ServiceMap.tsx,
│           └── Heatmap.tsx, InsightsPanel.tsx, Sparkline.tsx, …
│
└── docs/                         # this documentation tree (Markdown tracked only)
```

**Routing convention:** no React Router. `main.tsx` switches on `window.location.pathname`
into one of the top-level pages (`/`, `/otel-data`, `/step-zero`, etc.).
`/otel-data/embed` (a chromeless waterfall for Helix dashboard iframing) must
be matched **before** the general `/otel-data`.

---

## 6. Feature tour

### 6.1 Onboarding wizard (5 steps)

State is `setupStep` in `App.tsx` (persisted to localStorage); each step is a
`components/wizard/StepN.tsx`. The stepper labels are **Configure · Exporter ·
Connect · Verify · Link Service**.

1. **Configure** — capture `HELIX_ENDPOINT`, `HELIX_API_KEY`, `X_SOURCE`,
   optional `BUSINESS_SERVICE_KEY`. Field-level validation; auto-rebuilds the
   `tenant::seg1::seg2` key from a pasted portal bundle. **Test connection**
   probes the typed endpoint+key against Helix (informational, never blocks
   Save). Save writes `.env` and recreates the gateway.
2. **Exporter** — copy-paste `otlphttp` exporter snippets pointed at
   `helix-gateway:4318`. **Smart-add**: when exactly one upstream collector is
   detected, reads its config, computes the merge, previews the diff, and
   applies it (writes a `.helix-bak`, restarts the container). Re-running
   detects an already-applied exporter ("Already configured").
3. **Connect** — ensures the gateway shares a network with the app/collector;
   one-click attach to a detected network, with a manual fallback; detects
   Kubernetes collectors and offers the K8s Attribute Enrichment template.
4. **Verify** — live span/metric/log counters (delta since the step opened) +
   app-side export-error detection + **Launch Dashboard**. **Read-only**: _Next_
   is always enabled. (The forced synthetic "Verify gateway → Helix" gate was
   removed 2026-06; validation moved to Step 1's Test connection.)
5. **Link Service** — guided `LinkBusinessService` flow (also a dashboard card):
   links the app's OTel namespace to an AIOps Business Service and captures
   `BUSINESS_SERVICE_KEY`. See [§7](#7-the-bmc-helix--aiops-integration).

### 6.2 Step Zero — get interesting data fast

`/step-zero` exists so a demo (or a first-time user with no instrumented app)
has telemetry immediately. It evolved through three "layers":

- **Layer 1 (agentless infra metrics)** — one-click add of `hostmetrics` +
  `docker_stats` receivers to the gateway's own config. **Removed** — generic
  infra data didn't carry the demo and risked junk in the tenant. (The
  YAML-mutation helpers and the read-only host bind mounts it introduced are the
  durable artifacts.)
- **Layer 2 (synthetic e-commerce burst)** — **the headline.** A generator
  (`synthetic-scenario.js`) emits a realistic multi-service e-commerce trace
  burst with ~8 diagnostic patterns (slow DB, N+1, error cascades, retry storms,
  etc.). Two patterns carry real OTel `exception` events + `code.*` attributes
  so errored Situations can name a probable cause and code location: **Pattern
  B** (inventory-db `psycopg2.OperationalError`, ~3% of traces) and **Pattern G**
  (Stripe retry-storm `requests.exceptions.*`, ~2%). Cascade spans stay
  status-only so root-cause selection resolves to the true origin. All synthetic
  data is tagged with an internal **diagnostic namespace** so it stays
  quarantined from the user's real `X-Source`.
- **Layer 3 (instrument your apps)** — runtime container detection + generated
  auto-instrumentation snippets + a one-click "Apply for me." Built, then
  **walked back** to a static four-tab guide: live detection/recreation proved
  too fragile and too invasive for a demo tool. `instrument-templates.js` +
  the snippet endpoint survive; the lesson — _prefer passive copy-paste over
  mutating the customer's containers_ — informs [handoff 04](handoffs/04-sidecar-auto-instrumentation.md).

### 6.3 Gateway Dashboard

- **Helix Gateway Status** — start/stop/restart with live container state.
- **Run Diagnostic Health Check** — a 5-minute deep-diagnostic session: 4 status
  cards (collector config, API-key format, X-Source format, tenant URL), live
  `received`/`sent`/`dropped` counters with rolling sparklines, log streaming,
  and synthetic trace injection.
- **System Health panel** — a single ~30s round-trip snapshot (gateway status +
  throughput + store usage + recent errors); complements the user-initiated
  health check. Store-usage card badges red at >85% of `TRACE_CAP`/`LOG_CAP`/
  `ERROR_CAP`. (Origin: the 2026-05-15 weekend-hardening work; `backend/errorLog.js`
  is the in-memory ring buffer behind "recent errors.")
- **Discovered Services** — slide-out of local containers; *Attach to bridge*
  wires an app's telemetry through the gateway.
- **Copy Support Bundle** — sanitized snapshot (env with API key redacted,
  container status, diagnostics, live metrics, last log lines) for support
  tickets. (Heads-up: see the redaction caveat in [§11](#11-known-risks--limitations).)
- **Helix Connection Settings** — edit env vars in place; saving restarts the
  gateway. Shows whether the UI is open or password-required.
- **Gateway Config (YAML)** — Monaco editor with line-precise parse errors +
  structural lint + `Cmd/Ctrl+S`. **Load Template**: Default Sidecar, Prometheus
  Scrape, Tail Sampling, Kubernetes Attribute Enrichment.
- **Diagnostic Log Stream** — streams the attached service (else the gateway);
  *Helix Only* vs *All Logs* filter; smart auto-scroll; **Show Raw Metrics**
  opens the gateway's `:8888/metrics`.

### 6.4 View OTel Data (`/otel-data`)

Page-level controls (apply to every tab): **Range** (5m/15m/1h/6h/24h + Custom);
**Stream mode** (Live = SSE + 30s rollup poll; 30s/1m/5m snapshot polls; Paused);
**Slow threshold** (250ms…10s) driving the Slow filter, duration coloring, and
histogram segmentation.

Three tabs:

- **Traces** — realtime, filterable (service, status Error/Slow/OK/**Outlier**
  = >2× p95 of its operation, min duration), server-side search across
  operation/service/trace-id (debounced; reaches past the 200-row cap). Rows
  carry inline rollup badges (errors / DB calls / logs) and a **View in Helix**
  deep-link. Error rows show the **failing operation** as a muted subline under
  the service. URL state (filters + selected trace) is shareable.
- **Operations** — `service · operation` aggregates (count, p50, p95, max,
  error %, slow %), sortable; click to jump to a pre-filtered Traces view.
- **Logs & Errors** — **Logs** (severity filter, body+service search) and
  **Errors** (grouped by `exception_type × service` with first/last-seen + sample
  expander; toggle Flat for the timeline).

**Trace detail drawer:**

- **Send to AIOps** — a manual action in the drawer that posts the trace to Helix as an Event (today's path for emitting anomaly events; there is no automatic emitter yet). Severity is derived:
  `CRITICAL` (error span), `MAJOR` (duration > 2× the operation's p95),
  `MINOR` otherwise — the button label/icon change accordingly. Re-clicks are
  warned about (a localStorage send-history). Pinning to one Business Service
  needs `BUSINESS_SERVICE_KEY`.
- **View in Helix** — deep-link to the `OTelTraceDetails` dashboard.
- **Service breakdown** — stacked bar of wall-clock per service, intervals
  merged (sweep-line union) so parallel spans don't double-count.
- **SQL rollup** — DB spans grouped by system + statement; **N+1 alert** when
  5+ spans share a `db.operation` (+ `db.name`).
- **HTTP outbound rollup** — client spans grouped by method + normalized path
  (`/users/42` and `/users/{uuid}` collapse to one bucket), status pills by class.
- **Waterfall ↔ Flame toggle** — waterfall (one row/span) and flame (icicle by
  depth), both colored **by service**, both highlighting the **critical path**
  (off-path spans dim; a CRISP-style overlay paints the actually-blocking
  portion of each on-path span). Status moved to its own ring/wash channel so a
  legitimately red-hued service doesn't read as an error.
- **Span details** — attributes, attached logs (severity-tinted), exception
  events with stack traces, and a dedicated DB-call panel for spans with
  `db.system` but no statement (Redis/Valkey/.NET/Mongo).

**Diagnostics popover** — lists detected upstream collectors with one-click
**Restart** (useful when the demo collector's `memory_limiter` trips and stalls
the stream — see [§11](#11-known-risks--limitations)).

**Embed route** — `/otel-data/embed?trace=<id>&span=<spanId>` is a chromeless
waterfall (no app shell) built to be **iframed inside a Helix dashboard**, with
the failing span highlighted and scrolled into view. See [§7](#7-the-bmc-helix--aiops-integration).

---

## 7. The BMC Helix / AIOps integration

This is the part most likely to surprise a newcomer, because it's shaped by hard
auth boundaries discovered by live spiking.

### 7.1 The credential wall (read this first)

The `HELIX_API_KEY` is an **OTLP ingest key** (an IMS access key, format
`TenantID::AccessKey::SecretKey`). What it can and cannot do:

- ✅ **Ingest** OTLP to Helix.
- ✅ Reach **IMS-fronted** APIs after exchanging the key for a **Bearer JWT** via
  IMS (`POST /ims/api/v1/access_keys/login`) — this covers the **events-service**
  and the **aiops-config** (correlation policy) APIs. The raw key is
  ingest-only; the JWT is what those REST APIs accept.
- ❌ **401 at the CMDB / service-model layer** (`/api/cmdb`, `/api/arsys`) — those
  need AR-System credentials.

**Consequence:** the configurator **cannot list or create Business Services via
API.** That's why "Link Service" (Step 5) is **guided-only**: it makes _no_
authenticated Helix calls — it reads local telemetry (`otelStore.listNamespaces()`),
builds a deep-link + a manual checklist ("create the service → Add Dynamic
content → Default Blueprint for OTel Service → select your namespace → Save"),
and writes only `BUSINESS_SERVICE_KEY` to `.env` (and `process.env`, so it
applies with no restart). Anything requiring Business-Service creation is blocked
on a different credential.

### 7.2 Events, the event class, and the correlation policy

To make anomaly events cluster into Situations, the configurator provisions
(idempotently) into the tenant:

- An **`OTEL_TRACE_ANOMALY` event class** with the slots the enriched events
  need.
- A deterministic **correlation policy** named
  `HelixConfigurator-OTel-Trace-Anomaly` (`type: CORRELATION`) that groups events
  per service (`$NEW/$OLD` match on `service_name` + `service_namespace`,
  `within` 15 min, `minCount` 3). The aggregate's `newEventClass` must be
  `ALARM` (Anomaly/Prediction/Situation are restricted as aggregate outputs);
  the aggregated ALARM is what surfaces as the Situation.

**Hard-won BMC API quirks (don't rediscover these):**

- Event **policies are addressable only by internal id.** Name-addressing
  returns `400 Invalid id format`; the collection has no `GET`. List via
  `POST /event_policies/search` with body exactly `{}` (the schema is
  `additionalProperties:false`). Match by name, then PUT (update) or POST (create);
  treat 409 / "already exist" as soft success.
- Event **classes** resolve by name with `?idType=name`, but **DELETE/PUT by
  UUID** — a name-addressed mutation hits `Invalid UUID string` (the path is
  parsed as a UUID). So: resolve the class UUID by name first, then mutate by id.
  When updating class attributes, **exclude the built-in `priority` attribute**.
- The correlation-policy **selector syntax** has no parens
  (`selectorCriteriaList`), and conditions need **empty-string** `conditionBracket`/
  `endBracket`. Validated live.
- BMC **blocks deleting a class that has open events** (409) — a key reason the
  destructive "recreate the class" approach was abandoned in favor of a
  **non-destructive PUT-by-UUID slot update.**

**Convention:** all payload/decision _shape_ logic is pure and unit-tested in
`backend/routes/situations-payloads.js` (no network, no `process.env`);
`situations.js` is HTTP-only orchestration verified against a live tenant. Old
events are never backfilled — only fresh `trace_id`s get enriched.

### 7.3 RCA enrichment — making Situations root-cause-ready

Each anomaly event (and the Situation title) is enriched using **only data
already in `otelStore.getTrace()`** — pure functions in `situations-payloads.js`:

- **Probable cause** — the originating error span: `status_code === 2` **or** an
  `exception` event; pick the **most-downstream (latest-started)** span,
  preferring exception-bearing ones. Yields `error_type`, `error_message`,
  `code_location` (from the span's `code.filepath/function/lineno`),
  `probable_cause_span_id`.
- **Blast radius** — affected service/component count.
- **Dynamic priority** — errors outrank latency; a big anomaly factor (≥4× p95)
  or wide blast (≥3 services) escalates an error to `PRIORITY_1`.
- **Trace deep-link** — `buildHelixTraceUrlFromSummary` (a backend port of the
  frontend `buildHelixTraceUrl`) to the `OTelTraceDetails` dashboard.
- **Hot path** — root→…→error-span ancestor chain (failure marked `✗`).
- **Problem span** — `span_dashboard_url` targets a manually-created "OTel
  Problem Span" Helix dashboard (a Text/HTML panel that iframes the
  `/otel-data/embed` route), keyed by `HELIX_SPAN_DASHBOARD_UID` + `var-TraceId`/
  `var-SpanId`.

> **Backward-compat invariant:** with no `spans` passed, the event payload is
> **byte-for-byte identical** to the legacy shape (pinned by tests). All
> enrichment lives inside an `if (hasSpans)` block.

**Deep-link encoding quirks** (in `buildHelixTraceUrl`): the trace timestamp is
local `YYYY-MM-DD HH:MM:SS.NNNNNNNNN` with spaces encoded as `%20` (not `+`);
`var-TraceId` is **uppercase**; returns `''` for the `your-tenant.onbmc.com`
install placeholder. `tenantId` is the first `::`-segment of the API key; the
deep-link targets the `HELIX_ENDPOINT` portal origin (which can differ from the
events base URL — see `HELIX_EVENTS_ENDPOINT`).

### 7.4 Why richer Situations matter (the Gartner-MQ demo)

The configurator **is the live on-ramp** the BMC Helix Gartner-MQ capability
demo opens with (OTel onboarding → auto Business Service + topology; error-trace
routing). Everything the demo sells _after_ that — Deep RCA, agentic blast
radius, change-aware RCA, autonomous closed-loop remediation — runs **downstream
of a Situation**. So the leverage is: _the richer each Situation the
configurator emits, the closer the live demo gets to the polished video._ The
prioritized enrichment backlog (name the cause → severity + blast radius →
deep-link → fingerprint dedup → change/deploy correlation → auto-close) lives in
[`history/situations-gartner-mapping.md`](history/situations-gartner-mapping.md);
items 1–3 shipped, 4–6 are follow-ups needing new signal sources. The single
biggest gap is **change/deploy correlation** (the demo's dominant RCA pattern).

> Note: `situations-gartner-mapping.md` was inferred from transcribed demo
> voice-over, not a Helix field spec — treat its "must carry" schema as
> directional.

### 7.5 The standing rule: destructive tenant ops stay manual

Non-destructive provisioning (adding class slots, creating the correlation
policy) is fine to automate. **Deleting** classes/policies/events is done
manually by the operator — there are no configurator buttons for it. This is a
deliberate product decision (and BMC's own 409-on-open-events behavior reinforces
it).

---

## 8. Key engineering decisions & gotchas

A digest of the durable, easy-to-trip-over knowledge:

- **Pure core, HTTP shell.** Decision/shape logic (situation payloads, verify
  verdicts, business-service payloads, deep-link builders) is pure and
  unit-tested; network/orchestration is separate. Mirror this when adding Helix
  integrations.
- **Read both old and new OTel semconv keys together** — `db.system`/`db.system.name`,
  `db.statement`/`db.query.text`, `db.operation`/`db.operation.name`,
  `http.method`/`http.request.method`, `http.url`/`url.full`/`http.target`/`url.path`.
- **JSON-only OTLP at the local receiver** — the fan-out exporter must send
  JSON-encoded OTLP; protobuf isn't decoded.
- **Auth gate ordering** — public routes before `app.use('/api', requireAuth)`.
- **No React Router** — path switch in `main.tsx`; `/otel-data/embed` before
  `/otel-data`.
- **Tailwind classes must be statically present** — concatenated class strings
  like `` `bg-${c}/${a}` `` won't survive the JIT scanner; use full conditional
  classes. Colors come from **ADAPT** (BMC's design system) tokens in `tailwind.config.*`
  (`primary #4040d9`, `danger #b2001e`, `warning #ffd200`, …); no hardcoded hex.
- **`better-sqlite3` is synchronous** — long statements block ingest; this is why
  `VACUUM` was replaced with gated incremental vacuum.
- **Never open the live store with a read-write `sqlite3` CLI** — corrupts it →
  startup self-heal wipe. Use `?immutable=1` or the API.
- **Internal services filtered by default** — `helix-gateway`,
  `helix-configurator`, `helix-configurator-verify`, `otelcol-contrib` are
  pipeline noise; "Show internal" reveals them.
- **The configurator never modifies the customer's app** (ARCHITECTURE §10) — the
  bridge connects the gateway to their network; Step-2 snippets are suggestive.
- **Demo code lives in `helix-aiops-mock/`**, not in this repo. The configurator
  has no `/api/_demo/aiops/*` routes, no `/aiops` SPA, and no `IS_DEMO_INSTALL` flag.
- **Synthetic demo data is namespace-quarantined** by a hardcoded internal
  diagnostic namespace, so it never pollutes the user's real `X-Source`. The
  deep-link aligns to that fixed value, not vice-versa.

---

## 9. Development workflow

**Run/iterate:**

```bash
cd backend  && npm install && npm run dev   # :8765 (auto-reload; the default PORT)
cd frontend && npm install && npm run dev   # :3000 (Vite proxies /api → :8765)
```

To validate the Docker image path:

```bash
docker compose up -d --build helix-configurator   # rebuilds image, frontend baked in
# gateway only needs: docker compose restart helix-gateway  (after YAML/.env edits)
```

To validate the native path: run `packaging/start.sh` (or `.command` / `.bat`)
locally, or download the built zip from a CI run.

**Safety net:** the frontend runs `tsc --noEmit` (type-check) — there is **no UI
runtime test suite**, and CI is not configured, so type-check passing is the
primary gate. The backend **does** have unit tests (`backend/__tests__/`,
`otelStore.test.js`, the pure `*-payloads` tests) — keep them green. Frontend
tests are **pure-function node tests only** (no RTL/jsdom); don't assume a
component test harness exists.

> **Before you push** — there is no CI, lint, or pre-commit hook, so *these are
> the gate:*
>
> ```bash
> cd frontend && npx tsc --noEmit   # type-check (primary safety net)
> cd backend  && npm test           # backend unit tests must stay green
> ```

**The "superpowers" planning workflow.** Substantial features are designed via a
spec → plan → implement flow; the dated artifacts live in
[`superpowers/specs/`](superpowers/specs/) (design) and `superpowers/plans/`
(implementation). They are the project's design memory — read the relevant
spec before touching a feature area. This folder is **actively appended to** by
ongoing design sessions; treat each file as a point-in-time record.

**Shared-tree / worktree caution.** This working tree is sometimes shared with a
concurrent session. Isolate risky edits in a manual `git worktree` (the
automated worktree hook is unreliable) and symlink `node_modules`. If you see
files appear/move under you, that's why.

**Tooling reliability note (from a prior session's handoff).** When verifying
tests, prefer `--reporter=json --outputFile=…` then read the file, and confirm
edits actually persisted (`grep -c` → read) rather than trusting streamed
stdout. Use absolute paths. This caution is recorded in
[`superpowers/HANDOFF-failing-operation-trace-list.md`](superpowers/HANDOFF-failing-operation-trace-list.md).

---

## 10. Demo operations

The product is frequently shown live, so a few demo affordances are first-class:

- **Expose it for a remote demo (Cloudflare tunnel).** See
  [`guides/cloudflare-tunnel-demo.md`](guides/cloudflare-tunnel-demo.md). Quick
  tunnel: `cloudflared tunnel --url http://localhost:8765 --no-autoupdate`; hand
  the printed `*.trycloudflare.com` URL to the tester 1:1.
- **The "URL is the secret" model.** Demo setups leave `UI_AUTH_PASSWORD`
  **blank** on purpose — the random ephemeral tunnel URL is the protection, not
  a login screen. `UI_AUTH_PASSWORD` is "prevent casual access" only; real auth =
  an SSO proxy in front. (Caveat: anyone with the URL can attach/disconnect
  Docker containers on the demo host — see [§11](#11-known-risks--limitations).)
- **The demo install-flow (`helix-aiops-mock`).** The full prospect workflow
  (Helix AIOps page → install command → land in the configurator) is driven by
  the **`helix-aiops-mock`** standalone project (port `:9000`). It serves a mock
  "Manage OTel" form, mints a session (token + fake API key), and returns a
  `curl … | bash` / `iwr … | iex` one-liner. The install script downloads the
  correct platform zip from GitHub Releases, writes a pre-filled `.env`, and
  launches `./node backend/index.js`. The configurator itself has no demo routes.
- **Pre-demo clean state.** A blank `.env` plus an `Exited` `helix-gateway` can
  be an **intentional** pre-demo state — do not "fix" it by restoring creds or
  deleting the gateway (the stopped gateway is the clone template the recreate
  flow uses).
- **Updating the configurator.** Re-run the install command from `helix-aiops-mock`
  or download the latest zip from GitHub Releases and extract over the existing
  directory (`data/`, `.env`, and `helix-otel-collector.yaml` are preserved). The
  configurator UI shows an "update available" banner at startup when a newer
  release is detected (`GET /api/version` → GitHub Releases latest tag).
- **The deck.** `artifacts/HelixConfigurator-Demo.pptx` (generated by
  `artifacts/build_deck.py`) is the slide deck. Both are local-only (not tracked).

---

## 11. Known risks & limitations

From the current weak-point audit
([`roadmap/risk-assessment-v2.md`](roadmap/risk-assessment-v2.md)) plus the
README's Known Issues. The dominant theme is the **auth-off attack surface** —
the "random URL is the secret" model predates the now-substantial mutating-POST
API:

- **CORS `*` + `credentials:true`**, **unauthenticated `set-password`** (a
  drive-by could lock the operator out), and **`.env` injection via a newline in
  the password** are the sharp edges when `UI_AUTH_PASSWORD` is blank.
- **SSE never reconnects** after the first drop (e.g. Cloudflare's ~1h idle
  timeout) — the live viewer silently dies until reload; the logs/errors tabs
  also lack the 30s fallback.
- **Support bundle** can leak API-key fragments via gateway-log scraping —
  redact before returning.
- **Filters half-wired** — namespace/container filters are ignored on
  logs/errors/serviceMap despite the "applies to every tab" tooltip.
- The 30-min `VACUUM` lock risk from v2 is **resolved** by the incremental-vacuum
  work (see [§4](#4-architecture-deep-dive)).

**README Known Issues:** moderate `dompurify` XSS advisories via `monaco-editor`
0.55.1 (no stable patched release yet; low practical risk — the editor only
renders our YAML); `esbuild` advisory via Vite ≤6.4.1 (dev-server only, not in
production builds; fix needs a Vite 8 migration).

**External flake:** the OTel demo's own collector has a `memory_limiter` at 80%
that trips after hours of runtime and refuses all data. Symptom: the Stream pill
stays Live but receiver counters stop. The **Diagnostics popover** on
`/otel-data` restarts the upstream collector in one click. (Auto-detecting this
and bannering it is an open roadmap item.)

> **Two different "viewer stuck on Live" cases — different fixes:**
> - **Receiver counters stopped, pill still Live** → the upstream collector
>   tripped (`memory_limiter`). Use the Diagnostics popover → **Restart**.
> - **The whole stream went dead** (often after ~1h on a tunnel) → the SSE
>   never-reconnects gap. **Reload the page.**

---

## 12. Roadmap & open work

Live roadmaps (these are the source of truth — mine them, don't trust this
summary to stay current):

- **`roadmap/otel-data-todo.md`** — the active `/otel-data` backlog. Open items
  include: SSE coverage for the Overview charts (root fix for streaming
  inconsistency); Davis-style (Dynatrace-style AI) correlated-insight rules; a RED-from-traces
  **Metrics** tab; remaining Helix CTAs; a preflight health banner; finishing the
  backend modular split; a Vitest scaffold around `otelStore`; validating
  Send-to-AIOps against a real tenant; config-template evolution.
- **`roadmap/productization-todo.md`** — the POC→enterprise gap (explicitly
  post-demo): auth revamp (per-user identity, SAML/OIDC, RBAC, CSRF,
  `TRUSTED_AUTH_HEADER` proxy mode); Docker-socket-proxy lockdown; hashing
  `UI_AUTH_PASSWORD` + secret-manager integration; a Kubernetes/Helm story;
  HTTPS guidance + login rate limiting; an audit log; deeper `/api/health` +
  structured logging + `/metrics`; a schema-migration/upgrade path; integration
  tests against real Docker/Helix.
- **`roadmap/risk-assessment-v2.md`** — the prioritized weak-point list ([§11](#11-known-risks--limitations)).
- **One survivor from the shipped `/otel-data` ledger** (`history/otel-viewer-shipped-log.md`):
  auto-detect a stalled upstream stream (watch the receiver-accepted-spans rate;
  banner + one-click Restart when it flatlines while SSE shows Live) — needs a
  `/api/diagnostics/stream-health` endpoint.

**Future directions** — the [`handoffs/`](handoffs/) briefs (forward-looking
brainstorm starting points from the 2026-06-03 demo; run `superpowers:brainstorming`
before converging):

| Brief | Scope | Priority |
|---|---|---|
| [01 — Local → Kubernetes](handoffs/01-local-to-kubernetes.md) | From dockerode container-manipulator to a K8s control plane (CRs/Helm/OTel Operator), with parity to the Docker UX. | High |
| [02 — Trace resource metrics](handoffs/02-trace-resource-metrics.md) | Show CPU/memory for a trace's service over its window in the drawer; needs a metrics receiver + a time-window join. | High |
| [03 — AIOps integration (richer Situations)](handoffs/03-aiops-integration.md) | Climb the Gartner enrichment list; source the deploy/change signal and the "healthy again" detector. | Medium |
| [04 — Sidecar auto-instrumentation](handoffs/04-sidecar-auto-instrumentation.md) | Spike: zero-code instrumentation (per-language agents vs eBPF/Beyla); deliberately crosses the "never touch the app" line. | Spike→POC |
| [05 — OTel Blueprints](handoffs/05-otel-blueprints.md) | Assess-first: align to / generate OpenTelemetry "Blueprints"; gated behind a go/no-go memo. | Spike (gated) |

**Deferred design — multi-X-Source / multiple Business Services**
([`superpowers/specs/2026-05-29-multi-xsource-business-services-design.md`](superpowers/specs/2026-05-29-multi-xsource-business-services-design.md)):
route one host's apps into _multiple_ Business Services via a per-`service.namespace`
routing connector. Designed but **not implemented**; note the BMC AIOps 26.1
"X-Source auto-creates a service" behavior to reconcile against the manual-link
finding.

---

## 13. Project history & timeline

How the product got here (dates are 2026; the dated artifacts are in
[`superpowers/`](superpowers/) and [`history/`](history/)):

- **May 8 — the two kickoff prompts** ([`history/kickoff-prompts/`](history/kickoff-prompts/)).
  One built **View OTel Data** (gateway fan-out → OTLP receiver → SQLite → SSE →
  waterfall; hard constraints: no Jaeger, Express + SQLite only, everything on
  8765). The other **redesigned the onboarding wizard from 2 to 4 steps**
  (Configure → Exporter → Connect → Verify; constraints: extend the `App.tsx`
  state machine, no React Router, ADAPT tokens). These constraints still bind.
- **May 11** — Cloudflare-tunnel demo runbook.
- **May 14–15 — hardening push.** Risk Assessment v1 (23 findings); wizard-
  hardening TODO + plan (capability-based collector detection, network-attach
  persistence, dual-side verify verdicts); the **Weekend Hardening** spec/plan
  (Test-connection, restart snippet, send-test-trace, **System Health** panel,
  network watchdog); a large onboarding-UX backlog.
- **May 16–20 — Step Zero.** Layer 1 (agentless infra metrics, later removed) →
  Layer 3 (instrument-your-apps, built then walked back to a static guide). The
  durable lesson: don't auto-mutate the customer's containers.
- **May 22** — Risk Assessment **v2** (supersedes v1; carries a reconciliation
  table).
- **May 28 — Situations foundation.** The `OTEL_TRACE_ANOMALY` event class + the
  configurator-provisioned **correlation policy** (events cluster per-service
  into a Situation; each event carries a clickable `trace_url`).
- **May 29 — RCA groundwork.** Class-recreate (destructive approach rejected →
  non-destructive PUT-by-UUID slot update); **RCA enrichment** (probable cause,
  blast radius, priority, deep-link); the multi-X-Source design (future); the
  Gartner-MQ mapping; the productization backlog; the demo deck.
- **May 30 — Link Business Service** (guided-only, backend + frontend; the spike
  that proved the CMDB credential wall); synthetic error spans gain `exception`
  events + `code.*` so Situations can name a code location.
- **May 31 — viewer polish + perf.** SQLite perf (500→1000, incremental vacuum);
  waterfall colored by service; failing-operation subline in the Traces list.
- **Jun 2 — wizard + Situations.** **Removed** the forced synthetic
  "Verify gateway → Helix" gate from Step 4 (real observation is the preferred
  signal; validation lives in Step 1's Test connection). **Show problematic
  span** in a Situation (event slots + the chromeless `/otel-data/embed` route
  iframed into a Helix dashboard).
- **Jun 3 — demo feedback → handoffs.** Five forward-looking briefs created
  (K8s, trace resource metrics, AIOps enrichment, auto-instrumentation, OTel
  Blueprints). Link Service is now wizard **Step 5** (the wizard is 5 steps).
- **Jun 5 — native packaging shipped.** The configurator is now distributed as
  a pre-built native package (4 platform zips via GitHub Releases); Docker
  Desktop is no longer required to run it. The gateway is created by the
  configurator itself on first Docker-target use (`createGatewayFromScratch()`).
  Fan-out flipped to `host.docker.internal:8765`. The demo AIOps page extracted
  into the standalone `helix-aiops-mock` project. Update banner added
  (`GET /api/version`). The Docker image remains as a secondary path.

Net: a local OTel onboarding sidecar grew a full local APM viewer, a synthetic
demo data generator, a deepening AIOps/Situations integration, and a
Docker-Desktop-free native distribution aimed at the NOC/ops persona.

---

## 14. Where to find things (doc map)

| You want… | Go to |
|---|---|
| Quickstart, env vars, feature summary | root [`README.md`](../README.md) |
| Architecture tour (concepts, data flow, API) | [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) |
| Deeper per-component engineering reference | [`architecture/Blueprints-v1.md`](architecture/Blueprints-v1.md) |
| Expose the configurator for a remote demo | [`guides/cloudflare-tunnel-demo.md`](guides/cloudflare-tunnel-demo.md) |
| What's planned / open | [`roadmap/`](roadmap/) |
| Future-work brainstorm briefs | [`handoffs/`](handoffs/) |
| Why a feature was built the way it was | [`superpowers/specs/`](superpowers/specs/) + `superpowers/plans/` |
| Completed checklists, the Gartner mapping, kickoff prompts | [`history/`](history/) |
| Superseded/inaccurate docs (don't follow) | [`deprecated/`](deprecated/) |
| The full folder map + conventions | [`docs/README.md`](README.md) |

**Documentation conventions:** only Markdown is version-controlled
(`docs/.gitignore`); artifacts/deck/venv/`.env` template are local-only. The
`superpowers/` archive is appended to by ongoing design work. When a doc and the
code disagree, **trust the code**.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **helix-gateway** | The managed `otel/opentelemetry-collector-contrib` container that forwards telemetry to Helix and fans a copy to the configurator. |
| **helix-configurator** | The Express + React app: UI, API, SQLite trace store, Docker control. Runs as a host process (native) or a container (Docker image path). |
| **helix-aiops-mock** | Standalone demo project (port `:9000`) that simulates the BMC AIOps "Manage OTel" install page, serving install scripts that point at GitHub Releases. |
| **helix-bridge** | The Docker network the gateway starts on; the gateway is also attached to the customer's network at runtime. |
| **native package** | Pre-built per-platform zip (darwin-arm64/amd64, linux-amd64, windows-amd64) containing a Node.js runtime + backend + frontend-dist. Launched by `start.command/.sh/.bat`. |
| **X-Source** (`X_SOURCE`) | A per-export-connection header tagging the telemetry source; becomes the OTel Namespace only as a fallback for un-namespaced spans. |
| **OTel Namespace** | `service.namespace`; the Helix dimension a Business Service binds. |
| **OTel Service** | `service.name`; a service identity within a namespace. |
| **Business Service** | An AIOps construct binding one or more OTel Namespaces; health and Situations roll up to it. `BUSINESS_SERVICE_KEY` is its opaque key. |
| **Fan-out** | The gateway sending each trace/log to both Helix and the local viewer (`otlphttp/bmchelix` + `otlphttp/helix_local_viewer`). |
| **Event** | A single signal posted to Helix's events-service. |
| **Situation** | An AIOps aggregation of related events, formed (here) by the configurator-provisioned correlation policy. |
| **OTEL_TRACE_ANOMALY** | The event class the configurator provisions for anomaly events. |
| **Step Zero** | The `/step-zero` surface: synthetic-data generator + instrument-your-apps guide. |
| **Smart-add** | One-click merge of the `helix-gateway` exporter into a detected upstream collector's config. |
| **IMS** | BMC's Identity Management System; exchanges the OTLP access key for a Bearer JWT for events/aiops-config APIs. |
| **CMDB wall** | The service-model/CMDB layer that 401s the OTLP key — why Business-Service creation can't be automated. |
| **CRISP overlay** | The waterfall's highlighting of the actually-blocking portion of an on-path span. |
| **TRACE_CAP** | The 1000-trace sliding-window cap on the local store. |
| **Diagnostic namespace** | The hardcoded internal namespace tagging synthetic demo data so it stays quarantined from the real X-Source. |
| **superpowers** | The spec→plan→implement planning workflow whose dated artifacts form the project's design memory. |
| **ADAPT** | BMC's design system; its tokens drive the Tailwind theme. |
| **RED** | Rate / Errors / Duration — the per-operation health metrics the Operations tab aggregates. |
| **N+1** | A query anti-pattern flagged when 5+ spans in a trace share a `db.operation` (+ `db.name`). |
