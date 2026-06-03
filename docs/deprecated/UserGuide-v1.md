# Helix OpenTelemetry Configurator User Guide

## Introduction
The Helix Configurator is a local diagnostic tool that simplifies onboarding OpenTelemetry data to BMC Helix. It runs as a sidecar pair — a configurator UI plus a managed OpenTelemetry Collector ("helix-gateway") — and gives you a secure, web-based UI to configure the collector, validate connectivity, attach your application's telemetry, and confirm data is reaching Helix.

## Phase 1: SaaS Configuration & Install Command
1. Log into your BMC Helix AIOps portal.
2. Navigate to the **Manage OpenTelemetry** page.
3. Enter a **Name** for the data source (this becomes the `X-Source` / Business Service identifier in Helix).
4. Click **Configure**. The portal generates an API key and shows the install command for your platform.
5. Pick your **Hosting Provider** (My Host) and **Platform** (Mac, Linux, or Windows). Copy the generated one-line install command — it embeds your API key and tenant settings.
6. Optional: click **Download .zip** for a manual install bundle (`start.command` / `start.bat` / `start.sh` plus `docker-compose.yml`, `.env`, and `helix-otel-collector.yaml`).

## Phase 2: Host Deployment
1. Open a terminal (Terminal on macOS, your shell of choice on Linux, or PowerShell on Windows) on the host where your application runs.
2. Confirm Docker Desktop / Docker Engine is installed and running.
3. Paste and run the install command from Phase 1. It downloads the package, builds the configurator image, starts the OpenTelemetry Collector with your config mounted, and waits for the UI to come up.
   * Mac / Linux: `curl -sSL <portal-url>/api/aiops/install/<token>.sh | bash`
   * Windows (PowerShell): `iwr -useb <portal-url>/api/aiops/install/<token>.ps1 | iex`
4. When the script reports `Configurator UI: http://localhost:8765`, deployment is complete. The script will also try to open the URL automatically.

Manual fallback: unzip the downloaded archive and run `start.command` (Mac) / `start.sh` (Linux) / `start.bat` (Windows). On macOS, follow the README's Gatekeeper workaround if the script is blocked on first launch.

## Phase 3: Secure Dashboard Access
* **Local access:** open your browser to `http://localhost:8765`.
* **Remote access (SSH tunnel):** if the Configurator runs on a remote, headless server, open a terminal on your local workstation and run:
  ```bash
  ssh -L 8765:localhost:8765 <your-username>@<server-ip>
  ```
  Then navigate to `http://localhost:8765` in your local browser.
* **Optional sign-in:** if `UI_AUTH_PASSWORD` is set in `.env`, the UI prompts for that shared password before loading. Leave it blank for open access; for stronger auth, put an SSO proxy in front.

## Phase 4: Onboarding Wizard
First-time visitors land in a two-step wizard. Returning visitors with saved settings go straight to the dashboard (Phase 5).

**Step 1 — Configure & Initialize Gateway.** Enter or confirm:
* `HELIX_ENDPOINT` — the bare tenant URL (e.g. `https://your-tenant.onbmc.com`). Do **not** append `/otlp/v1/traces`; the gateway adds the path.
* `X-Source` — your Business Service name.
* `HELIX_API_KEY` — three parts joined by `::` (`TenantID::AccessKey::SecretKey`). Single-token strings are rejected.
* `APP_URL` (optional) — used for the **Open application** deep-link on the dashboard. When the hostname is a Docker container name on this host (e.g. `frontend-proxy`), the gateway also auto-bridges to that container's compose network. `localhost`, an IP, or a public URL is fine — auto-bridge just skips, and you wire the network from Step 2.

Click **Save & Initialize**. The configurator writes `.env`, restarts `helix-gateway`, and (when possible) auto-attaches the gateway to your application's Docker network. The result of the bridge attempt — success / skipped / failed — is surfaced as a banner at the top of Step 2 so you know exactly what happened.

**Step 2 — Route Your Telemetry.** Point your application at `helix-gateway:4318` (HTTP) or `helix-gateway:4317` (gRPC). The wizard auto-detects how your app is instrumented and shows the right snippet:
* **Collector YAML** — adds an `otlphttp/helix_sidecar` exporter pointed at `helix-gateway:4318`. Headers are unnecessary on this hop because the gateway holds the `X-Api-Key` / `X-Source` and adds them when forwarding to Helix. After saving the config, restart the collector container so it re-reads the file and gRPC re-resolves the gateway hostname.
* **OTEL Env Vars** — sets `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_PROTOCOL` on the application container. Headers are again unnecessary; helix-gateway adds them.

A **Shared-network requirement** callout sits below the snippet. The configurator scans the Docker host for OTel collector containers and lists them with their networks. If `helix-gateway` already shares a network with one (✓ reachable), you're done; otherwise click **Attach** to wire the gateway onto that network in one call. Manual fallback (`docker network connect <network> helix-gateway`) is shown as a copy-pasteable snippet too. There's also a button to open the **Discovered Services** sidebar if you'd rather attach a target container to `helix-bridge` instead of the other way around.

The **App → Gateway (live)** panel polls the gateway every 2 seconds and shows the spans, metric points, and log records accepted since you opened Step 2 — the numbers should climb within seconds of restarting your app. If the gateway sees export errors from your container, they surface here with common-fix hints.

Click **Verify Gateway → Helix** to inject a synthetic trace and confirm the gateway → Helix hop independently of your app, then **Launch Dashboard** when ready.

## Phase 5: Dashboard, Diagnostics, and Validation
After launching the dashboard you have a left-anchored nav with **Onboarding | Gateway Dashboard | View OTel Data** — switch back to the wizard at any time, or jump to the local trace viewer (Phase 6). On the dashboard itself:

* **Helix Gateway Status** — live state plus Start / Stop / Restart controls. Use **Restart** to apply config changes.
* **Operation Shortcuts**
  * **Run Diagnostic Health Check** — opens a 5-minute deep-diagnostic session: four status cards (Collector Configuration, X-API Key Format, X-Source Format, Tenant URL Endpoint), live `received` / `sent` / `dropped` counters with rolling 3-minute trend sparklines, log streaming, and synthetic trace injection. Failed checks expand inline with actionable fixes.
  * **Discovered Services** — slide-out panel listing local Docker containers; click **Attach to Bridge** to wire an application's telemetry through the gateway.
  * **Re-verify Telemetry Flow** — one-click check that data is still reaching Helix, with a count snapshot in the toast.
  * **Copy Support Bundle** — copies a sanitized snapshot (env with API key redacted, container status, diagnostic results, live metrics, last 5 log lines) to the clipboard for support tickets.
  * **Helix OTel Dashboard** / **AIOps Business Service** / **Application UI** — deep-links to the namespace overview, the configured business service (requires `BUSINESS_SERVICE_KEY`), and your `APP_URL`.
* **Helix Connection Settings** — edit env vars in place; saving triggers a gateway restart so changes take effect immediately. Also displays whether the UI is open access or password-required.
* **Gateway Config (YAML)** — Monaco-based editor with syntax highlighting, save-time validation (line-precise parse errors plus structural-lint warnings for typos like `recievers`, undefined pipeline references, missing `service` block), and `Cmd+S` / `Ctrl+S` to save.
  * **Load Template** — picker modal with built-in starting points: Default Sidecar, Prometheus Scrape, Tail Sampling for High-Volume Tracing, and Kubernetes Attribute Enrichment. Selecting a template substitutes current env vars and loads it into the editor; click **Save Config** to apply.
* **Diagnostic Log Stream**
  * Streams logs from whichever target is active — the attached application service if one exists, otherwise the gateway.
  * Filter toggle: **Helix Only** (default — keyword-filtered to ingestion-relevant lines) or **All Logs**.
  * Smart auto-scroll (follows new lines only when you're at the bottom).
  * **Show Raw Metrics** — opens the gateway's `:8888/metrics` endpoint in a modal with relevant-only filtering and copy-to-clipboard, useful for verifying counter values directly.

## Phase 6: Explore Local Telemetry — View OTel Data

The **View OTel Data** nav item (or `/otel-data` directly) is a built-in APM-style trace explorer fed by a parallel fan-out from the gateway. No Jaeger or external store; the configurator backend persists traces and OTel-native logs to a local SQLite database (sliding window, 500 traces) that survives container restarts.

Three top-level tabs:

* **Traces** — realtime list with filters for service, status (Error / Slow / OK / **Outlier**), min duration, time range, and free-text search across operation, service, and trace ID. The Stream pill (leftmost) pauses the live feed without disconnecting the SSE; press it again to resume. Each row carries inline rollup badges for errors, DB calls, and log records, plus an outlier badge when the trace runs >2× p95 of its operation. URL state (filters + selected trace) is preserved across reloads and shareable.
* **Operations** — per `service · operation` aggregates over the selected time range: count, p50, p95, max, error %, slow %. Sortable by every column; click an operation to jump to the Traces tab pre-filtered for it.
* **Logs & Errors** — two sub-tabs sharing one Stream pause toggle:
  * **Logs** — every OTel log record with severity filter (FATAL / ERROR / WARN / INFO / DEBUG / TRACE) and body+service search. Each row links back to its parent trace.
  * **Errors** — span exception events grouped by `exception_type × service` by default with first-seen, last-seen, and a sample expander. Toggle to **Flat** for the chronological timeline.

**Trace detail** opens as a side drawer when you click a trace row:

* **Service breakdown** — stacked bar showing wall-clock time per service in the trace, with intervals merged so parallel spans don't double-count.
* **SQL rollup** — DB spans grouped by system + statement (or operation when no statement was captured) with count, total time, slowest exemplar. An N+1 alert fires when 5+ spans share a `db.operation`.
* **HTTP outbound rollup** — client-kind spans grouped by method + normalized path, with status pills color-coded by class.
* **Waterfall ↔ Flame view toggle.** Waterfall is the conventional one-row-per-span timeline. Flame is the same data laid out as an icicle (top-down by depth, colored by service). The critical path is highlighted in both — off-path spans dim, and the actually-blocking portion of each on-path span gets a darker overlay (CRISP-style). A **Critical path only** checkbox in the waterfall header collapses the view to just the bottleneck chain.
* **Span expansion** — click any span row to reveal attributes, attached logs (with severity-tinted badges), exception events with stack traces, and a dedicated **DB call** panel for spans that have `db.system` but no statement (Redis, Valkey, .NET, Mongo).
* **View in Helix** — a button in the drawer header (and an `↗` per row) deep-links to the BMC Helix `OTelTraceDetails` dashboard with the trace ID, service, namespace, and timestamp pre-filled.

**Diagnostics popover** (top-right of the page) lists detected upstream OTel collectors and offers a one-click **Restart** action. Useful when the demo collector's `memory_limiter` trips after long runs and traces stop arriving despite the Stream pill showing Live.

**Show internal** toggle (next to Diagnostics) hides traces / logs / errors emitted by the configurator and gateway themselves so the page stays focused on application telemetry. Toggle on to debug the pipeline.

## Phase 7: Finalization and Cleanup
1. Confirm data export — watch the diagnostic counters climb, the Re-verify Telemetry Flow toast, or the corresponding dashboards in your BMC Helix portal.
2. Use **AIOps Business Service** to jump directly to your visual topology in Helix, or **Discovered Services** to deep-link from a specific container.
3. Close the SSH tunnel if you opened one. The configurator and `helix-gateway` containers continue running in the background and keep exporting data.
4. To stop everything, run `docker-compose down` from the install directory.

## Container & Port Reference

| Service | Container | Host Port | Purpose |
|---|---|---|---|
| `helix-configurator` | `helix-configurator` | 8765 → 3001 | Configurator UI + backend API |
| `helix-gateway` | `helix-gateway` | 4317 | OTLP gRPC receiver |
| `helix-gateway` | `helix-gateway` | 4318 | OTLP HTTP receiver |
| `helix-gateway` | `helix-gateway` | 8888 | Prometheus metrics endpoint (used by the diagnostic counters) |

Both containers attach to the `helix-bridge` Docker network. Application containers can be attached to that network from the **Discovered Services** panel; once attached, point your app's OTel exporter at `helix-gateway:4318` (or `:4317`) and the gateway injects the `X-Api-Key` and `X-Source` headers. The configurator also exposes `GET /api/health` for liveness probes — it bypasses the auth gate so it works in unauthenticated orchestrator checks.
