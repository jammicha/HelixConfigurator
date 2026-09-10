// backend/statePaths.js
// Single source of truth for where mutable state lives. In the container the
// data/ volume is mounted at /app/data. Natively the package root is the
// parent of backend/, so state lands in <installRoot>/data alongside the binary.
// Electron sets the HELIX_* overrides so state lives in the OS userData dir,
// which is writable even when the app bundle is read-only.
const path = require('path');
const fs = require('fs');

function rootFrom(backendDir) {
  return path.resolve(backendDir, '..');
}

// The base collector config that ships beside backend/. Native and Docker
// installs resolve their config path here directly; desktop mode relocates the
// live config into userData and seeds it from this base.
function baseConfigPath(backendDir) {
  return path.join(rootFrom(backendDir), 'helix-otel-collector.yaml');
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

// Guarantee the collector config exists as a regular FILE at the resolved path
// before anything reads, rewrites, or bind-mounts it. Desktop mode points the
// config into a fresh userData dir that ships no config, and a gateway create
// against a missing bind source makes Docker auto-create it as a directory,
// which then breaks every later config write and mount. Seeding from the base
// config avoids both. Returns the resolved path. When the resolved path IS the
// base (native and Docker installs), this is a no-op.
function ensureConfigSeeded({ backendDir, configPath } = {}) {
  const target = configPath || resolveConfigPath({ backendDir });
  const base = baseConfigPath(backendDir);
  if (path.resolve(target) === path.resolve(base)) return target;
  try {
    let stat = null;
    try { stat = fs.statSync(target); } catch { stat = null; }
    if (stat && stat.isFile()) return target;
    // Repair the Docker-auto-created directory case before seeding a real file.
    if (stat && stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(base, target);
  } catch (e) {
    console.warn(`ensureConfigSeeded: could not seed collector config at ${target}:`, e.message);
  }
  return target;
}

module.exports = { resolveDataDir, resolveEnvPath, resolveConfigPath, ensureConfigSeeded };
