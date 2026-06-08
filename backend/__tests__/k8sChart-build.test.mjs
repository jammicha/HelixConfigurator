// backend/__tests__/k8sChart-build.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { buildChartFiles } from '../k8sChart/index.js';

const COLLECTOR = `
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
service:
  pipelines:
    traces: { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    logs:   { exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

describe('buildChartFiles', () => {
  it('target=local: rewrites viewer exporter to host.docker.internal:8765, no viewer in values', () => {
    const { values, gatewayConfig } = buildChartFiles({
      collectorYaml: COLLECTOR, endpoint: 'https://h/otlp', xSource: 'acme', target: 'local',
    });
    const v = yaml.load(values);
    const g = yaml.load(gatewayConfig);
    expect(v.viewer).toBeUndefined();
    expect(v.helix.endpoint).toBe('https://h/otlp');
    expect(g.exporters['otlphttp/helix_local_viewer'].traces_endpoint).toBe('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('target=remote: strips the viewer exporter, no viewer in values', () => {
    const { values, gatewayConfig } = buildChartFiles({ collectorYaml: COLLECTOR, target: 'remote' });
    expect(yaml.load(values).viewer).toBeUndefined();
    expect(yaml.load(gatewayConfig).exporters['otlphttp/helix_local_viewer']).toBeUndefined();
  });
});
