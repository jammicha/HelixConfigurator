# Electron Desktop App — Wrap the Configurator as a Double-Clickable App

> **Spec** · Created 2026-09-04 · Status: **Draft**
> Supersedes the launcher portion of [native-packaging](2026-06-05-native-packaging-design.md).
> Approach: wrap the existing backend + frontend in Electron (Approach A). No rewrite.

## 0. Summary

The configurator ships today as a pre-built native zip (bundled Node runtime plus
`start.command`/`.sh`/`.bat`) that boots the Express backend and opens the user's
browser at `http://localhost:8765`, and also as a Docker Compose bundle. This spec adds
a **third, primary distribution**: a real Electron desktop app the user double-clicks,
with app icon, native menus, a tray, and auto-update.

Electron is **additive and non-destructive**. The Express backend and the React
frontend are preserved essentially unchanged. Electron's main process starts the
existing backend as a child process on a random loopback port and points a native
window at it. The Docker image and the existing native scripts keep working.

**Guiding principle for every decision in this spec: simplicity.** Where a choice
trades breadth for fewer moving parts, we take fewer moving parts.

## 1. Goals / Non-goals

**Goals**

- A double-clickable, installable app for **macOS and Windows** (real app in Dock /
  Start menu, no terminal, no stray browser tab).
- **Auto-update** wired in, functional once signing is enabled.
- **Native integration**: app menu, system tray, native save/open dialogs, single
  instance.
- **One-command dev workflow** that mirrors the production runtime model.
- **Password auth off by default** in desktop mode.
- Preserve the backend and frontend with the smallest possible change set.
- Keep the Docker image and native scripts working (shared backend version).

**Non-goals**

- Rewriting routes into IPC handlers (Approach C). Rejected: large effort, throws away
  a working HTTP surface.
- Bundling a container runtime to eliminate Docker Desktop. Rejected as out of scope
  and the opposite of simple (see §7).
- Linux packaging in this phase (add later; nothing here precludes it).
- Public app-store distribution.

## 2. Architecture and process model

Three participants at runtime:

1. **Electron main process.** Owns app lifecycle, the window, menu, tray, and
   auto-update. On launch it selects a free loopback port, starts the backend, polls
   `/api/health` until ready, then shows the window.
2. **Backend as a child process.** The existing `backend/index.js`, run unchanged via
   Electron `utilityProcess` on `127.0.0.1:<free-port>`. It is a real Node process, so
   `dockerode`, `better-sqlite3`, `archiver`, and all filesystem logic behave exactly
   as today.
3. **Renderer (`BrowserWindow`).** Loads `http://127.0.0.1:<port>`, which the backend
   already serves statically from `frontend-dist/`. The React app is unchanged; it
   fetches relative `/api/...` URLs, so the random port is transparent to it.

**Dev mirrors prod (simplicity: one runtime model).** In dev, main still supervises the
backend as a `utilityProcess`, and points the window at the Vite dev server on `:3000`
(which already proxies `/api` to the backend). Frontend HMR is preserved; there is no
second runtime shape to reason about.

**Supervision contract**

- Main picks the free port first (via `get-port`), so the backend's "port in use" exit
  path effectively never triggers.
- Main starts the backend, polls `GET /api/health` until `{ ok: true }` (with a timeout
  and a visible splash covering the gap), then shows the window.
- On quit, main sends `SIGTERM` and relies on the backend's existing graceful shutdown
  (it already handles `SIGTERM`/`SIGINT` and force-exits after 5s). Main enforces its
  own kill fallback.
- If the backend exits unexpectedly, main shows a recoverable dialog with a "Restart
  backend" action rather than a blank window.

## 3. Backend changes (minimal, additive, env-gated)

Approach A's value is not touching backend logic. The only changes are the ones
packaging forces, and all are additive env overrides that leave the Docker and native
paths behaving identically.

1. **Writable state must leave the install directory.** Packaged app resources are
   read-only. Today `statePaths.js` puts `data/` beside `backend/`, and `.env` and
   `helix-otel-collector.yaml` are resolved relative to the backend dir. Make these
   honor env overrides, and have Electron point them into `app.getPath('userData')`:
   - `HELIX_DATA_DIR` → SQLite store, `connections.json` (default unchanged when unset)
   - `HELIX_ENV_PATH` → the projected `.env`
   - `HELIX_CONFIG_PATH` → `helix-otel-collector.yaml`
   - `templates/` stays read-only in resources; no override needed.
2. **Loopback-only binding.** The backend binds `0.0.0.0` today. Add an optional `HOST`
   env (default preserves current behavior for Docker/scripts); Electron sets
   `HOST=127.0.0.1` so the desktop API is not exposed to the LAN.
3. **Injected port.** Already supported via `resolvePort(process.env)`; Electron passes
   `PORT=<free-port>`.

No change is needed for auth: `requireAuth` is already a passthrough unless
`UI_AUTH_PASSWORD` is set (see `backend/auth.js`). Desktop simply never sets it, so
password protection is **off by default** and still available to anyone who sets it.

## 4. Docker: prerequisite only for the Docker target, not the app

Correcting a common misread: the configurator process does **not** require Docker, and
neither does the **Kubernetes** onboarding target (it generates a Helm chart, touching
no runtime). Docker is required only for the **Docker onboarding target**, where the app
creates and runs the `helix-gateway` collector container via `dockerode`. That is the
one path that genuinely depends on the daemon; the code paths are in `lifecycle.js`,
`config.js` (restart to apply), `discovery.js`, `containers.js`, `diagnostics.js`.

Therefore Electron does **not** hard-gate the whole app on Docker. Design:

- The app launches and is fully usable (including the K8s / generate-only path) with no
  Docker present.
- Docker is detected **lazily**, when the user enters a Docker-target flow. If the
  daemon is absent, that flow shows a clear, contextual "Start Docker Desktop" message
  with a retry, instead of surfacing raw `dockerode` errors.
- We do not bundle a container runtime. Removing Docker from the Docker target is not
  possible without deleting that target; making the whole product Docker-optional beyond
  what already exists is a separate product initiative, not this packaging change.

## 5. Project structure

A third self-contained package beside `frontend/` and `backend/`:

```
desktop/
  package.json          # electron, electron-builder, electron-updater, get-port
  src/
    main.ts             # app lifecycle, window, supervises backend
    backend.ts          # free port, spawn utilityProcess, health poll, shutdown
    preload.ts          # contextBridge: minimal, safe native API surface
    menu.ts             # app menu
    tray.ts             # tray + backend status
    updater.ts          # electron-updater wiring (no-op in dev / unsigned)
  resources/            # app icons (icns / ico / png)
  electron-builder.yml
```

Root `package.json` gains fan-out scripts: `dev:desktop`, `build:desktop`, `dist`.

## 6. Packaging and native modules

- **Builder:** `electron-builder`.
- **Targets (simplicity):** macOS **universal** `dmg` + `zip` (single artifact, not
  split arm64/x64); Windows **one-click `nsis`** installer.
- **Native module rebuild:** `better-sqlite3` must match Electron's ABI. Use
  `@electron/rebuild` (or electron-builder's built-in rebuild) in the `dist` step. This
  is the one hard technical requirement and is well-trodden.
- **asar / native binaries:** the backend runs as a real Node file with a native
  `.node` dependency, so the backend tree (with `node_modules`) ships **unpacked**
  (`asarUnpack` or `extraResources`). `frontend-dist` ships unpacked alongside it so
  Express serves it from a real path.
- **Path wiring:** in packaged mode main computes `process.resourcesPath`-relative
  locations for the backend entry and `templates/`, and `userData`-relative locations
  for writable state (§3).

## 7. Auto-update

- **Mechanism:** `electron-updater`. Check on launch (after a short delay) and via a
  menu item. Quiet download, then "restart to apply" prompt.
- **Feed (simplicity):** **GitHub Releases** (the repo is public, so this works with no
  extra auth infrastructure), the lowest-infrastructure option. The feed URL lives in
  build config so it can be swapped without code change.
- **Signing coupling:** auto-update on macOS requires signed + notarized builds to
  actually install; Windows updates want a signing cert to avoid warnings. So the
  updater is **wired now** but only fully **functional** once signing is enabled (§9).
  In dev and unsigned builds it is a no-op that logs.

## 8. Native integration (scoped; YAGNI on the rest)

- **App menu:** standard roles plus "Check for Updates", "Open Data Folder", "View
  Logs", "Restart Backend".
- **System tray:** show/hide window, backend status indicator, quit. Justified because
  the app is a long-running local controller.
- **Native dialogs:** real save dialog for config/chart export and open dialog for
  imports, exposed through the preload bridge. The existing web download path remains as
  a fallback.
- **Single-instance lock:** a second launch focuses the existing window instead of
  contending for the port and Docker state.
- **Native notifications:** backend-down and update-ready.
- **Deferred:** deep links / custom protocol until a concrete need appears.

## 9. Signing and notarization (off by default, added later)

Designed so nothing blocks dev today and enabling signing is a config/secrets change,
not code:

- **macOS:** electron-builder reads identity and notarization creds from env
  (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`). Absent, it produces an unsigned build the user right-click-opens.
- **Windows:** cert via `CSC_LINK` / `CSC_KEY_PASSWORD`. Absent, unsigned `nsis`.
- CI hook points exist from the start. Auto-update becomes fully functional at this
  point.

## 10. Dev workflow (one command)

- `npm run dev` (in `desktop/`, or `npm run dev:desktop` at root): uses `concurrently`
  to start the Vite dev server and launch Electron; Electron supervises the backend
  itself. One command, HMR intact, same runtime shape as prod.
- **Literal double-click dev launchers (both OSes):** ship two tiny wrappers that each
  run the one dev command. No single file double-clicks on both platforms (a `.bat`
  runs only on Windows, macOS needs a `.command`), so we provide both:
  - `dev.command` (macOS): `cd` to repo root and run `npm run dev:desktop`.
  - `dev.bat` (Windows): same, for `cmd`.
  Both are thin and delegate to the npm script, so there is one real launch path.
- `npm run dist`: builds `frontend-dist`, rebuilds native modules, runs electron-builder
  for the host OS.

## 11. Testing

- Keep all existing frontend and backend unit tests unchanged.
- Add a **supervisor test** for `backend.ts`: free-port selection, health-poll
  success and timeout, clean `SIGTERM` shutdown.
- Add one **packaged smoke test** in CI: launch the built app, assert `/api/health`
  responds and the window loads, before publishing a release.

## 12. Back-compat and distribution lifecycle

Electron is additive. The Docker image, `docker-compose`, and `start.command/.sh/.bat`
all keep working because every backend change is an env-gated default. Desktop,
container, and script distributions share one backend version number.

**Decision:** keep both the native zip scripts and the Electron app for now. Once the
Electron distribution is proven stable in real use, retire the native zip scripts to
shrink the distribution surface. The Docker/compose path is unaffected by that retirement.

## 13. Phasing

1. **MVP wrap:** `desktop/` package, supervisor, backend path/host env overrides,
   window loads localhost, graceful quit. Runnable unpacked app.
2. **Packaging:** electron-builder + native rebuild; macOS universal + Windows `nsis`
   (unsigned); icons.
3. **Auto-update:** electron-updater against GitHub Releases (no-op until signed).
4. **Native polish:** menu, tray, native dialogs, single-instance, lazy Docker gate.
5. **Signing/notarization:** enable via secrets; auto-update goes live.

## 14. Open questions

- None blocking. Release artifacts and the update feed live on the public GitHub repo
  (§7); the native zip scripts stay until Electron is stable, then retire (§12).
