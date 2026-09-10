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
