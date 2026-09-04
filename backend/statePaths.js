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
