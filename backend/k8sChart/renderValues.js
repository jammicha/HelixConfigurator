// backend/k8sChart/renderValues.js
// PURE: render the chart's values.yaml from live state. Non-secret values
// (endpoint, xSource) are baked; the apiKey is ALWAYS empty. At install the user
// either references a pre-created Secret (helix.existingSecret — recommended) or
// passes --set helix.apiKey (quick demo). Resource names are stable for Docker-parity DNS.
const yaml = require('js-yaml');

const DEFAULTS = {
  gatewayName: 'helix-gateway',
  collectorImage: 'otel/opentelemetry-collector-contrib',
  collectorTag: '0.119.0', // pinned; verify/bump to a validated contrib release
};

function renderValues({ endpoint = '', xSource = '' } = {}) {
  const rl = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  const values = {
    helix: { endpoint, xSource, apiKey: '', existingSecret: '', existingSecretKey: 'HELIX_API_KEY' },
    gateway: {
      name: DEFAULTS.gatewayName,
      image: { repository: DEFAULTS.collectorImage, tag: DEFAULTS.collectorTag, pullPolicy: 'IfNotPresent' },
      replicas: 1,
      resources: rl,
      service: { type: 'ClusterIP' },
    },
  };
  return yaml.dump(values, { lineWidth: -1, noRefs: true });
}

module.exports = { renderValues, DEFAULTS };
