import { describe, it, expect } from 'vitest';
import { rewriteLocalViewerToHost } from '../collectorFanout.js';

const SRC = `
exporters:
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
`;

describe('rewriteLocalViewerToHost', () => {
  it('rewrites every viewer endpoint host to host.docker.internal:8765', () => {
    const out = rewriteLocalViewerToHost(SRC);
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/traces');
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/logs');
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/metrics');
    expect(out).not.toContain('helix-configurator:3001');
  });
  it('leaves the bmchelix exporter untouched', () => {
    const mixed = `
exporters:
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
`;
    const out = rewriteLocalViewerToHost(mixed);
    expect(out).toContain('${env:HELIX_ENDPOINT}');
  });

  it('does NOT touch per-signal endpoints in other exporters (scoped to the viewer block)', () => {
    const mixed = `
exporters:
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
  otlphttp/my_backup:
    traces_endpoint: https://collector.example.com/v1/traces
    logs_endpoint: https://collector.example.com/v1/logs
`;
    const out = rewriteLocalViewerToHost(mixed);
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/traces');
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/logs');
    expect(out).toContain('https://collector.example.com/v1/traces');
    expect(out).toContain('https://collector.example.com/v1/logs');
  });

  it('rewrites the viewer block even when a user exporter precedes it', () => {
    const mixed = `
exporters:
  otlphttp/my_backup:
    traces_endpoint: https://collector.example.com/v1/traces
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
`;
    const out = rewriteLocalViewerToHost(mixed);
    expect(out).toContain('https://collector.example.com/v1/traces');
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/traces');
  });

  it('preserves comment lines byte-for-byte after rewrite', () => {
    const withComment = `
exporters:
  # Auth headers are sourced from .env — secrets stay out of the committed YAML.
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
  # Fan-out: traces also flow to the local viewer for waterfalls.
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
`;
    const out = rewriteLocalViewerToHost(withComment);
    expect(out).toContain('# Auth headers are sourced from .env — secrets stay out of the committed YAML.');
    expect(out).toContain('# Fan-out: traces also flow to the local viewer for waterfalls.');
    expect(out).toContain('http://host.docker.internal:8765/api/otlp/traces');
    expect(out).toContain('${env:HELIX_ENDPOINT}');
  });
});
