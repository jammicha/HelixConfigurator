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
});
