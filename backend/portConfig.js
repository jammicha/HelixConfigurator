// backend/portConfig.js
// Two DIFFERENT ports, deliberately named apart:
//
//   resolvePort          - the port THIS PROCESS binds and listens on.
//   resolvePublishedPort - the port the configurator is reachable on from
//                          OUTSIDE its own container boundary.
//
// Native installs bind 8765 directly, so the two are the same number. The
// Docker image is where they diverge: the Dockerfile sets PORT=3001 (the
// container-internal listen port) and docker-compose publishes 8765:3001. A
// host-facing URL — host.docker.internal, or a chart generated for a K8s pod
// that cannot resolve the compose service name — must carry the PUBLISHED
// port. Using PORT there yields a URL that resolves and then connects to
// nothing, which is exactly the silently-dead viewer fan-out this module
// exists to prevent.
const DEFAULT_PORT = 8765;

function resolvePort(env) {
  const raw = Number.parseInt(env.PORT, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

// `containerized` is a fact about where THIS process runs, not a style
// choice: pass the real value (util.js's IS_CONTAINERIZED) even when the URL
// being built is host-facing.
function resolvePublishedPort(env, { containerized = false } = {}) {
  // Natively the published port IS the listen port, by definition — there is
  // no port mapping to disagree with. So VIEWER_PUBLISHED_PORT has no
  // legitimate native meaning and is deliberately ignored here: honouring it
  // would let one .env shared between the compose and native deployments
  // point the fan-out at a port nothing is listening on.
  if (!containerized) return resolvePort(env);
  // Containerized: PORT is internal and must not appear in a host-facing URL.
  // VIEWER_PUBLISHED_PORT is for a user who remapped the compose publish.
  const override = Number.parseInt(env.VIEWER_PUBLISHED_PORT, 10);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_PORT;
}

module.exports = { resolvePort, resolvePublishedPort, DEFAULT_PORT };
