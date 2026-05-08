# Helix Configurator

The Helix Configurator is a local diagnostic and management tool that simplifies onboarding OpenTelemetry data to BMC Helix. It runs as a sidecar pair (a configurator UI + an OpenTelemetry Collector "gateway") and provides a web UI to:

- Configure and edit the collector's YAML pipeline.
- Validate configuration syntax, API key format, and tenant connectivity.
- Bridge local application containers onto the same Docker network as the gateway so their telemetry can flow through.
- Stream collector and per-service logs in real time.
- Inject synthetic traces and verify telemetry is reaching Helix.
- Deep-link into BMC Helix dashboards and AIOps for the configured business service.
- Explore traces, logs, errors, and per-operation health locally via the **View OTel Data** page — a built-in APM-style viewer fed by a parallel fan-out from the gateway.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

## Getting Started

### 1. Configure environment variables

Create a `.env` file in the repo root with the following:

```env
# Required
HELIX_ENDPOINT=https://your-tenant.onbmc.com
HELIX_API_KEY=TenantID::AccessKey::SecretKey
X_SOURCE=your-business-service-name

# Optional — used for the "Open application" deep-link on the dashboard, and
# (when its hostname is a Docker container name on this host) to auto-bridge
# helix-gateway to your app's compose network. localhost / IP / public URL is
# fine — auto-bridge just skips and you wire the network from the Step 2
# onboarding controls instead.
APP_URL=http://localhost:8080

# Optional: deep-link to AIOps Business Service. Paste the opaque key from
# https://<tenant>/aiops/#/entities/service/<KEY>?type=key — you can also paste
# the full URL and the UI will extract the key.
BUSINESS_SERVICE_KEY=

# Optional: require sign-in to the configurator UI. Leave blank for open access.
UI_AUTH_PASSWORD=

# Internal: container the configurator manages. Leave as default unless renaming.
TARGET_CONTAINER_NAME=helix-gateway
```

The `helix-otel-collector.yaml` shipped in the repo references these via `${env:HELIX_ENDPOINT}` / `${env:HELIX_API_KEY}` / `${env:X_SOURCE}`, so secrets stay in `.env` (which is gitignored) and never land in committed config.

Notes:
- `HELIX_ENDPOINT` is the bare tenant URL — do **not** append `/otlp/v1/traces`. The gateway adds the path itself.
- `HELIX_API_KEY` is three parts joined by `::`. The configurator validates the structure and rejects single-token strings.
- `X_SOURCE` becomes the `service.namespace` / Business Service identifier in Helix.
- `UI_AUTH_PASSWORD` enables shared-password sign-in to the configurator UI. Leave blank for open access. This is "prevent casual access" — anyone wanting real authentication should put an SSO proxy in front.

### 2. Start the services

```bash
docker-compose up --build -d
```

This builds the configurator image, starts the OpenTelemetry Collector (`helix-gateway`) with your config mounted, and exposes the UI on `http://localhost:8765`.

### 3. Open the UI

- **Local:** [http://localhost:8765](http://localhost:8765)
- **Remote (SSH tunnel):**
  ```bash
  ssh -L 8765:localhost:8765 <user>@<server>
  ```
  Then open `http://localhost:8765` locally.

On first run, the UI walks you through a two-step onboarding wizard: capture credentials and restart the gateway, then route your telemetry. Step 2 detects existing OTel collectors on the host and offers one-click network attachment, surfaces the result of the auto-bridge attempt, includes copy-pasteable snippets for both collector-YAML and SDK-env-var instrumentation paths, and reminds you to restart your collector container after the change so gRPC re-resolves `helix-gateway`.

The nav bar (`Onboarding | Gateway Dashboard | View OTel Data`) lets you move between the wizard, the operator dashboard, and the local trace viewer at any time.

## Features

After onboarding, the dashboard provides:

- **Helix Gateway Status** — start/stop/restart controls with live container state.
- **Operation Shortcuts**
  - **Run Diagnostic Health Check** — toggles a 5-minute deep-diagnostic session: 4 status cards (Collector Configuration, X-API Key Format, X-Source Format, Tenant URL Endpoint), live `received` / `sent` / `dropped` counters with rolling 3-minute trend sparklines, log streaming, and synthetic trace injection.
  - **Discovered Services** — slide-out panel listing local Docker containers; click *Attach to Bridge* to wire an app's telemetry through the gateway.
  - **Re-verify Telemetry Flow** — one-click check that data is reaching Helix, with a count snapshot in the toast.
  - **Copy Support Bundle** — copies a sanitized snapshot (env with API key redacted, container status, diagnostic check results, live metrics, last 5 log lines) to the clipboard for support tickets.
  - **Helix OTel Dashboard** — deep-link to the namespace overview dashboard.
  - **AIOps Business Service** — deep-link to the configured business service in AIOps (requires `BUSINESS_SERVICE_KEY`).
  - **Application UI** — opens `APP_URL`.
- **Helix Connection Settings** — edit env vars in-place; saving triggers a gateway restart so changes take effect immediately. The Settings card also displays whether the UI is open access or password-required.
- **Gateway Config (YAML)** — Monaco-based editor with syntax highlighting, save-time validation (line-precise parse errors plus structural-lint warnings for typos like `recievers`, undefined pipeline references, missing `service` block), and `Cmd+S` / `Ctrl+S` to save.
  - **Load Template** — picker modal with built-in starting points: Default Sidecar, Prometheus Scrape, Tail Sampling for High-Volume Tracing, and Kubernetes Attribute Enrichment. Selecting a template loads its content into the editor with current env vars substituted; click Save Config to apply.
- **Diagnostic Log Stream**
  - Streams logs from whichever target is active: the attached service if one exists, otherwise the gateway.
  - Filter toggle: *Helix Only* (default — keyword-filtered to ingestion-relevant lines) or *All Logs*.
  - Smart auto-scroll (follows new lines only when you're at the bottom).
  - **Show Raw Metrics** — opens the gateway's `:8888/metrics` endpoint in a modal with relevant-only filtering and copy-to-clipboard, useful for verifying counter values directly.

## View OTel Data

Open the **View OTel Data** nav item or visit `/otel-data` to explore traces, logs, and errors locally — no Jaeger or external trace store required. The gateway fan-outs traces and logs to the configurator over the local network and the page renders them via SSE.

Three top-level tabs:

- **Traces.** Realtime list with filters for service, status (Error / Slow / OK / **Outlier** — traces > 2× p95 of their operation), min duration, time range, and free-text search across operation/service/trace ID. The Stream pill pauses the live feed without disconnecting it. Each row carries inline rollup badges for errors, DB calls, and log records, plus a one-click **View in Helix** deep-link to the `OTelTraceDetails` dashboard with the trace pre-selected. URL state is shareable: filters and the selected trace persist across reloads.
- **Operations.** Per `service · operation` aggregates over the selected time range: count, p50, p95, max, error %, slow %. Sortable by every column. Click an operation to jump to the Traces tab pre-filtered for it.
- **Logs & Errors.** Two sub-tabs: **Logs** (severity filter, body+service search) and **Errors** (grouped by `exception_type × service` by default with first-seen / last-seen / sample expander; toggle Flat for the chronological timeline). Both pause independently from the Traces feed.

Trace detail (click a row in Traces):

- **Service breakdown.** Stacked bar showing wall-clock time per service in the trace, with intervals merged so parallel spans don't double-count.
- **SQL rollup.** DB spans grouped by system + statement (or operation if no statement was captured) with count, total time, slowest exemplar. N+1 detection alert fires when 5+ spans share a `db.operation`.
- **HTTP outbound rollup.** Client-kind spans grouped by method + normalized path, with status pills color-coded by class.
- **Waterfall ↔ Flame view toggle.** Waterfall is the conventional one-row-per-span timeline. Flame is the same data laid out as an icicle (top-down by depth), colored by service. The critical path is highlighted in both — off-path spans dim, the actually-blocking portion of each on-path span gets a darker overlay (CRISP-style).
- **Span details.** Expanding a span reveals attributes, attached logs (with severity-tinted badges), exception events with stack traces, and a dedicated DB-call panel for spans that have `db.system` but no statement (Redis, Valkey, .NET, Mongo).

Diagnostics popover (top-right of the page) lists detected upstream OTel collectors and offers a one-click **Restart** action — useful when the demo collector's `memory_limiter` trips after long runs and the trace stream stalls.

## Container & Port Reference

| Service | Container | Host Port | Purpose |
|---|---|---|---|
| `helix-configurator` | `helix-configurator` | 8765 → 3001 | Configurator UI + backend API |
| `helix-gateway` | `helix-gateway` | 4317 | OTLP gRPC receiver |
| `helix-gateway` | `helix-gateway` | 4318 | OTLP HTTP receiver |
| `helix-gateway` | `helix-gateway` | 8888 | Prometheus metrics endpoint (used by the diagnostic counters) |

Both containers attach to the `helix-bridge` Docker network. Application containers can be attached to the same network at runtime via the *Discovered Services* panel — once attached, point your app's OTel exporter at `helix-gateway:4317` and `X-Api-Key` / `X-Source` headers will be injected by the gateway.

The gateway also fan-outs traces and logs to the configurator backend (`POST /api/otlp/traces`, `POST /api/otlp/logs`) so the local **View OTel Data** page can render them. The trace store is a SQLite database mounted at `./data/otel-store.db` (capped at 500 traces, sliding window) and persists across container restarts.

The configurator also exposes a public `GET /api/health` endpoint (returns `{ ok: true, version }`) for liveness probes — bypasses the auth gate so it works in unauthenticated orchestrator checks.

## Troubleshooting & Management

- View configurator logs:
  ```bash
  docker logs helix-configurator
  ```
- View gateway (OTel Collector) logs:
  ```bash
  docker logs helix-gateway
  ```
- Stop and remove containers:
  ```bash
  docker-compose down
  ```
- Reset the gateway to a fresh state without losing settings:
  Use the **Restart** button in the UI's *Helix Gateway Status* card.

## Development

To run the components outside Docker:

### Backend
```bash
cd backend
npm install
npm run dev   # starts on :3001
```

### Frontend
```bash
cd frontend
npm install
npm run dev   # starts Vite dev server on :3000
```

The frontend dev server proxies `/api/*` to `http://localhost:3001`. Both halves can run concurrently while developing.

## Known Issues

- **`dompurify` advisories via `monaco-editor` 0.55.1.** `npm audit` reports moderate XSS advisories in `dompurify`, pulled in transitively by `monaco-editor`. The fix is only available in monaco-editor `0.56.0-dev-*` prereleases; there is no stable release with the patch yet. Practical risk is low — the editor only loads our own YAML config and never renders user-controlled HTML/markdown. Revisit when monaco-editor 0.56.0 stable ships.
- **`esbuild` advisory via `vite` ≤ 6.4.1.** Affects only the Vite dev server and does not ship in production builds. The fix requires upgrading to Vite 8 (a major migration); deferred.
