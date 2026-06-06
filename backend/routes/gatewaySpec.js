// backend/routes/gatewaySpec.js
// Pure builder for the dockerode createContainer spec that stands up the
// gateway from scratch — the job docker-compose.yml does in the container path.
// Mirrors docker-compose.yml: contrib collector, ports 4317/4318/8888 published,
// collector yaml mounted, env from .env, on the helix-bridge network.
const GATEWAY_IMAGE = 'otel/opentelemetry-collector-contrib:latest';

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
      PortBindings: {
        '4317/tcp': [{ HostPort: '4317' }],
        '4318/tcp': [{ HostPort: '4318' }],
        '8888/tcp': [{ HostPort: '8888' }],
      },
    },
  };
}
module.exports = { buildGatewayCreateSpec, GATEWAY_IMAGE };
