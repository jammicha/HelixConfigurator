# Electron Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Helix OTel Configurator as a double-clickable, auto-updating desktop app for macOS and Windows by wrapping the existing Express backend and React frontend in Electron, without rewriting either.

**Architecture:** Electron's main process picks a free loopback port, starts the existing `backend/index.js` as a `utilityProcess`, polls `/api/health`, then loads a `BrowserWindow` at `http://127.0.0.1:<port>` (the backend already serves `frontend-dist/`). Backend changes are limited to additive, env-gated path and host overrides. The Docker image and native scripts keep working.

**Tech Stack:** Electron, electron-builder, electron-updater, get-port; existing Express 5 / better-sqlite3 / dockerode backend; React 18 / Vite frontend.

**Spec:** `docs/superpowers/specs/2026-09-04-electron-app-design.md`

## Global Constraints

- Platforms: macOS (universal binary) and Windows (`nsis` one-click). Linux is out of scope this phase.
- Simplicity is the primary driver. The desktop layer is written in **plain CommonJS JavaScript with no TypeScript build step** (a deliberate simplification of the spec's illustrative `.ts` filenames), so the Electron package has no compile step of its own.
- Backend changes must be **additive and env-gated**: with the new env vars unset, the Docker image and `start.command/.sh/.bat` behave exactly as before.
- Desktop mode binds the backend to `127.0.0.1` only and never sets `UI_AUTH_PASSWORD` (auth off by default).
- No hard Docker gate at launch. The app runs without Docker; only the Docker onboarding target requires the daemon.
- `better-sqlite3` is a native module and MUST be rebuilt against Electron's ABI before packaging.
- No em dashes in code comments or docs added by this plan.
- Prettier + ESLint configs already exist in `backend/`; match them. New `desktop/` package gets its own minimal ESLint config mirroring backend style.

---

## File Structure

**Backend (modify, additive only):**
- `backend/statePaths.js` — add `HELIX_DATA_DIR` override and new `resolveEnvPath` / `resolveConfigPath` resolvers.
- `backend/portConfig.js` — add `resolveHost(env)`.
- `backend/index.js` — consume the new resolvers for the dotenv load, `DATA_DIR`, `CONFIG_PATH`, `ENV_PATH`, and bind host via `resolveHost`.
- `backend/auth.js` — resolve its `ENV_PATH` via `resolveEnvPath` so a relocated `.env` is honored.

**Desktop (new package):**
- `desktop/package.json` — deps and scripts.
- `desktop/main.js` — app lifecycle, window, single-instance, supervises backend.
- `desktop/backend.js` — free port, spawn utilityProcess, health poll, shutdown.
- `desktop/preload.js` — contextBridge native API surface.
- `desktop/menu.js` — application menu.
- `desktop/tray.js` — system tray + backend status.
- `desktop/updater.js` — electron-updater wiring (no-op in dev / unsigned).
- `desktop/paths.js` — resolves backend entry, templates, and userData state paths for dev vs packaged.
- `desktop/electron-builder.yml` — build config.
- `desktop/resources/` — icons (`icon.icns`, `icon.ico`, `icon.png`).
- `desktop/dev.command`, `desktop/dev.bat` — double-click dev launchers.
- `desktop/__tests__/backend.test.js` — supervisor unit tests.

**Root:**
- `package.json` — add `dev:desktop`, `build:desktop`, `dist` fan-out scripts.

---

## Task 1: Backend state-path env overrides

**Files:**
- Modify: `backend/statePaths.js`
- Test: `backend/statePaths.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveDataDir({ appDirExists, backendDir })` → string (now honors `HELIX_DATA_DIR` first)
  - `resolveEnvPath({ backendDir })` → string (honors `HELIX_ENV_PATH`, else `<root>/.env`)
  - `resolveConfigPath({ backendDir })` → string (honors `HELIX_CONFIG_PATH`, else `<root>/helix-otel-collector.yaml`)

- [ ] **Step 1: Write the failing test**

```js
// backend/statePaths.test.js
const { describe, it, expect, afterEach } = require('vitest');
const path = require('path');
const { resolveDataDir, resolveEnvPath, resolveConfigPath } = require('./statePaths');

const BACKEND_DIR = '/opt/app/backend';

afterEach(() => {
  delete process.env.HELIX_DATA_DIR;
  delete process.env.HELIX_ENV_PATH;
  delete process.env.HELIX_CONFIG_PATH;
});

describe('statePaths', () => {
  it('prefers HELIX_DATA_DIR when set', () => {
    process.env.HELIX_DATA_DIR = '/user/data';
    expect(resolveDataDir({ appDirExists: false, backendDir: BACKEND_DIR })).toBe('/user/data');
  });

  it('falls back to container path, then sibling data dir', () => {
    expect(resolveDataDir({ appDirExists: true, backendDir: BACKEND_DIR })).toBe('/app/data');
    expect(resolveDataDir({ appDirExists: false, backendDir: BACKEND_DIR }))
      .toBe(path.join('/opt/app', 'data'));
  });

  it('resolves env path with and without override', () => {
    expect(resolveEnvPath({ backendDir: BACKEND_DIR })).toBe(path.join('/opt/app', '.env'));
    process.env.HELIX_ENV_PATH = '/user/.env';
    expect(resolveEnvPath({ backendDir: BACKEND_DIR })).toBe('/user/.env');
  });

  it('resolves config path with and without override', () => {
    expect(resolveConfigPath({ backendDir: BACKEND_DIR }))
      .toBe(path.join('/opt/app', 'helix-otel-collector.yaml'));
    process.env.HELIX_CONFIG_PATH = '/user/collector.yaml';
    expect(resolveConfigPath({ backendDir: BACKEND_DIR })).toBe('/user/collector.yaml');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run statePaths.test.js`
Expected: FAIL (`resolveEnvPath is not a function`, and the `HELIX_DATA_DIR` case returns the sibling dir).

- [ ] **Step 3: Write minimal implementation**

Replace the body of `backend/statePaths.js` with:

```js
// backend/statePaths.js
// Single source of truth for where mutable state lives. In the container the
// data/ volume is mounted at /app/data. Natively the package root is the
// parent of backend/, so state lands in <installRoot>/data alongside the binary.
// Electron sets the HELIX_* overrides so state lives in the OS userData dir,
// which is writable even when the app bundle is read-only.
const path = require('path');

function rootFrom(backendDir) {
  return path.resolve(backendDir, '..');
}

function resolveDataDir({ appDirExists, backendDir }) {
  if (process.env.HELIX_DATA_DIR) return process.env.HELIX_DATA_DIR;
  if (appDirExists) return '/app/data';
  return path.join(rootFrom(backendDir), 'data');
}

function resolveEnvPath({ backendDir }) {
  return process.env.HELIX_ENV_PATH || path.join(rootFrom(backendDir), '.env');
}

function resolveConfigPath({ backendDir }) {
  return process.env.HELIX_CONFIG_PATH || path.join(rootFrom(backendDir), 'helix-otel-collector.yaml');
}

module.exports = { resolveDataDir, resolveEnvPath, resolveConfigPath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run statePaths.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/statePaths.js backend/statePaths.test.js
git commit -m "feat(backend): env overrides for data/env/config paths"
```

---

## Task 2: Backend loopback host binding

**Files:**
- Modify: `backend/portConfig.js`
- Modify: `backend/index.js` (the `start()` bind sequence around lines 167-190)
- Test: `backend/portConfig.test.js` (create or extend if present)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveHost(env)` → string | null. Returns `env.HOST` when non-empty, else `null` (meaning "use the existing dual-stack bind").

- [ ] **Step 1: Write the failing test**

```js
// backend/portConfig.test.js
const { describe, it, expect } = require('vitest');
const { resolveHost } = require('./portConfig');

describe('resolveHost', () => {
  it('returns null when HOST is unset (dual-stack default)', () => {
    expect(resolveHost({})).toBe(null);
  });
  it('returns the HOST value when set', () => {
    expect(resolveHost({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
  it('treats empty string as unset', () => {
    expect(resolveHost({ HOST: '' })).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run portConfig.test.js`
Expected: FAIL (`resolveHost is not a function`).

- [ ] **Step 3: Add `resolveHost` to `backend/portConfig.js`**

Append before `module.exports` and add it to the export object:

```js
// A desktop (Electron) install pins HOST=127.0.0.1 so the API is never exposed
// to the LAN. Docker and native-script installs leave HOST unset and keep the
// existing dual-stack bind.
function resolveHost(env) {
  const h = typeof env.HOST === 'string' ? env.HOST.trim() : '';
  return h.length > 0 ? h : null;
}
```

```js
module.exports = { resolvePort, resolvePublishedPort, resolveHost, DEFAULT_PORT };
```

- [ ] **Step 4: Wire `start()` in `backend/index.js` to honor a single explicit host**

At the top of `backend/index.js`, add `resolveHost` to the existing require:

```js
const { resolvePort, resolveHost } = require('./portConfig');
const port = resolvePort(process.env);
const explicitHost = resolveHost(process.env);
```

Replace the two-bind sequence in `start()` (the IPv6 `'::'` try/catch and the `'0.0.0.0'` try/catch, around lines 168-190) with:

```js
  if (explicitHost) {
    // Desktop mode: bind exactly one host (loopback) and skip the dual-stack dance.
    servers.push(await listenOn({ port, host: explicitHost }));
    ipv4Bound = true;
  } else {
    // IPv6 first, and ipv6Only so it cannot claim the v4 wildcard implicitly.
    try {
      servers.push(await listenOn({ port, host: '::', ipv6Only: true }));
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EAFNOSUPPORT' && e.code !== 'EADDRNOTAVAIL') throw e;
    }
    try {
      servers.push(await listenOn({ port, host: '0.0.0.0' }));
      ipv4Bound = true;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') {
        if (servers.length === 0) throw e;
        console.error(`IPv4 bind on port ${port} failed:`, e);
      }
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run portConfig.test.js`
Expected: PASS (3 tests).
Run: `cd backend && npm test`
Expected: existing suite still PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/portConfig.js backend/portConfig.test.js backend/index.js
git commit -m "feat(backend): optional single-host bind via HOST env"
```

---

## Task 3: Wire index.js and auth.js to the new path resolvers

**Files:**
- Modify: `backend/index.js` (dotenv load line ~8; `CONFIG_PATH` line ~28; `DATA_DIR` line ~81; `ENV_PATH` line ~92)
- Modify: `backend/auth.js` (`ENV_PATH` const, line ~11)

**Interfaces:**
- Consumes: `resolveDataDir`, `resolveEnvPath`, `resolveConfigPath` from Task 1.
- Produces: no new exports; behavior unchanged when the `HELIX_*` env vars are unset.

- [ ] **Step 1: Update the dotenv load and path consts in `backend/index.js`**

Add near the top requires:

```js
const { resolveDataDir, resolveEnvPath, resolveConfigPath } = require('./statePaths');
```

Change the dotenv load (line ~8) to:

```js
require('dotenv').config({ path: resolveEnvPath({ backendDir: __dirname }), quiet: true });
```

Change `CONFIG_PATH` (line ~28) to:

```js
const CONFIG_PATH = resolveConfigPath({ backendDir: __dirname });
```

Change the `DATA_DIR` line (~81) to drop the now-duplicate require and use the top-level import:

```js
const DATA_DIR = resolveDataDir({ appDirExists: IS_CONTAINERIZED, backendDir: __dirname });
```

Change `ENV_PATH` (line ~92) to:

```js
const ENV_PATH = resolveEnvPath({ backendDir: __dirname });
```

(Delete the inner `const { resolveDataDir } = require('./statePaths');` line that previously sat above `DATA_DIR`, since it is now imported at the top.)

- [ ] **Step 2: Update `backend/auth.js` ENV_PATH**

Change the `ENV_PATH` const (line ~11) from the hardcoded join to:

```js
const { resolveEnvPath } = require('./statePaths');
const ENV_PATH = resolveEnvPath({ backendDir: __dirname });
```

- [ ] **Step 3: Verify no regression with default (unset) env**

Run: `cd backend && npm test`
Expected: PASS. With `HELIX_*` unset, all paths resolve to the same locations as before.

- [ ] **Step 4: Manual smoke of overrides**

Run:

```bash
cd backend && HELIX_DATA_DIR=/tmp/helix-desktop HELIX_ENV_PATH=/tmp/helix-desktop/.env HOST=127.0.0.1 PORT=8799 node index.js
```

Expected: log `Backend listening at http://localhost:8799`; `curl -fsS http://127.0.0.1:8799/api/health` returns `{ ok: true, ... }`; `/tmp/helix-desktop` gets an `otel-store.db`. Stop with Ctrl-C and confirm graceful shutdown log.

- [ ] **Step 5: Commit**

```bash
git add backend/index.js backend/auth.js
git commit -m "feat(backend): consume env-gated path resolvers"
```

---

## Task 4: Scaffold the desktop package

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/main.js` (minimal window first)
- Create: `desktop/.gitignore`

**Interfaces:**
- Produces: an Electron app that opens a window (loads a placeholder for now).

- [ ] **Step 1: Create `desktop/package.json`**

```json
{
  "name": "helix-configurator-desktop",
  "version": "1.6.1",
  "private": true,
  "description": "Electron desktop wrapper for the Helix OTel Configurator",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dev": "HELIX_DESKTOP_DEV=1 electron .",
    "test": "vitest run",
    "dist": "electron-builder",
    "postinstall": "electron-builder install-app-deps"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.1.8",
    "vitest": "^4.1.8"
  },
  "dependencies": {
    "electron-updater": "^6.3.9",
    "get-port": "^5.1.1"
  }
}
```

Note: `get-port@5` is the last CommonJS release; v6+ is ESM-only, which would force an async import in CJS. Pinning v5 keeps `require()` working.

- [ ] **Step 2: Create a minimal `desktop/main.js`**

```js
// desktop/main.js
const { app, BrowserWindow } = require('electron');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadURL('data:text/html,<h1>Helix Configurator desktop shell</h1>');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 3: Create `desktop/.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 4: Install and run**

Run:

```bash
cd desktop && npm install && npm run dev
```

Expected: an Electron window opens showing "Helix Configurator desktop shell".

- [ ] **Step 5: Commit**

```bash
git add desktop/package.json desktop/main.js desktop/.gitignore
git commit -m "feat(desktop): scaffold electron package with minimal window"
```

---

## Task 5: Backend supervisor module

**Files:**
- Create: `desktop/backend.js`
- Create: `desktop/paths.js`
- Test: `desktop/__tests__/backend.test.js`

**Interfaces:**
- Consumes: `desktop/paths.js` (`backendEntry()`, `stateDir()`).
- Produces:
  - `waitForHealth(baseUrl, { timeoutMs, intervalMs, fetchImpl }) ` → Promise<void> (resolves when `/api/health` returns `{ ok: true }`, rejects on timeout)
  - `startBackend({ freePort })` → Promise<{ port, baseUrl, child, stop() }>
  - `pickPort()` → Promise<number>

- [ ] **Step 1: Create `desktop/paths.js`**

```js
// desktop/paths.js
// Resolves on-disk locations for dev vs packaged. In dev the repo layout is
// used directly. When packaged, the backend and templates ship unpacked under
// resources/, and writable state lives in the OS userData dir.
const path = require('path');
const { app } = require('electron');

const isDev = () => !app.isPackaged;

function repoRoot() {
  // desktop/ is a sibling of backend/ and frontend-dist/ in the repo.
  return path.resolve(__dirname, '..');
}

function backendEntry() {
  if (isDev()) return path.join(repoRoot(), 'backend', 'index.js');
  return path.join(process.resourcesPath, 'app', 'backend', 'index.js');
}

function templatesDir() {
  if (isDev()) return path.join(repoRoot(), 'templates');
  return path.join(process.resourcesPath, 'app', 'templates');
}

function stateDir() {
  // Writable state. In dev keep it out of the repo to avoid polluting it.
  const base = app.getPath('userData');
  return path.join(base, 'state');
}

module.exports = { isDev, repoRoot, backendEntry, templatesDir, stateDir };
```

- [ ] **Step 2: Write the failing supervisor test**

```js
// desktop/__tests__/backend.test.js
const { describe, it, expect, vi } = require('vitest');
const { waitForHealth } = require('../backend');

function fakeFetch(sequence) {
  let i = 0;
  return async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if (step === 'throw') throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ ok: step === 'ok' }) };
  };
}

describe('waitForHealth', () => {
  it('resolves once health returns ok', async () => {
    const fetchImpl = fakeFetch(['throw', 'notok', 'ok']);
    await expect(
      waitForHealth('http://127.0.0.1:1', { timeoutMs: 1000, intervalMs: 5, fetchImpl })
    ).resolves.toBeUndefined();
  });

  it('rejects on timeout when health never becomes ok', async () => {
    const fetchImpl = fakeFetch(['throw']);
    await expect(
      waitForHealth('http://127.0.0.1:1', { timeoutMs: 30, intervalMs: 5, fetchImpl })
    ).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd desktop && npx vitest run`
Expected: FAIL (`waitForHealth is not a function`).

- [ ] **Step 4: Implement `desktop/backend.js`**

```js
// desktop/backend.js
const { utilityProcess } = require('electron');
const getPort = require('get-port');
const { backendEntry, templatesDir, stateDir } = require('./paths');

async function pickPort() {
  return getPort();
}

async function waitForHealth(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const intervalMs = opts.intervalMs ?? 300;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetchImpl(`${baseUrl}/api/health`);
      const body = await res.json();
      if (body && body.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) throw new Error(`Backend health check timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function startBackend({ freePort } = {}) {
  const port = freePort ?? (await pickPort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const path = require('path');
  const state = stateDir();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    HELIX_DATA_DIR: state,
    HELIX_ENV_PATH: path.join(state, '.env'),
    HELIX_CONFIG_PATH: path.join(state, 'helix-otel-collector.yaml'),
    HELIX_TEMPLATES_DIR: templatesDir(),
  };
  const child = utilityProcess.fork(backendEntry(), [], { env, stdio: 'pipe' });
  child.stdout?.on('data', (d) => console.log(`[backend] ${d}`.trimEnd()));
  child.stderr?.on('data', (d) => console.error(`[backend] ${d}`.trimEnd()));

  await waitForHealth(baseUrl);

  const stop = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      try { child.kill(); } catch { finish(); }
      setTimeout(finish, 6000);
    });

  return { port, baseUrl, child, stop };
}

module.exports = { pickPort, waitForHealth, startBackend };
```

Note: `utilityProcess.fork` sends SIGTERM on `child.kill()`, which the backend's existing signal handler drains gracefully. `stateDir()` must exist before the backend writes to it (main creates it in Task 6). `HELIX_TEMPLATES_DIR` is passed for future use; the backend reads templates from its own dir today and is unaffected if it ignores the var.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd desktop && npx vitest run`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add desktop/backend.js desktop/paths.js desktop/__tests__/backend.test.js
git commit -m "feat(desktop): backend supervisor with health poll and paths"
```

---

## Task 6: Integrate supervisor into main (full app in dev)

**Files:**
- Modify: `desktop/main.js`

**Interfaces:**
- Consumes: `startBackend` from Task 5.
- Produces: a running desktop app that serves the real UI in dev.

- [ ] **Step 1: Replace `desktop/main.js` with the integrated version**

```js
// desktop/main.js
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const { startBackend } = require('./backend');
const { stateDir } = require('./paths');

let mainWindow = null;
let backend = null;
let quitting = false;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(main);
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);
}

async function main() {
  fs.mkdirSync(stateDir(), { recursive: true });
  try {
    backend = await startBackend();
  } catch (err) {
    dialog.showErrorBox('Helix Configurator', `The backend did not start:\n\n${err.message}`);
    app.quit();
    return;
  }

  // In dev, load the Vite dev server (HMR); in prod, load the backend-served UI.
  const devUrl = process.env.HELIX_DESKTOP_DEV ? 'http://127.0.0.1:3000' : backend.baseUrl;
  createWindow(devUrl);

  backend.child.on('exit', (code) => {
    if (quitting) return;
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      buttons: ['Restart backend', 'Quit'],
      defaultId: 0,
      message: 'The Helix Configurator backend stopped unexpectedly.',
      detail: `Exit code: ${code}`,
    });
    if (choice === 0) app.relaunch();
    app.quit();
  });
}

app.on('before-quit', async (e) => {
  if (quitting || !backend) return;
  e.preventDefault();
  quitting = true;
  await backend.stop();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 2: Add root fan-out scripts to `package.json`**

In the root `package.json` scripts block add:

```json
    "dev:desktop": "concurrently -k \"npm --prefix frontend run dev\" \"npm --prefix desktop run dev\"",
    "build:desktop": "npm run build && npm --prefix desktop run dist",
    "dist": "npm run build:desktop"
```

Then install `concurrently` at the root:

```bash
npm install -D concurrently
```

- [ ] **Step 3: Run the full dev app**

Run:

```bash
npm run dev:desktop
```

Expected: Vite starts on `:3000`, Electron starts the backend on a random loopback port, the window shows the real configurator UI, and `/api/*` calls succeed (proxied by Vite to the backend). Quit the window and confirm the backend process exits (no orphaned node process).

- [ ] **Step 4: Commit**

```bash
git add desktop/main.js package.json package-lock.json
git commit -m "feat(desktop): supervise backend from main, single-instance, dev HMR"
```

---

## Task 7: Preload bridge and secure window defaults

**Files:**
- Create: `desktop/preload.js`
- Modify: `desktop/main.js` (attach preload; harden navigation)

**Interfaces:**
- Produces: `window.helix` in the renderer with `{ getVersions(), openDataFolder(), saveFile({ suggestedName, data }) }`.

- [ ] **Step 1: Create `desktop/preload.js`**

```js
// desktop/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helix', {
  getVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),
  openDataFolder: () => ipcRenderer.invoke('helix:open-data-folder'),
  saveFile: (payload) => ipcRenderer.invoke('helix:save-file', payload),
});
```

- [ ] **Step 2: Wire preload + IPC handlers in `desktop/main.js`**

Add near the top:

```js
const { ipcMain, shell } = require('electron');
const path = require('path');
```

In `createWindow`, set the preload path in `webPreferences`:

```js
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
```

After `app.whenReady().then(main)` wiring, register handlers inside `main()` (before creating the window):

```js
  ipcMain.handle('helix:open-data-folder', () => shell.openPath(stateDir()));
  ipcMain.handle('helix:save-file', async (_evt, { suggestedName, data }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedName,
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, data);
    return { saved: true, filePath };
  });
```

Harden navigation (prevent the renderer from being steered off-origin):

```js
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev:desktop`. In the window devtools console, run `window.helix.getVersions()` and confirm it returns version strings. Run `window.helix.openDataFolder()` and confirm the state folder opens.

- [ ] **Step 4: Commit**

```bash
git add desktop/preload.js desktop/main.js
git commit -m "feat(desktop): preload bridge, save dialog, hardened navigation"
```

---

## Task 8: electron-builder packaging (macOS universal)

**Files:**
- Create: `desktop/electron-builder.yml`
- Create: `desktop/resources/icon.icns`, `desktop/resources/icon.png` (placeholder acceptable initially)
- Modify: `desktop/paths.js` (already handles packaged paths; verify)

**Interfaces:**
- Produces: `desktop/dist/*.dmg` and `*.zip` (universal) for macOS.

- [ ] **Step 1: Create `desktop/electron-builder.yml`**

```yaml
appId: com.bmc.helix.otel-configurator
productName: Helix OTel Configurator
directories:
  output: dist
  buildResources: resources
# The whole repo root is the build context; only what we list is included.
files:
  - main.js
  - backend.js
  - paths.js
  - preload.js
  - menu.js
  - tray.js
  - updater.js
  - package.json
  - node_modules/**/*
extraResources:
  # Ship the backend and built frontend unpacked under Resources/app so the
  # utilityProcess runs a real file and better-sqlite3's .node loads normally.
  - from: ../backend
    to: app/backend
    filter:
      - "**/*"
      - "!__tests__/**"
      - "!**/*.test.js"
  - from: ../frontend-dist
    to: app/frontend-dist
  - from: ../templates
    to: app/templates
asar: true
mac:
  target:
    - target: dmg
      arch: universal
    - target: zip
      arch: universal
  category: public.app-category.developer-tools
  icon: resources/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
win:
  target:
    - target: nsis
      arch: x64
  icon: resources/icon.ico
nsis:
  oneClick: true
  perMachine: false
```

Note: the backend serves `frontend-dist` from `../frontend-dist` relative to `backend/`. Under `extraResources` the layout `app/backend` + `app/frontend-dist` preserves that sibling relationship, so `path.join(__dirname, '../frontend-dist')` in `index.js` still resolves. Verify this holds during Step 4; if the backend resolves `frontend-dist` differently when packaged, add `HELIX_FRONTEND_DIR` support in a follow-up.

- [ ] **Step 2: Ensure native module rebuild for Electron ABI**

The `postinstall` script (`electron-builder install-app-deps`) rebuilds native deps of the desktop package. Because `better-sqlite3` lives in `backend/node_modules`, rebuild it explicitly for Electron before packaging:

```bash
cd desktop && npx electron-builder install-app-deps --projectDir ../backend
```

Add this as a `prebuild` note in the plan; if it proves flaky, switch to `@electron/rebuild -m ../backend -f`.

- [ ] **Step 3: Build the frontend and package**

Run:

```bash
npm run build            # produces frontend-dist/
cd desktop && npm run dist
```

Expected: `desktop/dist/` contains a universal `.dmg` and `.zip`.

- [ ] **Step 4: Install and smoke-test the packaged app**

Open the `.dmg`, drag to Applications, launch. Because it is unsigned, right-click and choose Open the first time. Expected: the app launches, the backend starts (check Console logs or the app's View Logs later), the UI loads, `/api/health` is green, and writable state appears under `~/Library/Application Support/Helix OTel Configurator/state`.

- [ ] **Step 5: Commit**

```bash
git add desktop/electron-builder.yml desktop/resources
git commit -m "feat(desktop): electron-builder config, macOS universal build"
```

---

## Task 9: Windows nsis target and icons

**Files:**
- Modify: `desktop/electron-builder.yml` (already has a `win` block; confirm)
- Create: `desktop/resources/icon.ico`

**Interfaces:**
- Produces: `desktop/dist/*.exe` (nsis one-click) on Windows.

- [ ] **Step 1: Provide a real `icon.ico`**

Generate a 256x256 `.ico` from the Helix logo and place it at `desktop/resources/icon.ico`. Use the existing brand asset (for example `assets/` or `ADAPT Design System/`); confirm dimensions include 256, 128, 64, 48, 32, 16.

- [ ] **Step 2: Build on Windows**

On a Windows machine (or CI Windows runner):

```bash
npm run build
cd desktop && npm run dist
```

Expected: `desktop/dist/Helix OTel Configurator Setup <version>.exe`.

- [ ] **Step 3: Install and smoke-test**

Run the installer (unsigned SmartScreen warning is expected until signing is enabled; choose "More info" then "Run anyway"). Launch from Start menu. Expected: backend starts, UI loads, state lands under `%APPDATA%\Helix OTel Configurator\state`.

- [ ] **Step 4: Commit**

```bash
git add desktop/resources/icon.ico desktop/electron-builder.yml
git commit -m "feat(desktop): windows nsis installer and icon"
```

---

## Task 10: Auto-update via GitHub Releases

**Files:**
- Create: `desktop/updater.js`
- Modify: `desktop/main.js` (invoke updater after window shows)
- Modify: `desktop/electron-builder.yml` (publish config)

**Interfaces:**
- Consumes: nothing.
- Produces: `initUpdater({ onStatus })` → void. No-op in dev / when unsigned or update disabled.

- [ ] **Step 1: Add publish config to `desktop/electron-builder.yml`**

```yaml
publish:
  provider: github
  owner: <github-org-or-user>
  repo: <repo-name>
```

Fill `owner`/`repo` with the public repo that hosts releases (confirmed public per spec section 7).

- [ ] **Step 2: Create `desktop/updater.js`**

```js
// desktop/updater.js
// Auto-update against GitHub Releases. Disabled in dev and whenever the app is
// not packaged, because unsigned builds cannot install an update on macOS.
const { app } = require('electron');

function initUpdater({ onStatus } = {}) {
  if (!app.isPackaged || process.env.HELIX_DESKTOP_DEV) {
    onStatus?.('disabled (dev)');
    return { checkNow: () => onStatus?.('disabled (dev)') };
  }
  // Lazy require so dev/test never loads the native updater.
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => onStatus?.('checking'));
  autoUpdater.on('update-available', () => onStatus?.('downloading'));
  autoUpdater.on('update-not-available', () => onStatus?.('up to date'));
  autoUpdater.on('error', (e) => onStatus?.(`error: ${e.message}`));
  autoUpdater.on('update-downloaded', () => onStatus?.('ready to install'));

  const checkNow = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setTimeout(checkNow, 8000);
  return { checkNow };
}

module.exports = { initUpdater };
```

- [ ] **Step 3: Invoke from `main.js`**

After the window is created in `main()`:

```js
const { initUpdater } = require('./updater');
const updater = initUpdater({ onStatus: (s) => console.log(`[updater] ${s}`) });
// keep `updater` for the menu item in Task 11
global.helixUpdater = updater;
```

- [ ] **Step 4: Verify no-op in dev**

Run: `npm run dev:desktop`. Expected log: `[updater] disabled (dev)`. No network calls, no crash.

- [ ] **Step 5: Commit**

```bash
git add desktop/updater.js desktop/main.js desktop/electron-builder.yml
git commit -m "feat(desktop): auto-update wiring against github releases (no-op in dev)"
```

---

## Task 11: Application menu

**Files:**
- Create: `desktop/menu.js`
- Modify: `desktop/main.js` (build menu after window)

**Interfaces:**
- Consumes: `stateDir` (paths), `global.helixUpdater` (Task 10).
- Produces: `buildMenu({ window, onRestartBackend })` → void (sets the app menu).

- [ ] **Step 1: Create `desktop/menu.js`**

```js
// desktop/menu.js
const { Menu, shell, app } = require('electron');
const { stateDir } = require('./paths');

function buildMenu({ window, onRestartBackend }) {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Tools',
      submenu: [
        { label: 'Check for Updates', click: () => global.helixUpdater?.checkNow() },
        { label: 'Open Data Folder', click: () => shell.openPath(stateDir()) },
        { label: 'View Logs', click: () => shell.openPath(app.getPath('logs')) },
        { type: 'separator' },
        { label: 'Restart Backend', click: () => onRestartBackend?.() },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
```

- [ ] **Step 2: Wire into `main.js`**

After the window and updater are set up:

```js
const { buildMenu } = require('./menu');
buildMenu({
  window: mainWindow,
  onRestartBackend: async () => {
    if (backend) await backend.stop();
    backend = await startBackend();
    mainWindow.loadURL(process.env.HELIX_DESKTOP_DEV ? 'http://127.0.0.1:3000' : backend.baseUrl);
  },
});
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev:desktop`. Confirm the Tools menu appears; "Open Data Folder" opens the state dir; "Restart Backend" reloads the UI without orphaning a process; "Check for Updates" logs `disabled (dev)`.

- [ ] **Step 4: Commit**

```bash
git add desktop/menu.js desktop/main.js
git commit -m "feat(desktop): application menu with tools actions"
```

---

## Task 12: System tray with backend status

**Files:**
- Create: `desktop/tray.js`
- Create: `desktop/resources/trayTemplate.png` (small monochrome template icon)
- Modify: `desktop/main.js`

**Interfaces:**
- Produces: `createTray({ window, getStatus })` → { setStatus(text), destroy() }.

- [ ] **Step 1: Create `desktop/tray.js`**

```js
// desktop/tray.js
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

function createTray({ window }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'resources', 'trayTemplate.png'));
  const tray = new Tray(icon);
  let status = 'starting';

  const render = () => {
    tray.setToolTip(`Helix Configurator (${status})`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Backend: ${status}`, enabled: false },
        { type: 'separator' },
        { label: 'Show', click: () => { window.show(); window.focus(); } },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
  };
  render();

  return {
    setStatus: (s) => { status = s; render(); },
    destroy: () => tray.destroy(),
  };
}

module.exports = { createTray };
```

- [ ] **Step 2: Wire into `main.js`**

```js
const { createTray } = require('./tray');
const tray = createTray({ window: mainWindow });
tray.setStatus('running');
```

Set `tray.setStatus('stopped')` in the backend `exit` handler before showing the dialog, and `tray.setStatus('running')` after a successful restart.

- [ ] **Step 3: Manual verification**

Run: `npm run dev:desktop`. Confirm a tray icon appears, shows "Backend: running", "Show" focuses the window, "Quit" exits cleanly.

- [ ] **Step 4: Commit**

```bash
git add desktop/tray.js desktop/resources/trayTemplate.png desktop/main.js
git commit -m "feat(desktop): system tray with backend status"
```

---

## Task 13: Double-click dev launchers

**Files:**
- Create: `desktop/dev.command` (macOS)
- Create: `desktop/dev.bat` (Windows)

**Interfaces:**
- Produces: two thin wrappers that each run the one dev command.

- [ ] **Step 1: Create `desktop/dev.command`**

```bash
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
npm run dev:desktop
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x desktop/dev.command`

- [ ] **Step 3: Create `desktop/dev.bat`**

```bat
@echo off
cd /d "%~dp0.."
call npm run dev:desktop
```

- [ ] **Step 4: Manual verification**

On macOS: double-click `dev.command` in Finder. Expected: Terminal opens, the app launches. On Windows: double-click `dev.bat`. Expected: the app launches.

- [ ] **Step 5: Commit**

```bash
git add desktop/dev.command desktop/dev.bat
git commit -m "feat(desktop): double-click dev launchers for mac and windows"
```

---

## Task 14: Lazy Docker gate in the Docker onboarding flow

**Files:**
- Modify: `backend/routes/lifecycle.js` (add a daemon-reachability guard on the create/start path)
- Modify: `frontend/src/App.tsx` (surface a friendly message when the guard reports Docker unreachable)

**Interfaces:**
- Produces: when Docker is unreachable, the Docker-target action returns HTTP 503 with `{ error: 'docker-unavailable', message }`, and the UI shows a "Start Docker Desktop and retry" notice instead of a raw error. The K8s / generate-only path is untouched.

- [ ] **Step 1: Add a reachability helper and guard in `lifecycle.js`**

At the point where a Docker-target action first touches the daemon (before `docker.pull`/`createContainer`), add:

```js
async function assertDockerUp(docker) {
  try {
    await docker.ping();
  } catch {
    const err = new Error('Docker Desktop is not running. Start it and try again.');
    err.statusCode = 503;
    err.code = 'docker-unavailable';
    throw err;
  }
}
```

Call `await assertDockerUp(docker);` at the start of the create/start handler, and ensure the error handler maps `err.code === 'docker-unavailable'` to a 503 JSON body `{ error: 'docker-unavailable', message: err.message }`.

- [ ] **Step 2: Handle the 503 in the Docker-target UI path**

In `App.tsx`, where the Docker onboarding action calls the lifecycle endpoint, detect `res.status === 503` with `error === 'docker-unavailable'` and render the existing notice/toast component with the message plus a Retry button. Do not block other views.

- [ ] **Step 3: Manual verification**

Stop Docker Desktop. In the app, choose the Docker onboarding target. Expected: a clear "Start Docker Desktop and retry" message, no crash, and the K8s target still works. Start Docker, click Retry, confirm the flow proceeds.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/lifecycle.js frontend/src/App.tsx
git commit -m "feat: lazy docker gate for the docker onboarding target"
```

---

## Task 15: Code signing and notarization (env-driven, off by default)

**Files:**
- Modify: `desktop/electron-builder.yml` (afterSign hook, entitlements)
- Create: `desktop/build/entitlements.mac.plist`
- Create: `desktop/notarize.js` (afterSign hook)

**Interfaces:**
- Produces: signed + notarized artifacts when signing env vars are present; unsigned artifacts otherwise.

- [ ] **Step 1: Add entitlements**

```xml
<!-- desktop/build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

- [ ] **Step 2: Reference entitlements in the mac block**

```yaml
mac:
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
afterSign: notarize.js
```

- [ ] **Step 3: Create the notarize hook (skips itself when creds absent)**

```js
// desktop/notarize.js
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] skipped (no Apple credentials in env)');
    return;
  }
  const { notarize } = require('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;
  await notarize({
    appBundleId: 'com.bmc.helix.otel-configurator',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] done');
};
```

Add `@electron/notarize` to `desktop` devDependencies. macOS signing itself is automatic when `CSC_LINK` + `CSC_KEY_PASSWORD` are set; Windows signing likewise. With all signing env vars unset, `npm run dist` still produces working unsigned builds.

- [ ] **Step 4: Verify unsigned build still works with creds absent**

Run: `cd desktop && npm run dist` with no signing env vars. Expected log includes `[notarize] skipped` and the build completes.

- [ ] **Step 5: Commit**

```bash
git add desktop/build/entitlements.mac.plist desktop/notarize.js desktop/electron-builder.yml desktop/package.json
git commit -m "feat(desktop): env-driven signing and notarization, off by default"
```

---

## Task 16: Packaged smoke test in CI

**Files:**
- Create: `.github/workflows/desktop-build.yml`

**Interfaces:**
- Produces: CI that builds the app on macOS and Windows runners and asserts the backend health inside the packaged app before uploading artifacts.

- [ ] **Step 1: Create the workflow**

```yaml
name: desktop-build
on:
  workflow_dispatch:
  push:
    tags: ['v*']
jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci --prefix backend
      - run: npm ci --prefix frontend
      - run: npm ci --prefix desktop
      - run: npm run build            # frontend-dist
      - run: npm --prefix desktop run dist
      - uses: actions/upload-artifact@v4
        with:
          name: helix-desktop-${{ matrix.os }}
          path: desktop/dist/*
```

The `postinstall`/`install-app-deps` step rebuilds `better-sqlite3` for Electron on each runner. Signing stays off in CI until secrets are added (Task 15).

- [ ] **Step 2: Add a headless launch assertion (follow-up if flaky)**

If a full GUI launch is impractical on CI, assert the supervisor unit tests plus a build-artifact existence check. Record here that the manual packaged smoke (Task 8 Step 4, Task 9 Step 3) is the gate until a headless harness is added.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/desktop-build.yml
git commit -m "ci: desktop build workflow for mac and windows"
```

---

## Self-Review

**Spec coverage:**
- Section 2 (process model) → Tasks 5, 6.
- Section 3 (backend env-gated changes) → Tasks 1, 2, 3.
- Section 4 (no hard Docker gate; lazy target gate) → Task 14.
- Section 5 (project structure) → Tasks 4-13.
- Section 6 (packaging, universal mac, nsis, native rebuild, asar/unpack) → Tasks 8, 9.
- Section 7 (auto-update, GitHub Releases, no-op in dev) → Task 10.
- Section 8 (menu, tray, dialogs, single-instance, notifications) → Tasks 6, 7, 11, 12. (Native notifications are minor; add via `new Notification()` in the backend-exit handler during Task 12 if desired.)
- Section 9 (signing off by default) → Task 15.
- Section 10 (one-command dev + double-click) → Tasks 6, 13.
- Section 11 (testing) → Tasks 5, 16.
- Section 12 (back-compat; env-gated) → guaranteed by Tasks 1-3 defaults; verified in Task 3 Step 3.

**Placeholder scan:** `<github-org-or-user>` / `<repo-name>` in Task 10 are the only intentional fill-ins, called out explicitly. Icons in Tasks 8/9/12 note "placeholder acceptable initially". No hidden TODOs.

**Type consistency:** `startBackend()` returns `{ port, baseUrl, child, stop }` in Task 5 and is consumed with those exact names in Tasks 6, 11. `waitForHealth(baseUrl, opts)` signature matches its test. `initUpdater({ onStatus })` returns `{ checkNow }`, consumed via `global.helixUpdater.checkNow()` in Task 11. `stateDir()`/`backendEntry()`/`templatesDir()` defined in Task 5 paths.js, consumed in Tasks 5, 6, 7, 11.
