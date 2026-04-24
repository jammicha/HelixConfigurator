# Helix Configurator Technical Blueprint

## 1. Technology Stack

### Frontend
* Framework: React (via Vite)
* Styling: Tailwind CSS (Customized with ADAPT Design System Tokens)
* Code Editor: Monaco Editor or CodeMirror (for YAML syntax highlighting and inline error marking)

### Backend
* Framework: Node.js with Express.js
* YAML Parsing: js-yaml
* Docker Integration: Docker Engine API via socket connection

## 2. System Architecture & Packaging

### Docker Compose Package
The distributable package will be a lightweight archive containing:
* `docker-compose.yml`: Defines the `helix-configurator` (Node/React app) and `otel-collector` containers.
* `.env`: Pre-populated from the SaaS UI (contains `HELIX_ENDPOINT`, `HELIX_API_KEY`, `X_SOURCE`).
* `otel-collector-config.yaml`: The baseline OpenTelemetry configuration.

### Volume Mounts
* The Configurator backend container must mount `/var/run/docker.sock:/var/run/docker.sock` to issue lifecycle commands to the collector.
* Both containers mount a shared volume containing `otel-collector-config.yaml` to allow the backend to read/write the configuration.

## 3. Frontend Implementation

### Theme Configuration
The UI will map the ADAPT Design Tokens directly into the CSS framework:
* Primary Colors: `#4040d9`, `#3006c2`
* Status Colors: Success (`#11845b`), Warning (`#ffd200`), Danger (`#b2001e`)
* Typography: Open Sans, base size 0.8125rem

### Key UI Components
1. Observability Pipeline Config (YAML Editor): Integrates syntax validation. If validation fails, the editor highlights the exact line with a red Danger indicator.
2. Troubleshooting & Diagnostics: Status cards that query the backend for validation results. Expands inline remediation steps upon failure.
3. Discovered Services Panel: A slide-out modal triggered from the shortcuts menu.

## 4. Backend Implementation & APIs

### API Routes
* `GET /api/config`: Reads the current `otel-collector-config.yaml`.
* `POST /api/config`: Saves updates to the YAML file and validates syntax using `js-yaml`.
* `POST /api/lifecycle/restart`: Uses the Docker socket to execute a restart command on the `otel-collector` container.
* `GET /api/diagnostics/network`: Pings the `HELIX_ENDPOINT` to verify reachability.
* `GET /api/diagnostics/telemetry`: Queries the local collector's Prometheus metric endpoint or logs to confirm HTTP 200/202 responses from the `otlphttp/bmchelix` exporter.

## 5. Discovered Services Logic
* Implementation: Parsing the Collector Config.
* The backend will parse `otel-collector-config.yaml` using `js-yaml`.
* It will scan the `receivers`, `processors`, and `pipelines` sections to identify active data sources, namespaces, and configured service boundaries.
* The parsed data is formatted into a list and sent to the frontend, which dynamically builds the "Discovered Services" slide-out modal with direct deep-links to the BMC Helix OTel Service Details dashboard.
