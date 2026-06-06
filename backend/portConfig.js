// backend/portConfig.js
// Resolve the HTTP port. Native installs bind 8765 directly (no Docker port
// mapping); the Docker image sets PORT=3001 and keeps the host 8765:3001 map.
function resolvePort(env) {
  const raw = Number.parseInt(env.PORT, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8765;
}
module.exports = { resolvePort };
