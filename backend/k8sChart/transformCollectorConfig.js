// backend/k8sChart/transformCollectorConfig.js
// PURE: transform the live collector config into the gateway ConfigMap payload.
// - target='local': rewrites the local-viewer exporter to a host-facing URL so
//   telemetry flows back to the configurator running on the host. A K8s pod
//   cannot resolve the compose service name, so this is host.docker.internal
//   on the PUBLISHED port even when the configurator is itself containerized
//   (where PORT is the container-internal 3001, not the 8765 compose
//   publishes). Callers may override `containerized` to keep this pure.
// - target='remote': strips the viewer exporter entirely (Helix-only).
// - Ensures a health_check extension so the gateway Deployment can use httpGet probes.
// The Helix exporter's ${env:...} substitutions are left untouched — the values
// arrive via the pod's env (Secret + values), and the ConfigMap embeds this file
// via `.Files.Get` (raw bytes), so no Helm/Go templating touches them.
const yaml = require('js-yaml');
const { VIEWER_EXPORTER_KEY } = require('../collectorFanout');
const { hostFacingViewerEndpoint } = require('../viewerEndpoint');
const { IS_CONTAINERIZED } = require('../util');

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

function transformCollectorConfig(yamlString, { target = 'local', containerized = IS_CONTAINERIZED } = {}) {
  let doc;
  try {
    doc = yaml.load(yamlString);
  } catch (e) {
    throw invalid('Invalid collector YAML', e);
  }
  if (!doc || typeof doc !== 'object') throw invalid('Collector config is empty or not a mapping');

  doc.exporters = doc.exporters || {};
  const viewer = doc.exporters[VIEWER_EXPORTER_KEY];

  if (target === 'local') {
    if (viewer) {
      const viewerEndpoint = hostFacingViewerEndpoint({ containerized });
      for (const key of ['traces_endpoint', 'logs_endpoint', 'metrics_endpoint']) {
        if (typeof viewer[key] === 'string') {
          // Replace scheme + host:port, preserve the /api/otlp/* path.
          viewer[key] = viewer[key].replace(/^https?:\/\/[^/]+/, viewerEndpoint);
        }
      }
    }
  } else {
    // target === 'remote': strip the viewer exporter entirely.
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
