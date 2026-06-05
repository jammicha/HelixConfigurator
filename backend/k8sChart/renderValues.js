// backend/k8sChart/renderValues.js
// PURE: render the chart's values.yaml from live state. Non-secret values
// (endpoint, xSource) are baked; the apiKey is ALWAYS empty. At install the user
// either references a pre-created Secret (helix.existingSecret — recommended) or
// passes --set helix.apiKey (quick demo). Resource names are stable for Docker-parity DNS.
const yaml = require('js-yaml');

const DEFAULTS = {
  gatewayName: 'helix-gateway',
  viewerName: 'helix-viewer',
  collectorImage: 'otel/opentelemetry-collector-contrib',
  collectorTag: '0.119.0', // pinned; verify/bump to a validated contrib release
  viewerImage: 'ghcr.io/jammicha/helixconfigurator', // published image so the viewer pulls out of the box
  viewerTag: 'latest',
};

function renderValues({ endpoint = '', xSource = '', viewerEnabled = true } = {}) {
  const rl = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  const values = {
    // apiKey stays empty; existingSecret (recommended) references a pre-created
    // Secret so the key never passes through Helm. existingSecretKey is the key
    // name within that Secret.
    helix: { endpoint, xSource, apiKey: '', existingSecret: '', existingSecretKey: 'HELIX_API_KEY' },
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
      service: { type: 'ClusterIP' }, // internal by default — the viewer is unauthenticated, so never exposed by accident; on Docker Desktop/local --set viewer.service.type=LoadBalancer to open localhost:8765 with no port-forward
      resources: rl,
      persistence: { size: '2Gi', storageClass: '' },
    },
  };
  return yaml.dump(values, { lineWidth: -1, noRefs: true });
}

module.exports = { renderValues, DEFAULTS };
