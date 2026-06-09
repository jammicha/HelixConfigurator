// backend/routes/gatewaySpec.js
// Pure builder for the dockerode createContainer spec that stands up the
// gateway from scratch — the job docker-compose.yml does in the container path.
// Mirrors docker-compose.yml: contrib collector, ports 4317/4318/8888 published,
// collector yaml mounted, env from .env, on the helix-bridge network.
// Pinned to the same contrib release the generated Helm charts use (single
// source of truth in k8sChart DEFAULTS). `latest` meant a breaking upstream
// release could brick every fresh gateway create at first-run time.
const { DEFAULTS: CHART_DEFAULTS } = require('../k8sChart/renderValues');
const GATEWAY_IMAGE = `${CHART_DEFAULTS.collectorImage}:${CHART_DEFAULTS.collectorTag}`;

function buildGatewayCreateSpec({ name, env, configHostPath }) {
  return {
    name,
    Image: GATEWAY_IMAGE,
    Env: env,
    ExposedPorts: { '4317/tcp': {}, '4318/tcp': {}, '8888/tcp': {} },
    HostConfig: {
      NetworkMode: 'helix-bridge',
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: [`${configHostPath}:/etc/otelcol-contrib/config.yaml:ro`],
      // host.docker.internal is the fan-out target (host-run configurator on
      // :8765). Docker Desktop resolves it automatically, but native Linux
      // Docker Engine — the license-free "no Docker Desktop" audience — does
      // not, so map it to the bridge gateway. Docker Desktop accepts this
      // harmlessly, so it's safe on every platform.
      ExtraHosts: ['host.docker.internal:host-gateway'],
      PortBindings: {
        '4317/tcp': [{ HostPort: '4317' }],
        '4318/tcp': [{ HostPort: '4318' }],
        '8888/tcp': [{ HostPort: '8888' }],
      },
    },
  };
}
module.exports = { buildGatewayCreateSpec, GATEWAY_IMAGE };
