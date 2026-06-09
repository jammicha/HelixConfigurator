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
// Scoped line-by-line to the `otlphttp/helix_local_viewer:` block: an earlier
// global regex rewrote per-signal `*_endpoint:` keys in ANY exporter, silently
// redirecting user-added exporters that used that (legal) otlphttp form.
function rewriteLocalViewerToHost(yamlString) {
  if (typeof yamlString !== 'string') return yamlString;
  const viewerKeyRe = /^(\s*)otlphttp\/helix_local_viewer:\s*(#.*)?$/;
  const endpointRe = /\b(traces_endpoint|logs_endpoint|metrics_endpoint):(\s*)https?:\/\/[^/\s]+/;
  const lines = yamlString.split('\n');
  let viewerIndent = -1; // -1 = not inside the viewer block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = line.match(viewerKeyRe);
    if (key) { viewerIndent = key[1].length; continue; }
    if (viewerIndent < 0) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // blanks/comments don't end a YAML block
    if (line.match(/^(\s*)/)[1].length <= viewerIndent) { viewerIndent = -1; continue; } // dedent → block over
    lines[i] = line.replace(endpointRe, (_m, k, ws) => `${k}:${ws}http://${LOCAL_VIEWER_HOST}`);
  }
  return lines.join('\n');
}
module.exports = { rewriteLocalViewerToHost, VIEWER_EXPORTER_KEY, LOCAL_VIEWER_HOST };
