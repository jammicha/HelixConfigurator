// backend/collectorFanout.js
// Shared rewrite: point the local-viewer exporter at wherever the configurator
// is actually reachable from inside the gateway container. Used by BOTH the
// native-Docker gateway path (configurator on the host, gateway in a
// container) and the K8s local-cluster path. Callers pass YAML text in/out.
//
// The target is a parameter, not a constant. It used to be a hardcoded
// host.docker.internal:8765 with no inverse, which meant a PORT override
// silently killed the viewer and a native run left the yaml stuck in host
// mode forever. See viewerEndpoint.js for where targets come from.

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';

// Surgically rewrite ONLY the local-viewer exporter's endpoint hosts,
// preserving comments/formatting (this rewrites the user's on-disk collector
// yaml in place, so we must not clobber their config).
// Scoped line-by-line to the `otlphttp/helix_local_viewer:` block: an earlier
// global regex rewrote per-signal `*_endpoint:` keys in ANY exporter, silently
// redirecting user-added exporters that used that (legal) otlphttp form.
function rewriteLocalViewerEndpoint(yamlString, target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('rewriteLocalViewerEndpoint: target must be a non-empty URL string');
  }
  if (typeof yamlString !== 'string') return yamlString;
  const base = target.replace(/\/+$/, '');
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
    if (line.match(/^(\s*)/)[1].length <= viewerIndent) { viewerIndent = -1; continue; } // dedent -> block over
    lines[i] = line.replace(endpointRe, (_m, k, ws) => `${k}:${ws}${base}`);
  }
  return lines.join('\n');
}

module.exports = { rewriteLocalViewerEndpoint, VIEWER_EXPORTER_KEY };
