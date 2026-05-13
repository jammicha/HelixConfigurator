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
# the full URL and the UI will extract the key. Also used as the topology
# pin (`service_id` / `business_service_key` slots) on Helix Events sent
# from the trace detail drawer's "Send to AIOps" action, so a single trace
# lands on this Business Service instead of duplicating across every
# service that shares its OTel `service.name`.
BUSINESS_SERVICE_KEY=

# Optional: BMC Helix events-service base URL. Only needed when your tenant
# serves Events on a different host than `HELIX_ENDPOINT` (the OTLP ingest
# host). Default behavior is to use the origin of `HELIX_ENDPOINT`.
HELIX_EVENTS_ENDPOINT=

# Optional: require sign-in to the configurator UI. Leave blank for open access.
UI_AUTH_PASSWORD=

# Internal: container the configurator manages. Leave as default unless renaming.
TARGET_CONTAINER_NAME=helix-gateway

# Optional: gate the demo install bundle (the simulated AIOps "Manage
# OpenTelemetry" wizard and its install-bundle generator). Defaults to true
# for backward compatibility with the in-repo .env. Set to `false` in a real
# product deployment so the /api/_demo/aiops/* routes return 404 and the
# demo plumbing is invisible to clients. See the "Demo install bundle"
# section below for what this gates.
IS_DEMO_INSTALL=true
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

On first run, the UI walks you through a four-step onboarding wizard:

1. **Configure** — capture credentials (endpoint, API key, X-Source, optional App URL) and save + restart the gateway. The wizard validates each field as you type and auto-rebuilds the canonical `tenant::seg1::seg2` key from a pasted Helix-portal bundle.
2. **Exporter** — paste-ready snippets for adding `helix-gateway` as an `otlphttp` exporter to your existing collector's pipelines. When a single OTel collector is detected on the host, **Smart-add** offers to read its config, compute the merge, preview the diff, and apply it for you (with a `.helix-bak` and an automatic container restart). See [Smart-add](#smart-add) below.
3. **Connect** — ensures `helix-gateway` shares a Docker network with your collector. Surfaces the result of the auto-bridge attempt from Step 1 and offers one-click attach to any detected collector network, with a manual fallback. Detects Kubernetes-based collectors and offers a one-click apply of the K8s Attribute Enrichment template.
4. **Verify** — live span/metric/log counters since the step opened, a synthetic `Gateway → Helix` round-trip check, app-side OTel export error detection, and a launch button for the dashboard.

The stepper at the top is clickable for any step you've completed, so you can jump back to fix something without losing state.

The nav bar (`Onboarding | Gateway Dashboard | View OTel Data`) lets you move between the wizard, the operator dashboard, and the local trace viewer at any time.

### Smart-add

When exactly one OTel collector container is running alongside the configurator, Step 2 reads its mounted config and proposes a merge that wires `helix-gateway` in as an `otlphttp` exporter on every existing pipeline. The **Review changes** modal renders the proposed YAML with the added lines highlighted, surfaces the host-side path (if the config is bind-mounted, with a Copy-path button) and explains exactly which pipelines will be touched. Clicking **Apply & restart** writes the new config back inside the collector container, saves the original as `<config>.helix-bak`, and restarts the container so the change takes effect. Re-running Step 2 detects an already-applied exporter and reports "Already configured" rather than duplicating it. If smart-add can't read or merge the config (image-baked configs, unusual layouts), the wizard falls back to the copy-paste snippet path.

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
- **Helix Connection Settings** — edit env vars in-place; saving triggers a gateway restart so changes take effect immediately. The Settings card also displays whether the UI is open access or password-required, and includes a one-time **Provision event class** button that creates the `OTEL_TRACE_ANOMALY` custom event class on your tenant — required for the trace drawer's *Send to AIOps* dedup to work (re-sends update the existing Event instead of duplicating).
- **Gateway Config (YAML)** — Monaco-based editor with syntax highlighting, save-time validation (line-precise parse errors plus structural-lint warnings for typos like `recievers`, undefined pipeline references, missing `service` block), and `Cmd+S` / `Ctrl+S` to save.
  - **Load Template** — picker modal with built-in starting points: Default Sidecar, Prometheus Scrape, Tail Sampling for High-Volume Tracing, and Kubernetes Attribute Enrichment. Selecting a template loads its content into the editor with current env vars substituted; click Save Config to apply.
- **Diagnostic Log Stream**
  - Streams logs from whichever target is active: the attached service if one exists, otherwise the gateway.
  - Filter toggle: *Helix Only* (default — keyword-filtered to ingestion-relevant lines) or *All Logs*.
  - Smart auto-scroll (follows new lines only when you're at the bottom).
  - **Show Raw Metrics** — opens the gateway's `:8888/metrics` endpoint in a modal with relevant-only filtering and copy-to-clipboard, useful for verifying counter values directly.

## View OTel Data

Open the **View OTel Data** nav item or visit `/otel-data` to explore traces, logs, and errors locally — no Jaeger or external trace store required. The gateway fan-outs traces and logs to the configurator over the local network and the page renders them via SSE.

Page-level controls (top-right of the header) apply to every tab:

- **Range** — relative ranges (`5m` / `15m` / `1h` / `6h` / `24h`) plus a `Custom…` option for explicit start/end windows.
- **Stream mode** — `Live` (SSE + 30 s rollup poll), `30s` / `1m` / `5m` (snapshot polls, no realtime), or `Paused` (frozen view for reading). Replaces the previous separate Pause toggle and auto-refresh selector.
- **Slow threshold** — duration above which traces and spans are flagged slow (250 ms / 500 ms / 1 s / 2 s / 5 s / 10 s presets). Drives the *Slow* status filter, duration coloring, and the histogram's ok/slow segmentation.

Three top-level tabs:

- **Traces.** Realtime list with filters for service, status (Error / Slow / OK / **Outlier** — traces > 2× p95 of their operation), min duration, and a server-side search across operation / service / trace-id (debounced; matches past the 200-row cap stay reachable). Each row carries inline rollup badges for errors, DB calls, and log records, plus a one-click **View in Helix** deep-link to the `OTelTraceDetails` dashboard with the trace pre-selected. URL state is shareable: filters and the selected trace persist across reloads.
- **Operations.** Per `service · operation` aggregates over the selected time range: count, p50, p95, max, error %, slow %. Sortable by every column. Click an operation to jump to the Traces tab pre-filtered for it.
- **Logs & Errors.** Two sub-tabs: **Logs** (severity filter, body+service search) and **Errors** (grouped by `exception_type × service` by default with first-seen / last-seen / sample expander; toggle Flat for the chronological timeline).

Trace detail (click a row in Traces):

- **Send to AIOps.** Top-right of the drawer: posts the trace into BMC Helix as an Event via the Events API. Severity is derived from the trace itself — `CRITICAL` when there's an error span, `MAJOR` when duration > 2× the operation's p95, `MINOR` otherwise. The button label changes accordingly (*Send anomaly to AIOps* vs *Send to AIOps as event*), and the icon is colored to match. Sends are deduped on `helix_trace_id` server-side; re-clicks are warned about in the UI (the button reads *Sent — send again?* with a relative timestamp). Pinning to one Business Service requires `BUSINESS_SERVICE_KEY` to be set and the `OTEL_TRACE_ANOMALY` event class to be provisioned (one-time button on the Settings card — see Features above).
- **View in Helix.** Deep-link to the `OTelTraceDetails` dashboard for this trace.
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

## Demo install bundle (`/api/_demo/aiops/*`)

A second set of routes lives under the `/api/_demo/aiops/` namespace. These are **not** product features — they simulate the BMC Helix AIOps "Manage OpenTelemetry" page so a prospect can experience the full onboarding flow (generate an install command → run it → land in the configurator UI) without a real AIOps tenant on the other end.

What the demo plumbing does:
- The `/aiops` page on the configurator collects an `X-Source` name and POSTs to `/api/_demo/aiops/configure`. The backend fabricates a `FAKE-KEY-…` API key, parks it in an in-memory session, and returns a copyable `curl … | bash` / `iwr … | iex` one-liner.
- That installer hits `/api/_demo/aiops/install/<token>.{sh,ps1}` to fetch the platform-specific install script, which in turn downloads `/api/_demo/aiops/package/<token>` — a generated zip containing the configurator source, a templated `helix-otel-collector.yaml`, a `.env` with the fake key, double-click launchers, and a README.
- The bundle's `.env` ships `HELIX_ENDPOINT=https://your-tenant.onbmc.com` as an obvious placeholder; the user replaces it on the configurator's Settings page on first run.

What it would look like in a real-product deployment:
- A real AIOps page would generate the install command (the configurator would not host the page).
- A real tenant would supply the actual `HELIX_ENDPOINT` and `HELIX_API_KEY`, not the placeholder + fake.
- The fan-out `otlphttp/helix_local_viewer` exporter in `helix-otel-collector.yaml` (which feeds the local View OTel Data page) is **not** demo plumbing — it's part of the configurator's standalone-sidecar story and ships in either world.

To hide the demo namespace entirely:

```env
IS_DEMO_INSTALL=false
```

Setting the flag makes the four `/api/_demo/aiops/*` routes return 404 and the `/aiops` SPA page becomes a dead end. All other `/api/*` routes (the real OTel data, gateway management, diagnostics) are unaffected.

The boundary is also visible in source: every demo-only renderer (`renderCollectorYaml`, `renderEnvFile`, `renderDockerCompose`, `renderBashInstaller`, `renderPowerShellInstaller`, `writePackageToArchive`, …) lives in `backend/routes/demo.js` and nowhere else. A new contributor reading the code can tell at a glance which surfaces are product and which are sales-tool.

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
