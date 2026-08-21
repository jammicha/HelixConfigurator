// backend/viewerEndpoint.js
// Single source of truth for "what URL should the gateway ship the local
// viewer fan-out to". This used to be a hardcoded literal in
// collectorFanout.js which ignored PORT and was never verified, so a user
// who relocated the UI got a permanently dead View OTel Data page.
// Pure functions only: no I/O, no docker, no env mutation.
const { resolvePort } = require('./portConfig');

// In-container path: the configurator shares the helix-bridge network with
// the gateway, so the compose service name resolves and the internal port is
// fixed at 3001 regardless of the published host port.
const CONTAINER_ENDPOINT = 'http://helix-configurator:3001';

// Ordered list of endpoints to try, best first. Native installs run the
// configurator as a host process, so the gateway has to cross the container
// boundary: host.docker.internal on Docker Desktop, with the bridge gateway
// IP as a fallback for Linux Docker Engine where that name can fail to
// resolve even with the injected ExtraHosts mapping.
function viewerCandidates({ env = process.env, containerized = false, bridgeIp = null } = {}) {
  if (containerized) return [CONTAINER_ENDPOINT];
  const port = resolvePort(env);
  const candidates = [`http://host.docker.internal:${port}`];
  if (bridgeIp) candidates.push(`http://${bridgeIp}:${port}`);
  return candidates;
}

function preferredViewerEndpoint(opts = {}) {
  return viewerCandidates(opts)[0];
}

module.exports = { viewerCandidates, preferredViewerEndpoint, CONTAINER_ENDPOINT };
