# Native Packaging — Remove the Docker Desktop Requirement

> **Spec** · Created 2026-06-05 · Status: **Draft**
> Build branch: `brainstorm/native-packaging` (worktree `.worktrees/brainstorm-native-packaging`)
> Source brief: packaging architecture brainstorm handoff (Docker → native binary)

The Helix Configurator is distributed today as a Docker Compose bundle: the install
zip ships the full app **source**, and `docker compose up --build` builds an image and
runs two containers (the configurator + a managed `helix-gateway` OTel collector) on
the user's machine. Docker Desktop is therefore a hard prerequisite — a commercial
license for larger orgs, frequently blocked on managed Windows workstations, and a
~500 MB download that alienates the NOC/ops persona.

This spec removes that requirement for the **primary** distribution path by shipping
the existing Node app as a **pre-built, self-contained native package** (the app plus a
bundled Node.js runtime), launched directly with no container runtime. The Docker
image stays available as a secondary path for users who prefer it.

This is a **packaging** change, not a rewrite. All backend/frontend application logic
is preserved unchanged. The one substantive code change is that the configurator must
now **create the gateway container itself** (a job Docker Compose does today), because
there is no longer a compose file in the native path.

---

## 1. What we're building

Three coordinated changes:

1. **Native package + launcher** — CI produces a per-platform zip containing a Node.js
   runtime, the backend, the built frontend, and launcher scripts. The user downloads,
   extracts, and double-clicks. No Docker required to *run the configurator*.

2. **Gateway creation in the configurator** — when the user selects the **Docker**
   onboarding target, the configurator creates and networks the `helix-gateway`
   collector container from scratch via dockerode (replacing Compose's role). When the
   user selects **Kubernetes**, no container runtime is touched at all (generate-only,
   as today).

3. **Separate mock AIOps project** — the throwaway, Cloudflare-tunneled demo page that
   lives inside the configurator today (`/api/_demo/aiops/*`, `AiopsPage.tsx`) moves out
   into its own small local project, `helix-aiops-mock`, that serves only a tiny install
   script. The configurator is cleaned of all demo/install/tunnel code.

### Distribution comparison

| Aspect | Today (Docker Compose) | Native (this spec) |
|---|---|---|
| Prereq to run configurator | Docker Desktop | None |
| Install payload | App **source** (~built locally) | Pre-built zip (~80 MB) |
| First-run cost | `docker compose up --build` (~500 MB images, minutes) | Extract + launch (seconds) |
| Configurator process | Container on `helix-bridge` | Host process on `localhost:8765` |
| Gateway collector | Compose-created container | **Configurator-created** container (Docker target) or Helm chart (K8s target) |
| Gateway → configurator fan-out | `http://helix-configurator:3001` | `http://host.docker.internal:8765` |

---

## 2. Goals / Non-goals

**Goals**
- Remove Docker Desktop as a prerequisite for running the configurator.
- Preserve **all** existing application logic — wrap, don't rewrite.
- Keep the onboarding wizard's Docker/Kubernetes target selector and Steps 1–5
  behaviorally unchanged from the user's point of view.
- Teach the configurator to create + network the gateway without Compose.
- Extract the demo AIOps page into a standalone local project; remove demo/tunnel code
  from the configurator.
- Keep the Docker image (GHCR) as a working secondary distribution path.

**Non-goals (deferred)**
- **Self-updating binary.** V1 updates are "re-run the install command"; a startup
  banner surfaces availability. No in-place binary replacement.
- **Go/Bun rewrite.** Considered and rejected (see §11). The native package runs real
  Node.js.
- **Bundling the OTel Collector binary.** The collector is deployed per the wizard
  target (Docker container or Helm chart), not shipped in the configurator zip.
- **Removing dockerode.** It stays; it is exercised only on the Docker target.
- **Live K8s cluster interaction.** Unchanged from today — K8s remains generate-only.
- **Cross-platform launcher polish** beyond start scripts (no installers/MSI/pkg, no
  code-signing) — seams noted, not built this round.

---

## 3. Decisions locked in brainstorming

1. **Wrap, not rewrite** (Approach A). Ship a platform-specific Node.js binary next to
   the unchanged app and its `node_modules` (with prebuilt native addons). Rejected SEA
   and Bun (§11).
2. **The Docker/K8s selector is about the customer's apps, not the configurator.** The
   configurator itself always runs natively now. "Docker" means *their apps run in
   Docker, so a Docker engine is present* — which is exactly what lets the configurator
   create the gateway there.
3. **The configurator owns gateway creation.** It already owns recreate/restart/stop/
   bridge; we add the missing **create** verb. Compose is no longer involved in the
   native path.
4. **`host.docker.internal` for host↔container networking.** Same mechanism the
   2026-06-05 K8s viewer redesign already relies on. The native Docker path and the
   K8s-local path are symmetric.
5. **Mock AIOps page becomes its own project.** No tunnel. It serves only a small
   install script that points at GitHub Releases.
6. **GitHub Releases `latest/download/` static URL.** The install script substitutes
   the platform string into a stable URL; no version lookup. CI must publish full
   releases (not prereleases) so `latest` resolves.
7. **Update = re-install + banner.** Drop the in-place `update.*` scripts entirely.

---

## 4. Architecture

### 4.1 Two projects

**Project A — `helix-configurator` (this repo).** The local sidecar tool, now running
natively. Responsibilities unchanged: onboarding wizard, gateway dashboard, View OTel
Data, Step Zero, Helix API integration. Ships as pre-built per-platform zips via GitHub
Releases. The Docker image remains published to GHCR for the secondary path.

**Project B — `helix-aiops-mock` (new repo/project).** Simulates the BMC Helix "Manage
OTel" page for demos. Runs locally on its own port (default `:9000`). Serves the mock
UI, mints a demo session (token + fake API key), and serves the templated install
script. Hosts **no** packages — the script downloads the binary zip from GitHub
Releases.

### 4.2 What moves OUT of the configurator

- `backend/routes/demo.js` — all `/api/_demo/aiops/*` routes, the zip builder, and all
  install/update script renderers.
- `frontend/src/components/AiopsPage.tsx` and the `/aiops` SPA route + its `main.tsx`
  switch.
- The `IS_DEMO_INSTALL` flag and its gating (and its mirror in `/api/health`).
- `computeInstallBaseUrl` (defined in `util.js`, called only by `demo.js`) and all
  tunnel/`X-Forwarded-*` awareness (`app.set('trust proxy', …)` in index.js). The only
  other mentions of `computeInstallBaseUrl` / `IS_DEMO_INSTALL` outside `demo.js` are
  **comments** (index.js:20, lifecycle.js:374) — clean them up with the code.
- The `marked` backend dependency (used only by `demo.js`).

> **Do NOT remove `archiver`.** It is also used by `backend/routes/k8s.js:118` to stream
> the generated Helm chart zip — that is a live product feature, not demo plumbing. Only
> `marked` is demo-exclusive.

### 4.3 What stays / changes IN the configurator

- Onboarding wizard (target selector + Steps 1–5) — behavior preserved.
- Gateway Dashboard, View OTel Data, Step Zero — unchanged.
- All backend routes **except** `demo.js`.
- **New:** `createGatewayFromScratch()` in the lifecycle layer (§5).
- **Changed:** port binding (§6.1), SQLite path resolution (§6.2), collector-yaml
  fan-out endpoint (§5.3).

### 4.4 Native package layout

```
helix-configurator/
├── node                          # platform Node.js 22 binary (node.exe on Windows)
├── backend/
│   ├── index.js, routes/, k8sChart/, otelStore.js, package.json
│   └── node_modules/             # production deps, prebuilt native addons (better-sqlite3)
├── frontend-dist/                # built Vite bundle
├── templates/                    # collector config templates
├── helix-otel/                   # Helm chart skeleton (K8s generate path)
├── helix-otel-collector.yaml     # placeholder; install script overwrites
├── .env                          # placeholder; install script overwrites
├── start.command                 # macOS: ./node backend/index.js
├── start.sh                      # Linux:  ./node backend/index.js
├── start.bat                     # Windows: node.exe backend\index.js
└── data/                         # SQLite store lives here
```

---

## 5. The gateway-creation gap (primary work item)

### 5.1 Problem

`recreateGateway()` (`backend/routes/lifecycle.js:149`) recreates the gateway by
**inspecting an existing container** — it copies the old container's `Image`, `Cmd`,
`HostConfig`, `ExposedPorts`, and network memberships, refreshing only `Env` from
`.env`. It assumes Docker Compose already created the gateway. In the native path there
is no Compose, so on first Docker-target save **no gateway container exists** and there
is nothing to inspect.

### 5.2 Solution — `createGatewayFromScratch()`

Add a create path in the lifecycle layer that builds the gateway container from a known
spec (the spec Compose encodes today in `docker-compose.yml`):

- **Image:** `otel/opentelemetry-collector-contrib:latest`. Pull if absent (dockerode
  `docker.pull`, awaited).
- **Network:** ensure `helix-bridge` exists (idempotent create; tolerate 409).
- **Container `helix-gateway`:**
  - Ports published to host: `4317:4317`, `4318:4318`, `8888:8888`.
  - Mount the templated `helix-otel-collector.yaml` to
    `/etc/otelcol-contrib/config.yaml`.
  - `Env` from `.env` (reuse `readEnvAsArray()` already in lifecycle.js).
  - Attach to `helix-bridge`.
- **Start**, attaching any extra networks **before** start (the same pre-start attach
  invariant `recreateGateway` documents, to keep the OTLP listener bound on all
  interfaces).

**Entry point:** Step 1's commit currently calls `/api/lifecycle/bridge` (which calls
`recreateGateway`). The handler becomes create-or-recreate: if the gateway container is
absent, call `createGatewayFromScratch()`; otherwise `recreateGateway()` as today. After
first creation, all existing lifecycle routes work unchanged because the container now
exists.

### 5.3 Networking flips to `host.docker.internal`

The configurator runs on the host, not in a container, so the gateway's local fan-out
target changes:

- **Gateway → configurator fan-out:** `http://helix-configurator:3001/api/otlp/*`
  becomes `http://host.docker.internal:8765/api/otlp/*`. This is a transform on the
  collector YAML, directly parallel to the K8s-local rewrite in
  `backend/k8sChart/transformCollectorConfig.js`. Factor the rewrite so both the native
  Docker path and the K8s-local path share one implementation.
- **Configurator → gateway (OTLP probes / diagnostics):** `localhost:4317` / `:4318`
  via the published ports (was the `helix-gateway` DNS name on `helix-bridge`).
- **Configurator → gateway (lifecycle):** the Docker socket via dockerode — unchanged.

### 5.4 Bridge / discovery implications

The Step 3 network-bridge flow still applies (attach `helix-gateway` to the customer's
app network so their apps can reach `helix-gateway:4318`). That code is unchanged — it
operates on the gateway container the configurator now owns. The `bridged-networks.json`
persistence path (lifecycle.js:27) keys off `/app` existence; update it to the
install-dir `data/` path (see §6.2) so it lands beside the SQLite store natively.

---

## 6. Runtime changes in the configurator

### 6.1 Port binding

Today the app hard-codes `port = 3001` and relies on Docker's `8765:3001` mapping.
Natively there is no mapping, so the server binds **`PORT` (default 8765)** directly.
On `EADDRINUSE`, **fail fast** with an actionable message — *"Port 8765 is in use. Set
PORT in .env to a free port and relaunch."* (Auto-increment deferred; predictable
failure is better for V1, and the launcher opens the browser to a known port.)

> Compatibility: the Docker image's `docker-compose` mapping expects container port
> 3001. To keep one code path, the container sets `PORT=3001` in its environment and the
> host mapping stays `8765:3001`. The default is 8765 for native; Docker overrides it.

### 6.2 SQLite + state paths

`OTEL_DB_PATH` resolution (index.js:78) keys off `/app` existence (the container
WORKDIR). Add an install-dir-relative resolution for native: `./data/otel-store.db`
relative to the package root. Same adjustment for `bridged-networks.json`
(lifecycle.js:27). `OTEL_DB_PATH` env override continues to win.

### 6.3 dockerode at startup

`new Docker()` (index.js:12) must not throw when `/var/run/docker.sock` is absent at
startup (the K8s-target user may have no Docker at all). dockerode's constructor is lazy
— **verified** during this brainstorm: `new Docker({ socketPath: '/nonexistent/docker.sock' })`
constructs without throwing (it connects per call, not at construction). The remaining
check during implementation is that no *module-load* path eagerly calls the socket
(e.g. lifecycle.js fires `reconcileBridgedNetworks(docker)` at register time — it already
catches and logs the gateway-not-inspectable case, so it degrades cleanly). Docker-
dependent routes already return errors gracefully when the daemon is unreachable; those
error bodies surface only on the Docker target where the daemon exists.

---

## 7. Build & release pipeline

A new GitHub Actions workflow (parallel to, not replacing, the GHCR `publish.yml`),
triggered on release tags (`v*`).

Per-platform job — **darwin-arm64, darwin-amd64, linux-amd64, windows-amd64** — on the
matching runner so native addons resolve natively:

1. Download the Node.js 22 binary for the target platform.
2. `cd frontend && npm ci && npm run build` → `frontend-dist/`.
3. `cd backend && npm ci --omit=dev` → production `node_modules` with the platform's
   prebuilt `better-sqlite3` addon (via `prebuild-install`).
4. Assemble the §4.4 layout; write platform launcher scripts.
5. Zip as `helix-configurator-<platform>.zip`.
6. Upload to the GitHub Release as a release asset (full release, **not** prerelease, so
   `latest/download/` resolves).

`better-sqlite3` is the only native addon and is the one real cross-platform risk; using
per-platform runners (not cross-download) keeps addon resolution honest.

The GHCR Docker workflow is untouched.

---

## 8. The mock AIOps project (`helix-aiops-mock`)

A small standalone Express app, port `:9000`. Reuses the session + render logic lifted
from today's `demo.js`.

**Routes**
- `GET /` — the mock "Manage OTel" form (enter service / X-Source name).
- `POST /configure` — mint a session `{ token, fakeApiKey, simulatedEndpoint, xSource }`,
  1 h TTL. Returns the install one-liners to display.
- `GET /install/:token.sh` — bash installer (below).
- `GET /install/:token.ps1` — PowerShell installer.

**Install script behavior**
1. Detect platform (`uname -s`/`uname -m`; `$env:PROCESSOR_ARCHITECTURE` on Windows) →
   one of the four platform strings.
2. Download `https://github.com/jammicha/HelixConfigurator/releases/latest/download/helix-configurator-<platform>.zip`
   (repo slug inferred from the GHCR image `ghcr.io/jammicha/helixconfigurator`; confirm
   at implementation).
3. Extract to a local install dir (run-from-cwd semantics like today's installer).
4. Write the templated `.env` (the session's fake API key, X-Source, simulated
   endpoint) and `helix-otel-collector.yaml` into the extracted dir — preserving any
   existing user `.env`/yaml/`data/` if present (first-install vs re-install check).
5. Run the platform launcher (`./node backend/index.js`).
6. Open the browser to `http://localhost:8765?view=onboarding`.

**Config:** the GitHub repo slug (hardcodeable for a demo). No version, no package
hosting, no tunnel.

In a real BMC integration, BMC's actual AIOps page performs the equivalent — serves a
templated install script pointing at wherever releases are published. The mock exists so
the full workflow can be demoed end-to-end locally.

---

## 9. Versioning & auto-update

- **Version source:** `backend/package.json` `version`, already surfaced via
  `/api/health`.
- **Update banner (V1):** on startup the configurator queries the GitHub Releases API
  (`/releases/latest`), compares the tag to its embedded version, and — if newer —
  renders a non-blocking "update available" banner with the one-line re-install command.
  ~20 lines; degrade silently if the API is unreachable/offline.
- **Update mechanism:** re-run the install command (download latest zip, relaunch).
  Installing into the same directory preserves `.env`, `helix-otel-collector.yaml`, and
  `data/` (the script does not overwrite existing user files).
- **Dropped:** the in-place `update.sh` / `update.command` / `update.bat` self-relocating
  scripts. The pre-built-zip model makes them unnecessary.

---

## 10. Testing strategy

Match repo convention: backend vitest units + frontend `tsc --noEmit`. No new e2e
harness.

**Unit tests (new logic)**
- `createGatewayFromScratch()` — assert the container-create spec (image, published
  ports, env array, network, yaml mount) given a `.env`, with dockerode mocked. Mirrors
  the `k8sChart` spec-builder tests.
- Collector-YAML fan-out rewrite to `host.docker.internal:8765` — parallel to the
  existing `transformCollectorConfig` tests; assert the shared rewrite covers both
  native-Docker and K8s-local.
- Port/`PORT` resolution incl. `EADDRINUSE` messaging.
- Native SQLite + `bridged-networks.json` path resolution.
- Mock project: install-script rendering — platform detection, correct
  `latest/download/` URL per platform, `.env` templating, re-install preservation.

**Manual validation checklist**
- Clean machine **without Docker Desktop**: download a platform zip, extract, launch →
  configurator up on `:8765`, onboarding renders.
- Native + Docker target: select Docker, save Step 1 → gateway created from scratch,
  pulled if absent, started; fan-out reaches the host configurator via
  `host.docker.internal`; traces appear in View OTel Data; Step 3 bridge to the app
  network works.
- Native + K8s target: select Kubernetes → chart generates → **no** Docker engine
  required.
- `better-sqlite3` prebuilt addon loads on each of the four targets (the one real
  cross-platform risk).

---

## 11. Alternatives considered

- **Approach B — Node SEA (single executable).** Can't embed native addons;
  `better-sqlite3`'s `.node` must ship alongside anyway, defeating the single-file
  benefit. Adds a bundler step and harder production debugging. Rejected.
- **Approach C — Bun `--compile`.** Single binary and built-in SQLite, but imperfect
  Node API compatibility (dockerode, Express 5) and a different SQLite API would force
  store changes — a runtime change layered on a distribution change. Two risks at once.
  Rejected.
- **Compose-for-gateway-only.** Keep the gateway in a Compose file and shell out to
  `docker compose up helix-gateway`. Reintroduces a Compose dependency (the audience may
  have the Docker engine but not the Compose plugin) and is messier than the configurator
  owning create via dockerode, which needs only the Docker socket. Rejected.

---

## 12. Sequencing notes for the implementation plan

The packaging mechanics and the gateway-creation work are largely independent:

1. **Packaging track** — CI per-platform build, launcher scripts, port binding, SQLite
   path resolution. Testable by downloading a zip and launching; no gateway needed.
2. **Gateway-creation track** (higher risk) — `createGatewayFromScratch()`, the
   create-or-recreate entry point, and the `host.docker.internal` fan-out rewrite.
3. **Cleanup track** — excise `demo.js`, `AiopsPage.tsx`, `IS_DEMO_INSTALL`, tunnel code,
   and the `marked` dependency (keep `archiver` — k8s.js needs it).
4. **Mock-project track** — stand up `helix-aiops-mock` reusing the lifted renderers.
5. **Update banner** — small, last.

Tracks 1, 3, 4 can proceed in parallel; track 2 is the critical path and deserves its
own focused plan section.
