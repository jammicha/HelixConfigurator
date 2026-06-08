// backend/statePaths.js
// Single source of truth for where mutable state lives. In the container the
// data/ volume is mounted at /app/data. Natively the package root is the
// parent of backend/, so state lands in <installRoot>/data alongside the binary.
const path = require('path');

function resolveDataDir({ appDirExists, backendDir }) {
  if (appDirExists) return '/app/data';
  return path.join(path.resolve(backendDir, '..'), 'data');
}
module.exports = { resolveDataDir };
