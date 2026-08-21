// backend/__tests__/k8sChart-transform.test.mjs
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { transformCollectorConfig, VIEWER_EXPORTER_KEY } from '../k8sChart/transformCollectorConfig.js';

const BASE = `
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  batch: { timeout: 1s }
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
    headers:
      X-Api-Key: \${env:HELIX_API_KEY}
      X-Source: \${env:X_SOURCE}
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
    tls: { insecure: true }
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
    logs:    { receivers: [otlp], processors: [batch], exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer] }
`;

describe('transformCollectorConfig', () => {
  it('target=local: rewrites viewer endpoints to host.docker.internal:8765', () => {
    const out = yaml.load(transformCollectorConfig(BASE, { target: 'local' }));
    const v = out.exporters[VIEWER_EXPORTER_KEY];
    expect(v.traces_endpoint).toBe('http://host.docker.internal:8765/api/otlp/traces');
    expect(v.logs_endpoint).toBe('http://host.docker.internal:8765/api/otlp/logs');
    expect(v.metrics_endpoint).toBe('http://host.docker.internal:8765/api/otlp/metrics');
    // Helix exporter and pipelines untouched.
    expect(out.exporters['otlphttp/bmchelix'].endpoint).toBe('${env:HELIX_ENDPOINT}');
    expect(out.service.pipelines.traces.exporters).toContain(VIEWER_EXPORTER_KEY);
  });

  it('target=local: honours a PORT override, proving the endpoint is derived rather than hardcoded', () => {
    const prevPort = process.env.PORT;
    process.env.PORT = '9100';
    try {
      const out = yaml.load(transformCollectorConfig(BASE, { target: 'local' }));
      const v = out.exporters[VIEWER_EXPORTER_KEY];
      expect(v.traces_endpoint).toBe('http://host.docker.internal:9100/api/otlp/traces');
      expect(v.logs_endpoint).toBe('http://host.docker.internal:9100/api/otlp/logs');
      expect(v.metrics_endpoint).toBe('http://host.docker.internal:9100/api/otlp/metrics');
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it('target=local: a containerized configurator emits its PUBLISHED port, not its internal PORT', () => {
    // The Docker image sets ENV PORT=3001 and compose publishes 8765:3001.
    // The chart's URL is host-facing (a K8s pod cannot resolve the compose
    // service name), so 3001 there is a permanently dead fan-out.
    const prevPort = process.env.PORT;
    process.env.PORT = '3001';
    try {
      const out = yaml.load(transformCollectorConfig(BASE, { target: 'local', containerized: true }));
      const v = out.exporters[VIEWER_EXPORTER_KEY];
      expect(v.traces_endpoint).toBe('http://host.docker.internal:8765/api/otlp/traces');
      expect(v.logs_endpoint).toBe('http://host.docker.internal:8765/api/otlp/logs');
      expect(v.metrics_endpoint).toBe('http://host.docker.internal:8765/api/otlp/metrics');
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it('target=remote: removes the viewer exporter and its pipeline refs, keeps bmchelix', () => {
    const out = yaml.load(transformCollectorConfig(BASE, { target: 'remote' }));
    expect(out.exporters[VIEWER_EXPORTER_KEY]).toBeUndefined();
    expect(out.service.pipelines.traces.exporters).toEqual(['otlphttp/bmchelix']);
    expect(out.service.pipelines.logs.exporters).toEqual(['otlphttp/bmchelix']);
    expect(out.service.pipelines.metrics.exporters).toEqual(['otlphttp/bmchelix']);
  });

  it('always injects a health_check extension wired into the service', () => {
    const on = yaml.load(transformCollectorConfig(BASE, { target: 'local' }));
    expect(on.extensions.health_check.endpoint).toBe('0.0.0.0:13133');
    expect(on.service.extensions).toContain('health_check');
  });

  it('does not duplicate an existing health_check extension', () => {
    const withHc = BASE + '\nextensions:\n  health_check: { endpoint: 0.0.0.0:13133 }\n';
    const out = yaml.load(transformCollectorConfig(withHc, { target: 'local' }));
    expect(out.service.extensions.filter(e => e === 'health_check')).toHaveLength(1);
  });

  it('viewer exporter already absent: no throw, bmchelix intact', () => {
    const noViewer = `
exporters: { otlphttp/bmchelix: { endpoint: x } }
service: { pipelines: { traces: { exporters: [otlphttp/bmchelix] } } }
`;
    const out = yaml.load(transformCollectorConfig(noViewer, { target: 'remote' }));
    expect(out.exporters['otlphttp/bmchelix']).toBeDefined();
    expect(out.service.pipelines.traces.exporters).toEqual(['otlphttp/bmchelix']);
  });

  it('malformed YAML throws a typed INVALID_COLLECTOR_YAML error', () => {
    const capture = (s) => {
      try { transformCollectorConfig(s, { target: 'local' }); }
      catch (e) { return e; }
      throw new Error('expected transformCollectorConfig to throw, but it did not');
    };
    expect(capture('a: b:\n  - [unclosed').message).toMatch(/collector/i);
    expect(capture(':\n::').code).toBe('INVALID_COLLECTOR_YAML');
  });

  it('target=local but exporter absent: no throw, viewer stays absent, health_check added', () => {
    const noViewer = `
exporters: { otlphttp/bmchelix: { endpoint: x } }
service: { pipelines: { traces: { exporters: [otlphttp/bmchelix] } } }
`;
    const out = yaml.load(transformCollectorConfig(noViewer, { target: 'local' }));
    expect(out.exporters[VIEWER_EXPORTER_KEY]).toBeUndefined();
    expect(out.exporters['otlphttp/bmchelix']).toBeDefined();
    expect(out.extensions.health_check).toBeDefined();
  });
});
