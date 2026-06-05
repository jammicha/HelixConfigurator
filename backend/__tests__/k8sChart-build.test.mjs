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
  it('returns values.yaml and gateway config consistent with the toggle (viewer on)', () => {
    const { values, gatewayConfig } = buildChartFiles({
      collectorYaml: COLLECTOR, endpoint: 'https://h/otlp', xSource: 'acme', viewerEnabled: true,
    });
    const v = yaml.load(values);
    const g = yaml.load(gatewayConfig);
    expect(v.viewer.enabled).toBe(true);
    expect(v.helix.endpoint).toBe('https://h/otlp');
    expect(g.exporters['otlphttp/helix_local_viewer'].traces_endpoint).toBe('http://helix-viewer:8765/api/otlp/traces');
  });

  it('strips the viewer exporter when the toggle is off', () => {
    const { values, gatewayConfig } = buildChartFiles({ collectorYaml: COLLECTOR, viewerEnabled: false });
    expect(yaml.load(values).viewer.enabled).toBe(false);
    expect(yaml.load(gatewayConfig).exporters['otlphttp/helix_local_viewer']).toBeUndefined();
  });
});
