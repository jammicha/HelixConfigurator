# Helix Configurator

The Helix Configurator is a local diagnostic and management tool that simplifies onboarding OpenTelemetry data to BMC Helix. It runs as a sidecar pair (a configurator UI + an OpenTelemetry Collector "gateway") and provides a web UI to:

- Configure and edit the collector's YAML pipeline.
- Validate configuration syntax, API key format, and tenant connectivity.
- Bridge local application containers onto the same Docker network as the gateway so their telemetry can flow through.
- Stream collector and per-service logs in real time.
- Inject synthetic traces and verify telemetry is reaching Helix.
- Deep-link into BMC Helix dashboards and AIOps for the configured business service.
- Explore traces, logs, errors, and per-operation health locally via the **View OTel Data** page — a built-in APM-style viewer fed by a parallel fan-out from the gateway.

## Distribution

The configurator ships as a **pre-built native package** — no Docker Desktop or
Docker Compose required to run the configurator itself.

**Primary path — native package (recommended)**

1. Download the platform zip from **GitHub Releases**
   (`helix-configurator-darwin-arm64.zip`, `linux-amd64`, or `windows-amd64`).
   Intel Macs: use the Docker image path below — GitHub retired its Intel-Mac
   runners, so no `darwin-amd64` zip is built.
2. Extract the zip.
3. Run the launcher: `./start.command` (macOS), `./start.sh` (Linux), or
   `start.bat` (Windows). The launcher runs `./node backend/index.js` and opens
   the browser to `http://localhost:8765`.
   **macOS:** the package isn't code-signed yet, so Gatekeeper may block the
   first launch — right-click `start.command` → **Open** once, or clear the
   quarantine flag after extracting:
   `xattr -dr com.apple.quarantine helix-configurator/`.

No Docker is needed to run the configurator. Docker Engine (not necessarily
Docker Desktop) is needed only when you choose the **Docker** onboarding target
for your apps — so the configurator can create and manage the `helix-gateway`
collector container.

**Secondary path — Docker image (GHCR)**

The container image (`ghcr.io/jammicha/helixconfigurator`) remains published and
works as before with `docker compose up -d`. The image sets `PORT=3001`
internally; `docker-compose.yml` maps `8765:3001`.

**Local development** (no install needed): see [Development](#development).

---

## Getting Started

### 1. Configure environment variables

Create a `.env` file in the repo root (or the extracted package directory) with
the following:

```env
# Required
HELIX_ENDPOINT=https://your-tenant.onbmc.com
HELIX_API_KEY=TenantID::AccessKey::SecretKey
X_SOURCE=your-business-service-name

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

# Internal: update-check repo (matches GitHub Releases). Leave as default.
# RELEASES_REPO=jammicha/HelixConfigurator
```

The `helix-otel-collector.yaml` shipped in the repo references these via `${env:HELIX_ENDPOINT}` / `${env:HELIX_API_KEY}` / `${env:X_SOURCE}`, so secrets stay in `.env` (which is gitignored) and never land in committed config.

Notes:
- `HELIX_ENDPOINT` is the bare tenant URL — do **not** append `/otlp/v1/traces`. The gateway adds the path itself.
- `HELIX_API_KEY` is three parts joined by `::`. The configurator validates the structure and rejects single-token strings.
- `X_SOURCE` is the telemetry **source** header. In Helix it becomes the *OTel Namespace* only for apps that don't set their own `service.namespace` (Business Services bind to that namespace). Onboarding several apps? Give each its own `service.namespace` so they stay distinct — see [Onboarding multiple applications](#onboarding-multiple-applications).
- `UI_AUTH_PASSWORD` enables shared-password sign-in to the configurator UI. Leave blank for open access. This is "prevent casual access" — anyone wanting real authentication should put an SSO proxy in front.

### 2. Start the configurator

**Native package (primary):** run the launcher from the extracted directory:

```bash
./start.sh          # Linux
./start.command     # macOS (or double-click in Finder)
start.bat           # Windows
```

The launcher runs `./node backend/index.js`, waits for `:8765/api/health`, then
opens the browser automatically.

**Docker image (secondary):**

```bash
docker-compose up -d
```

This starts the pre-built GHCR image (container on port 3001, mapped to host
port 8765) and the gateway. No local build required.

### 3. Open the UI

- **Local:** [http://localhost:8765](http://localhost:8765)
- **Remote (SSH tunnel):**
  ```bash
  ssh -L 8765:localhost:8765 <user>@<server>
  ```
  Then open `http://localhost:8765` locally.

On first run, the UI walks you through a five-step onboarding wizard:

1. **Configure** — capture credentials (endpoint, API key, X-Source) and save + restart the gateway. The wizard validates each field as you type and auto-rebuilds the canonical `tenant::seg1::seg2` key from a pasted Helix-portal bundle. A **Test connection** button probes the typed endpoint and API key against Helix before you commit them.
2. **Exporter** — paste-ready snippets for adding `helix-gateway` as an `otlphttp` exporter to your existing collector's pipelines. When a single OTel collector is detected on the host, **Smart-add** offers to read its config, compute the merge, preview the diff, and apply it for you (with a `.helix-bak` and an automatic container restart). See [Smart-add](#smart-add) below.
3. **Connect** — ensures `helix-gateway` shares a Docker network with your collector. Surfaces the result of the auto-bridge attempt from Step 1 and offers one-click attach to any detected collector network, with a manual fallback. Detects Kubernetes-based collectors and offers a one-click apply of the K8s Attribute Enrichment template.
4. **Verify** — live span/metric/log counters since the step opened, app-side OTel export error detection, and a launch button for the dashboard. This step is read-only observation (the *Next* button is always enabled); validating your key and endpoint now happens up front via Step 1's **Test connection** rather than a synthetic round-trip.
5. **Link Service** — a guided flow that links the app's OTel namespace to a BMC Helix AIOps Business Service and captures its `BUSINESS_SERVICE_KEY`, so trace deep-links and *Send to AIOps* pin to a single service instead of fanning across everything that shares a `service.name`. The same flow is available later as a dashboard card. See [Bind the namespaces to a Business Service (in AIOps)](#bind-the-namespaces-to-a-business-service-in-aiops).

The stepper at the top is clickable for any step you've completed, so you can jump back to fix something without losing state.

The nav bar (`Onboarding | Gateway Dashboard | View OTel Data`) lets you move between the wizard, the operator dashboard, and the local trace viewer at any time.

### Smart-add

When exactly one OTel collector container is running alongside the configurator, Step 2 reads its mounted config and proposes a merge that wires `helix-gateway` in as an `otlphttp` exporter on every existing pipeline. The **Review changes** modal renders the proposed YAML with the added lines highlighted, surfaces the host-side path (if the config is bind-mounted, with a Copy-path button) and explains exactly which pipelines will be touched. Clicking **Apply & restart** writes the new config back inside the collector container, saves the original as `<config>.helix-bak`, and restarts the container so the change takes effect. Re-running Step 2 detects an already-applied exporter and reports "Already configured" rather than duplicating it. If smart-add can't read or merge the config (image-baked configs, unusual layouts), the wizard falls back to the copy-paste snippet path.

## Onboarding multiple applications

The configurator runs **one** gateway with **one** `X_SOURCE`, yet you can still land several applications in Helix as **separate OTel Namespaces** that roll up to a single Business Service. The key is `service.namespace`, **not** X-Source:

- In Helix, ingested data is organized **Business Service → OTel Namespace → OTel Service**, where *OTel Namespace* = the `service.namespace` resource attribute and *OTel Service* = `service.name`.
- The `X-Source` header is a coarse "source of the telemetry" tag. It becomes the namespace only as a **fallback**, for spans that carry no `service.namespace`. That's why a single un-namespaced app appears under `X_SOURCE` — but every app sharing the gateway would then collapse into that one namespace.
- So to keep applications distinct, give each its own `service.namespace`. The gateway still sends a single shared `X-Source`; the namespace is what separates them.

### Set each app's namespace

**At the app (simplest — works with or without a collector).** Set the resource attributes on the app's OTel SDK:

```bash
OTEL_SERVICE_NAME=<service-name>
OTEL_RESOURCE_ATTRIBUTES=service.namespace=<app>,deployment.environment=<env>
```

**In the app's collector (fallback — when you can't set the app's environment).** Add a `resource` processor and reference it on each pipeline:

```yaml
processors:
  resource/ns:
    attributes:
      - { key: service.namespace, value: <app>, action: upsert }

service:
  pipelines:
    traces:
      processors: [resource/ns, batch]   # add resource/ns to every pipeline
```

This is **independent of [Smart-add](#smart-add)**: smart-add only adds the `otlphttp` exporter and wires it into your pipelines' `exporters:` lists — it never touches `processors:`. The two edits don't collide, and a hand-added `resource` processor survives a smart-add run in any order.

### Recommended resource attributes

Only `service.name` is mandatory; the rest sharpen the Helix dashboards and topology (see BMC's [Ingesting data from OpenTelemetry](https://docs.bmc.com/xwiki/bin/view/IT-Operations-Management/Operations-Management/BMC-Helix-AIOps/aiops261/Using-OpenTelemetry-to-identify-application-issues/Ingesting-data-from-OpenTelemetry/)):

| Attribute | Status | Role |
|---|---|---|
| `service.name` | **Required** | Service identity = the *OTel Service* dimension. `OTEL_SERVICE_NAME` wins over a `service.name` set inside `OTEL_RESOURCE_ATTRIBUTES`. |
| `service.namespace` | Recommended | The *OTel Namespace* dimension → Business Service binding. The per-app key above. |
| `deployment.environment` | Recommended | Environment / tier (prod, staging, …). |
| `host.name` | Recommended | Host correlation. In Kubernetes, derive from `k8s.node.name` via a `resource` processor. |
| `service.version` | Optional | Version context. |
| `service.instance.id` | Optional | Distinguishes instances of the same service. |
| `k8s.*` (`cluster` / `namespace` / `pod` / `node`) | Recommended (k8s) | Topology CIs, via the `k8sattributes` processor — see the **Kubernetes Attribute Enrichment** template (*Load Template* in the Gateway Config editor). |

### Bind the namespaces to a Business Service (in AIOps)

Grouping namespaces under a Business Service is **AIOps console config, not the configurator**:

1. In BMC Helix AIOps, go to **Services → Create New Service** (or edit an existing one) and name it.
2. **Add Dynamic content → Default Blueprint for OTel Service**, then **select the OpenTelemetry namespace(s)** to include — a single Business Service can bind **several** namespaces.
3. **Save.** The **CI Topology** tab then shows the instrumented apps grouped by namespace under that one service, and health and Situations roll up to it.

## Generate a Kubernetes chart

Onboarding is **target-branched**: the wizard opens with a **"Where will this run?"** choice
(Docker / Kubernetes). The Kubernetes path generates this chart as a first-class step, then guides you
to point apps at the gateway Service and verify. The dashboard action below is the same generator, for
re-running after onboarding.

From the dashboard, **Quick actions → Generate Kubernetes deployment** emits a self-contained Helm
chart (`helix-otel/`) pre-wired to your Helix tenant from the current config. Deploy it in four steps:

**1. Download & unzip** the `.zip` from the dialog, then `cd` into the chart folder — run the rest
from there:
```bash
unzip ~/Downloads/helix-otel-chart.zip && cd helix-otel
```
_(Assumes your browser saved to `~/Downloads` — adjust the path if the `.zip` landed elsewhere.)_

**2. Create the Secret** with your Helix key. The dialog pre-fills this command with your *actual*
key (from the configurator's `.env`) so you can copy-paste it — tick *"Generating this for someone
else"* to get a placeholder instead:
```bash
kubectl create secret generic helix-key --from-literal=HELIX_API_KEY='<TenantID::AccessKey::SecretKey>'
```

**3. Install the chart**, referencing that Secret:
```bash
helm install helix . --set helix.existingSecret=helix-key
```

**4. Verify** — wait for the gateway pod and point your apps at it:
```bash
kubectl get pods                                 # wait for helix-gateway = Running
# apps in-cluster send to:  http://helix-gateway:4318
```

> **Local clusters (Docker Desktop k8s):** telemetry automatically flows back to
> `localhost:8765/otel-data` — the same built-in viewer you use in Docker mode. No
> port-forward needed; the gateway sends a copy to `host.docker.internal:8765`.
>
> **Remote / cloud clusters:** view your telemetry in BMC Helix. The local viewer is
> not reachable from a remote cluster, so the gateway sends to Helix only.

> **Secrets:** the chart also accepts `--set helix.apiKey=…` for throwaway demos, but that value
> lands in your shell history *and* Helm's in-cluster release storage (`helm get values` reveals it)
> — prefer `existingSecret`, and in production populate the Secret from a manager (External Secrets /
> Vault / Sealed Secrets). The chart expects the key under `HELIX_API_KEY` (override with
> `--set helix.existingSecretKey=…`).

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

Page-level controls (top-right of the header) apply to every tab:

- **Range** — relative ranges (`5m` / `15m` / `1h` / `6h` / `24h`) plus a `Custom…` option for explicit start/end windows.
- **Stream mode** — `Live` (SSE + 30 s rollup poll), `30s` / `1m` / `5m` (snapshot polls, no realtime), or `Paused` (frozen view for reading). Replaces the previous separate Pause toggle and auto-refresh selector.
- **Slow threshold** — duration above which traces and spans are flagged slow (250 ms / 500 ms / 1 s / 2 s / 5 s / 10 s presets). Drives the *Slow* status filter, duration coloring, and the histogram's ok/slow segmentation.

Three top-level tabs:

- **Traces.** Realtime list with filters for service, status (Error / Slow / OK / **Outlier** — traces > 2× p95 of their operation), min duration, and a server-side search across operation / service / trace-id (debounced; matches past the 200-row cap stay reachable). Each row carries inline rollup badges for errors, DB calls, and log records, plus a one-click **View in Helix** deep-link to the `OTelTraceDetails` dashboard with the trace pre-selected. URL state is shareable: filters and the selected trace persist across reloads.
- **Operations.** Per `service · operation` aggregates over the selected time range: count, p50, p95, max, error %, slow %. Sortable by every column. Click an operation to jump to the Traces tab pre-filtered for it.
- **Logs & Errors.** Two sub-tabs: **Logs** (severity filter, body+service search) and **Errors** (grouped by `exception_type × service` by default with first-seen / last-seen / sample expander; toggle Flat for the chronological timeline).

Trace detail (click a row in Traces):

- **Send to AIOps.** Top-right of the drawer: posts the trace into BMC Helix as an Event via the Events API. Severity is derived from the trace itself — `CRITICAL` when there's an error span, `MAJOR` when duration > 2× the operation's p95, `MINOR` otherwise. The button label changes accordingly (*Send anomaly to AIOps* vs *Send to AIOps as event*), and the icon is colored to match. Re-clicks for the same trace are warned about in the UI (the button reads *Sent — send again?* with a relative timestamp); a localStorage send-history disclosure logs every attempt. Pinning to one Business Service requires `BUSINESS_SERVICE_KEY` to be set.
- **View in Helix.** Deep-link to the `OTelTraceDetails` dashboard for this trace.
- **Service breakdown.** Stacked bar showing wall-clock time per service in the trace, with intervals merged so parallel spans don't double-count.
- **SQL rollup.** DB spans grouped by system + statement (or operation if no statement was captured) with count, total time, slowest exemplar. N+1 detection alert fires when 5+ spans share a `db.operation`.
- **HTTP outbound rollup.** Client-kind spans grouped by method + normalized path, with status pills color-coded by class.
- **Waterfall ↔ Flame view toggle.** Waterfall is the conventional one-row-per-span timeline. Flame is the same data laid out as an icicle (top-down by depth), colored by service. The critical path is highlighted in both — off-path spans dim, the actually-blocking portion of each on-path span gets a darker overlay (CRISP-style).
- **Span details.** Expanding a span reveals attributes, attached logs (with severity-tinted badges), exception events with stack traces, and a dedicated DB-call panel for spans that have `db.system` but no statement (Redis, Valkey, .NET, Mongo).

Diagnostics popover (top-right of the page) lists detected upstream OTel collectors and offers a one-click **Restart** action — useful when the demo collector's `memory_limiter` trips after long runs and the trace stream stalls.

## Port & Process Reference

| Deployment | Service | Where it runs | Host Port | Purpose |
|---|---|---|---|---|
| **Native (primary)** | `helix-configurator` | Host process | 8765 (default; override with `PORT` in `.env`) | Configurator UI + backend API |
| **Native (primary)** | `helix-gateway` | Docker container (created by the configurator) | 4317 / 4318 / 8888 | OTLP gRPC / HTTP receiver; Prometheus metrics |
| **Docker image (secondary)** | `helix-configurator` | Container on `helix-bridge` | 8765 → 3001 | Configurator UI + backend API |
| **Docker image (secondary)** | `helix-gateway` | Container on `helix-bridge` | 4317 / 4318 / 8888 | OTLP gRPC / HTTP receiver; Prometheus metrics |

In the native path the configurator is a **host process** (port `PORT`, default 8765). When you choose the Docker onboarding target, the configurator creates `helix-gateway` itself via dockerode — pulling the pinned `otel/opentelemetry-collector-contrib` release (same tag the generated Helm charts use), creating the `helix-bridge` network, and publishing ports 4317/4318/8888. The gateway's local fan-out endpoint is `http://host.docker.internal:8765` (the configurator is on the host, not in a container); `ExtraHosts: host.docker.internal:host-gateway` is injected so this resolves on Linux Docker Engine as well as Docker Desktop.

Application containers can be attached to the same `helix-bridge` network at runtime via the *Discovered Services* panel — once attached, point your app's OTel exporter at `helix-gateway:4317` or `:4318`.

The gateway fan-outs traces and logs to the configurator backend (`POST /api/otlp/traces`, `POST /api/otlp/logs`) so the local **View OTel Data** page can render them. The trace store is SQLite at `./data/otel-store.db` (time-based retention, 24h default, with a 25,000-trace safety cap — tune via `TRACE_RETENTION_HOURS` / `TRACE_CAP`) and persists across restarts.

The configurator exposes a public `GET /api/health` endpoint (returns `{ ok: true, version }`) for liveness probes and an `GET /api/version` endpoint that compares the embedded version to the latest GitHub release — the UI shows an "update available" banner when they differ.

## Demo — `helix-aiops-mock`

The demo workflow (simulating the BMC Helix AIOps "Manage OpenTelemetry" install
page) lives in its **own repo —
[github.com/jammicha/helix-aiops-mock](https://github.com/jammicha/helix-aiops-mock)**,
fully decoupled from this one. Run it with no clone:
`npx -y github:jammicha/helix-aiops-mock`. It is a small standalone Express app
(port `:9000`) that:

- Serves a mock "Manage OTel" form where you enter an X-Source name.
- Mints a session (token + fake API key) and returns a `curl … | bash` /
  `iwr … | iex` one-liner pointing at GitHub Releases.
- Serves templated bash/PowerShell install scripts that download the correct
  platform zip from `https://github.com/jammicha/HelixConfigurator/releases/latest/download/`,
  write a pre-filled `.env`, and launch `./node backend/index.js`.

In a real-product deployment the actual BMC Helix AIOps page would generate the
install command (the configurator never hosts it), and a real tenant would
supply the actual `HELIX_ENDPOINT` / `HELIX_API_KEY` instead of the placeholder
+ fake key.

The configurator itself has **no demo routes, no `/aiops` page, and no
`IS_DEMO_INSTALL` flag** — it is purely the product tool. The fan-out
`otlphttp/helix_local_viewer` exporter (which feeds **View OTel Data**) is
**not** demo plumbing — it ships in Docker mode and in local-cluster K8s mode
(rewritten to `host.docker.internal:8765` by the chart generator); remote K8s
deployments strip it.

## Troubleshooting & Management

- **Native:** the configurator logs to stdout in the terminal where you ran the launcher.
- View gateway (OTel Collector) logs:
  ```bash
  docker logs helix-gateway
  ```
- Stop the gateway container:
  ```bash
  docker stop helix-gateway
  ```
- **Docker image path:** stop both containers with:
  ```bash
  docker-compose down
  ```
- Reset the gateway to a fresh state without losing settings:
  Use the **Restart** button in the UI's *Helix Gateway Status* card.
- **Update the configurator:** re-run the install command from `helix-aiops-mock`
  or download the latest zip from GitHub Releases and extract over the existing
  directory (your `.env`, `helix-otel-collector.yaml`, and `data/` are
  preserved). The configurator UI shows an "update available" banner at the top
  of the page when a newer release is detected.

## Development

To run the components outside Docker:

### Backend
```bash
cd backend
npm install
npm run dev   # starts on :8765 (the default PORT)
```

### Frontend
```bash
cd frontend
npm install
npm run dev   # starts Vite dev server on :3000
```

The frontend dev server proxies `/api/*` to `http://localhost:8765` (the
backend's default port), so both halves can run concurrently with no extra
configuration.

## Known Issues

- **macOS Gatekeeper on first launch (native zips).** The bundled `node` binary and launcher aren't code-signed/notarized yet, so macOS blocks the first run of a browser-downloaded zip. Workaround: right-click `start.command` → **Open** once, or `xattr -dr com.apple.quarantine helix-configurator/`. Signing/notarization is on the productization backlog.
- _Resolved 2026-06:_ the previously documented `dompurify`/`monaco-editor` and `esbuild`/Vite advisories are gone — the editor moved to `@monaco-editor/react` and the build runs Vite 8. `npm audit` is clean in both packages.
