// backend/k8sChart/transformCollectorConfig.js
// PURE: transform the live collector config into the gateway ConfigMap payload.
// - Rewrites (or strips) the hardcoded local-viewer exporter so it targets the
//   in-cluster viewer Service instead of http://helix-configurator:3001.
// - Ensures a health_check extension so the gateway Deployment can use httpGet probes.
// The Helix exporter's ${env:...} substitutions are left untouched — the values
// arrive via the pod's env (Secret + values), and the ConfigMap embeds this file
// via `.Files.Get` (raw bytes), so no Helm/Go templating touches them.
const yaml = require('js-yaml');

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';

function invalid(message, cause) {
  const err = new Error(message);
  err.code = 'INVALID_COLLECTOR_YAML';
  if (cause) {
    err.cause = cause;
    if (cause.mark) err.mark = { line: cause.mark.line, column: cause.mark.column, message: cause.reason };
  }
  return err;
}

function ensureHealthCheckExtension(doc) {
  doc.extensions = doc.extensions || {};
  if (!doc.extensions.health_check) {
    doc.extensions.health_check = { endpoint: '0.0.0.0:13133' };
  }
  doc.service = doc.service || {};
  const exts = Array.isArray(doc.service.extensions) ? doc.service.extensions : [];
  if (!exts.includes('health_check')) exts.push('health_check');
  doc.service.extensions = exts;
}

function transformCollectorConfig(yamlString, { viewerEnabled, viewerServiceName = 'helix-viewer' } = {}) {
  let doc;
  try {
    doc = yaml.load(yamlString);
  } catch (e) {
    throw invalid('Invalid collector YAML', e);
  }
  if (!doc || typeof doc !== 'object') throw invalid('Collector config is empty or not a mapping');

  doc.exporters = doc.exporters || {};
  const viewer = doc.exporters[VIEWER_EXPORTER_KEY];

  if (viewerEnabled) {
    if (viewer) {
      for (const key of ['traces_endpoint', 'logs_endpoint', 'metrics_endpoint']) {
        if (typeof viewer[key] === 'string') {
          // Replace scheme + host:port, preserve the /api/otlp/* path. The viewer
          // Service is exposed on 8765 (its container port is 3001) so the human URL
          // is localhost:8765/otel-data; in-cluster the gateway reaches it the same way.
          viewer[key] = viewer[key].replace(/^https?:\/\/[^/]+/, `http://${viewerServiceName}:8765`);
        }
      }
    }
  } else {
    delete doc.exporters[VIEWER_EXPORTER_KEY];
    const pipelines = (doc.service && doc.service.pipelines) || {};
    for (const name of Object.keys(pipelines)) {
      const p = pipelines[name];
      if (p && Array.isArray(p.exporters)) {
        p.exporters = p.exporters.filter(e => e !== VIEWER_EXPORTER_KEY);
      }
    }
  }

  ensureHealthCheckExtension(doc);
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

module.exports = { transformCollectorConfig, ensureHealthCheckExtension, VIEWER_EXPORTER_KEY };
