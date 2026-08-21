// backend/routes/update.js — one-click self-update for native installs.
//
// v1 scope: macOS/Linux native packages only. The flow is
//   POST /api/update/start  → download the platform zip from GitHub Releases
//                             into <installRoot>/.update/, extract, validate
//                             (client polls GET /api/update/status)
//   POST /api/update/apply  → copy applyUpdate.js out to .update/, spawn it
//                             detached with the STAGED node binary, then
//                             gracefully exit; the updater swaps the tree
//                             (preserving user state) and relaunches.
//
// Docker can't replace its own image from inside, and Windows locks the
// running node.exe/native addons — both report supported:false with guidance
// so the banner shows instructions instead of a button. A useful side effect
// of backend-driven downloads: no browser quarantine xattr, so macOS
// Gatekeeper never re-fires on updates.
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { IS_CONTAINERIZED } = require('../util');

const REPO = process.env.RELEASES_REPO || 'jammicha/HelixConfigurator';

// Keyed by `${process.platform}-${process.arch}`; values match the asset
// names native-release.yml uploads.
const PLATFORM_ASSETS = {
  'darwin-arm64': 'helix-configurator-darwin-arm64.zip',
  'linux-x64': 'helix-configurator-linux-amd64.zip',
  'win32-x64': 'helix-configurator-windows-amd64.zip',
};

// User state the swap must never touch (mirrored in applyUpdate.js, which
// runs standalone and can't require this module).
const PRESERVED_ENTRIES = ['.env', 'data', 'helix-otel-collector.yaml', '.update'];

// What makes this install self-updatable. Inputs injectable for tests.
function detectCapability({
  platform = process.platform,
  arch = process.arch,
  installRoot,
  appDirExists = IS_CONTAINERIZED,
} = {}) {
  if (appDirExists) {
    return {
      supported: false, mode: 'docker',
      hint: 'docker compose pull && docker compose up -d',
    };
  }
  const asset = PLATFORM_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    return {
      supported: false, mode: 'unsupported-platform',
      hint: 'Download the latest zip from GitHub Releases and extract it over this directory.',
    };
  }
  if (platform === 'win32') {
    // The running node.exe and loaded native addons are file-locked on
    // Windows; the swap needs rename-shuffle treatment we haven't built yet.
    return {
      supported: false, mode: 'windows',
      hint: 'Close the app, extract the new zip over this directory, then run start.bat.',
    };
  }
  if (!fs.existsSync(path.join(installRoot, 'node'))) {
    // No bundled runtime ⇒ a dev checkout / docker-less source run, not a
    // native package — swapping git-tracked files would be hostile.
    return { supported: false, mode: 'dev-checkout', hint: 'git pull, rebuild the frontend, restart.' };
  }
  return { supported: true, mode: 'native', asset };
}

// PUBLIC, and registered ahead of the auth gate in index.js — same treatment
// /api/version already gets, and for the same reason. The update banner is
// meant to work without signing in, so a read-only "can this install update
// itself?" probe has to be reachable too. Behind the gate it 401s, the banner
// falls back to generic text, and a password-protected install can never show
// the button that applies the update. Read-only: it reports, it never mutates.
// The endpoints that DO mutate (start / apply) stay inside register(), behind
// the gate, deliberately.
function registerPublicRoutes(app, { installRoot = path.resolve(__dirname, '..', '..') } = {}) {
  app.get('/api/update/capability', (req, res) => {
    const { supported, mode, hint } = detectCapability({ installRoot });
    res.json({ supported, mode, hint });
  });
}

function register(app, { currentVersion, installRoot = path.resolve(__dirname, '..', '..') } = {}) {
  // Module-level state machine; one update at a time per process.
  const state = { phase: 'idle', error: null, targetVersion: null, staged: null };

  const runUpdate = async (asset) => {
    const updDir = path.join(installRoot, '.update');
    state.phase = 'downloading';
    await fsp.rm(updDir, { recursive: true, force: true });
    await fsp.mkdir(updDir, { recursive: true });
    const r = await fetch(`https://github.com/${REPO}/releases/latest/download/${asset}`, { redirect: 'follow' });
    if (!r.ok) throw new Error(`download failed (HTTP ${r.status})`);
    const zipPath = path.join(updDir, 'release.zip');
    await fsp.writeFile(zipPath, Buffer.from(await r.arrayBuffer()));

    state.phase = 'extracting';
    const extractRoot = path.join(updDir, 'extracted');
    // keepOriginalPermission is best-effort; the updater re-chmods the runtime.
    new AdmZip(zipPath).extractAllTo(extractRoot, true, true);
    const staged = path.join(extractRoot, 'helix-configurator');

    state.phase = 'validating';
    for (const must of ['node', path.join('backend', 'index.js'), 'frontend-dist']) {
      if (!fs.existsSync(path.join(staged, must))) throw new Error(`staged package incomplete: missing ${must}`);
    }
    const stagedPkg = JSON.parse(await fsp.readFile(path.join(staged, 'backend', 'package.json'), 'utf8'));
    if (stagedPkg.version === currentVersion) throw new Error(`already on the latest version (v${currentVersion})`);
    await fsp.chmod(path.join(staged, 'node'), 0o755);

    state.staged = staged;
    state.targetVersion = stagedPkg.version;
    state.phase = 'ready';
  };

  app.get('/api/update/status', (req, res) => {
    res.json({ phase: state.phase, error: state.error, targetVersion: state.targetVersion });
  });

  app.post('/api/update/start', (req, res) => {
    const cap = detectCapability({ installRoot });
    if (!cap.supported) {
      res.status(400).json({ error: 'Self-update is not supported for this install.', ...cap });
      return;
    }
    if (state.phase !== 'idle' && state.phase !== 'error' && state.phase !== 'ready') {
      res.status(409).json({ error: `update already ${state.phase}` });
      return;
    }
    state.error = null;
    res.json({ started: true }); // long-running: the client polls /status
    runUpdate(cap.asset).catch((e) => {
      console.error('[update] failed:', e.message);
      state.phase = 'error';
      state.error = e.message;
    });
  });

  app.post('/api/update/apply', (req, res) => {
    if (state.phase !== 'ready' || !state.staged) {
      res.status(409).json({ error: 'no staged update to apply — POST /api/update/start first' });
      return;
    }
    const updDir = path.join(installRoot, '.update');
    // Copy the updater OUT of the tree about to be replaced; run it with the
    // STAGED runtime so nothing in the old install is held open.
    fs.copyFileSync(path.join(__dirname, '..', 'applyUpdate.js'), path.join(updDir, 'apply.js'));
    const logFd = fs.openSync(path.join(updDir, 'apply.log'), 'a');
    const child = spawn(
      path.join(state.staged, 'node'),
      [path.join(updDir, 'apply.js'), '--install-root', installRoot, '--staged', state.staged, '--old-pid', String(process.pid)],
      { detached: true, stdio: ['ignore', logFd, logFd], cwd: updDir, env: process.env },
    );
    child.unref();
    state.phase = 'restarting';
    res.json({ restarting: true, targetVersion: state.targetVersion });
    // Reuse the graceful shutdown path (server close + store checkpoint);
    // the updater takes over once this pid is gone.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 800);
  });
}

module.exports = { register, registerPublicRoutes, detectCapability, PLATFORM_ASSETS, PRESERVED_ENTRIES };
