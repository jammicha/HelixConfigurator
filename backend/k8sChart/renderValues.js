// backend/k8sChart/renderValues.js
const yaml = require('js-yaml');

const DEFAULTS = {
  gatewayName: 'helix-gateway',
  collectorImage: 'otel/opentelemetry-collector-contrib',
  collectorTag: '0.119.0', // pinned; verify/bump to a validated contrib release
};

const ALL_LANGUAGES = { java: true, nodejs: true, python: true, dotnet: true };

function renderValues({ endpoint = '', xSource = '', engine = 'deployment', languages } = {}) {
  const rl = { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } };
  const helix = { endpoint, xSource, apiKey: '', existingSecret: '', existingSecretKey: 'HELIX_API_KEY' };
  const gateway = {
    name: DEFAULTS.gatewayName,
    image: { repository: DEFAULTS.collectorImage, tag: DEFAULTS.collectorTag, pullPolicy: 'IfNotPresent' },
    replicas: 1,
    resources: rl,
  };

  if (engine === 'operator') {
    gateway.aliasService = true;
    const langs = { ...ALL_LANGUAGES, ...(languages || {}) };
    const values = {
      helix,
      gateway,
      instrumentation: {
        languages: langs,
        images: { java: '', nodejs: '', python: '', dotnet: '' },
      },
    };
    return yaml.dump(values, { lineWidth: -1, noRefs: true });
  }

  // engine === 'deployment' (unchanged shape)
  gateway.service = { type: 'ClusterIP' };
  return yaml.dump({ helix, gateway }, { lineWidth: -1, noRefs: true });
}

module.exports = { renderValues, DEFAULTS };
