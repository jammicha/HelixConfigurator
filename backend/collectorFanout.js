// backend/collectorFanout.js
// Shared rewrite: point the local-viewer exporter at the configurator running
// on the host. Used by BOTH the native-Docker gateway path (configurator on the
// host, gateway in a container) and the K8s local-cluster path. Operating on the
// parsed doc keeps it robust to formatting; callers pass YAML text in/out.
const yaml = require('js-yaml');

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';
const LOCAL_VIEWER_HOST = 'host.docker.internal:8765';

function rewriteLocalViewerToHost(yamlString) {
  const doc = yaml.load(yamlString);
  if (!doc || typeof doc !== 'object') return yamlString;
  const viewer = (doc.exporters || {})[VIEWER_EXPORTER_KEY];
  if (viewer) {
    for (const key of ['traces_endpoint', 'logs_endpoint', 'metrics_endpoint']) {
      if (typeof viewer[key] === 'string') {
        viewer[key] = viewer[key].replace(/^https?:\/\/[^/]+/, `http://${LOCAL_VIEWER_HOST}`);
      }
    }
  }
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}
module.exports = { rewriteLocalViewerToHost, VIEWER_EXPORTER_KEY, LOCAL_VIEWER_HOST };
