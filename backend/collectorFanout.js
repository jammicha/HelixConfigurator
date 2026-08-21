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

const VIEWER_KEY_RE = /^(\s*)otlphttp\/helix_local_viewer:\s*(#.*)?$/;
const ENDPOINT_RE = /\b(traces_endpoint|logs_endpoint|metrics_endpoint):(\s*)(https?:\/\/[^/\s]+)/;

// Invoke fn(line, index) for every line INSIDE the
// `otlphttp/helix_local_viewer:` block of `lines`.
//
// Scoped line-by-line rather than parsed: an earlier global regex rewrote
// per-signal `*_endpoint:` keys in ANY exporter, silently redirecting
// user-added exporters that used that (legal) otlphttp form. The scoping
// rules are subtle enough — blank lines and comments do NOT end a block, a
// dedent does — that the reader and the rewriter must not each keep their
// own copy of them.
function forEachViewerBlockLine(lines, fn) {
  let viewerIndent = -1; // -1 = not inside the viewer block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = line.match(VIEWER_KEY_RE);
    if (key) { viewerIndent = key[1].length; continue; }
    if (viewerIndent < 0) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // blanks/comments don't end a YAML block
    if (line.match(/^(\s*)/)[1].length <= viewerIndent) { viewerIndent = -1; continue; } // dedent -> block over
    fn(line, i);
  }
}

// Surgically rewrite ONLY the local-viewer exporter's endpoint hosts,
// preserving comments/formatting (this rewrites the user's on-disk collector
// yaml in place, so we must not clobber their config).
function rewriteLocalViewerEndpoint(yamlString, target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('rewriteLocalViewerEndpoint: target must be a non-empty URL string');
  }
  if (typeof yamlString !== 'string') return yamlString;
  const base = target.replace(/\/+$/, '');
  const lines = yamlString.split('\n');
  forEachViewerBlockLine(lines, (line, i) => {
    lines[i] = line.replace(ENDPOINT_RE, (_m, k, ws) => `${k}:${ws}${base}`);
  });
  return lines.join('\n');
}

// The inverse read: the scheme://host:port the viewer exporter currently
// points at, or null when there is no viewer block / no endpoint in it.
// Returns the FIRST signal's endpoint — rewriteLocalViewerEndpoint always
// writes all three together, so they do not diverge in practice.
//
// Exists so a caller can ask "is what is already on disk a legitimate
// endpoint?" before overwriting it. The create-time candidate ladder can
// leave a PROVEN fallback (the bridge gateway IP) on disk, and the ladder is
// create-only, so nothing would re-derive it if a recreate clobbered it.
function readLocalViewerEndpoint(yamlString) {
  if (typeof yamlString !== 'string') return null;
  let found = null;
  forEachViewerBlockLine(yamlString.split('\n'), (line) => {
    if (found) return;
    const m = line.match(ENDPOINT_RE);
    if (m) found = m[3];
  });
  return found;
}

module.exports = { rewriteLocalViewerEndpoint, readLocalViewerEndpoint, VIEWER_EXPORTER_KEY };
