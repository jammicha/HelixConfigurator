// backend/k8sChart/renderValues.js
// PURE: render the chart's values.yaml from live state. Non-secret values
// (endpoint, xSource) are baked; the apiKey is ALWAYS empty (supplied via
// --set at install). Resource names are stable for Docker-parity DNS.
const yaml = require('js-yaml');

const DEFAULTS = {
  gatewayName: 'helix-gateway',
  viewerName: 'helix-viewer',
  collectorImage: 'otel/opentelemetry-collector-contrib',
  collectorTag: '0.119.0', // pinned; verify/bump to a validated contrib release
  viewerImage: 'helix-configurator',
  viewerTag: 'latest',
};

function renderValues({ endpoint = '', xSource = '', viewerEnabled = true } = {}) {
  const rl = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  const values = {
    helix: { endpoint, xSource, apiKey: '' },
    gateway: {
      name: DEFAULTS.gatewayName,
      image: { repository: DEFAULTS.collectorImage, tag: DEFAULTS.collectorTag, pullPolicy: 'IfNotPresent' },
      replicas: 1,
      resources: rl,
      service: { type: 'ClusterIP' },
    },
    viewer: {
      enabled: viewerEnabled,
      name: DEFAULTS.viewerName,
      image: { repository: DEFAULTS.viewerImage, tag: DEFAULTS.viewerTag, pullPolicy: 'IfNotPresent' },
      resources: rl,
      persistence: { size: '2Gi', storageClass: '' },
    },
  };
  return yaml.dump(values, { lineWidth: -1, noRefs: true });
}

module.exports = { renderValues, DEFAULTS };
