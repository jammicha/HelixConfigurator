// backend/collectorFanout.js
// Shared rewrite: point the local-viewer exporter at the configurator running
// on the host. Used by BOTH the native-Docker gateway path (configurator on the
// host, gateway in a container) and the K8s local-cluster path. Callers pass
// YAML text in/out.

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';
const LOCAL_VIEWER_HOST = 'host.docker.internal:8765';

// Surgically rewrite ONLY the local-viewer exporter's endpoint hosts to the
// host-reachable address, preserving comments/formatting (this rewrites the
// user's on-disk collector yaml in place, so we must not clobber their config).
function rewriteLocalViewerToHost(yamlString) {
  if (typeof yamlString !== 'string') return yamlString;
  return yamlString.replace(
    /\b(traces_endpoint|logs_endpoint|metrics_endpoint):(\s*)https?:\/\/[^/\s]+/g,
    (_m, key, ws) => `${key}:${ws}http://${LOCAL_VIEWER_HOST}`,
  );
}
module.exports = { rewriteLocalViewerToHost, VIEWER_EXPORTER_KEY, LOCAL_VIEWER_HOST };
