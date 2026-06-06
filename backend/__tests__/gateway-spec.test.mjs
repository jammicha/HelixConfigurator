// backend/__tests__/gateway-spec.test.mjs
import { describe, it, expect } from 'vitest';
import { buildGatewayCreateSpec } from '../routes/gatewaySpec.js';

describe('buildGatewayCreateSpec', () => {
  const env = ['HELIX_ENDPOINT=https://t.onbmc.com', 'HELIX_API_KEY=k::a::s', 'X_SOURCE=svc'];
  const spec = buildGatewayCreateSpec({ name: 'helix-gateway', env, configHostPath: '/opt/helix/helix-otel-collector.yaml' });

  it('uses the contrib collector image', () => {
    expect(spec.Image).toBe('otel/opentelemetry-collector-contrib:latest');
  });
  it('publishes 4317, 4318, 8888 to the host', () => {
    expect(spec.HostConfig.PortBindings['4317/tcp']).toEqual([{ HostPort: '4317' }]);
    expect(spec.HostConfig.PortBindings['4318/tcp']).toEqual([{ HostPort: '4318' }]);
    expect(spec.HostConfig.PortBindings['8888/tcp']).toEqual([{ HostPort: '8888' }]);
  });
  it('mounts the collector yaml read-only at the contrib config path', () => {
    expect(spec.HostConfig.Binds).toContain('/opt/helix/helix-otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro');
  });
  it('passes the env array through', () => {
    expect(spec.Env).toEqual(env);
  });
  it('attaches the helix-bridge network', () => {
    expect(spec.HostConfig.NetworkMode).toBe('helix-bridge');
  });
});
