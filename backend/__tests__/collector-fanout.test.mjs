import { describe, it, expect } from 'vitest';
import { rewriteLocalViewerEndpoint, readLocalViewerEndpoint } from '../collectorFanout.js';

const CONTAINER_YAML = `exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
  # keep this comment
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
    encoding: json
  otlphttp/user_added:
    traces_endpoint: http://my-own-collector:4318/v1/traces
`;

describe('rewriteLocalViewerEndpoint', () => {
  it('rewrites only the viewer block to the given target, preserving paths', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:9100');
    expect(out).toContain('traces_endpoint: http://host.docker.internal:9100/api/otlp/traces');
    expect(out).toContain('logs_endpoint: http://host.docker.internal:9100/api/otlp/logs');
    expect(out).toContain('metrics_endpoint: http://host.docker.internal:9100/api/otlp/metrics');
  });

  it('leaves a user-added exporter using the same endpoint form untouched', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765');
    expect(out).toContain('traces_endpoint: http://my-own-collector:4318/v1/traces');
  });

  it('preserves comments and formatting', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765');
    expect(out).toContain('# keep this comment');
    expect(out).toContain('encoding: json');
  });

  it('round-trips: container to host to container returns the original bytes', () => {
    const toHost = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765');
    const back = rewriteLocalViewerEndpoint(toHost, 'http://helix-configurator:3001');
    expect(back).toBe(CONTAINER_YAML);
  });

  it('strips a trailing slash from the target', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765/');
    expect(out).toContain('traces_endpoint: http://host.docker.internal:8765/api/otlp/traces');
    expect(out).not.toContain('8765//api');
  });

  it('returns non-string input unchanged', () => {
    expect(rewriteLocalViewerEndpoint(null, 'http://x:1')).toBe(null);
  });

  it('throws when the target is missing or empty', () => {
    expect(() => rewriteLocalViewerEndpoint(CONTAINER_YAML, '')).toThrow(TypeError);
  });
});

describe('readLocalViewerEndpoint', () => {
  it('reads the viewer block\'s endpoint host, not a user-added exporter\'s', () => {
    expect(readLocalViewerEndpoint(CONTAINER_YAML)).toBe('http://helix-configurator:3001');
  });

  it('is the exact inverse of the rewrite, for every target the ladder can write', () => {
    for (const target of [
      'http://host.docker.internal:8765',
      'http://host.docker.internal:9100',
      'http://172.30.0.1:8765',
      'http://helix-configurator:3001',
    ]) {
      expect(readLocalViewerEndpoint(rewriteLocalViewerEndpoint(CONTAINER_YAML, target))).toBe(target);
    }
  });

  it('returns null when there is no viewer block at all', () => {
    expect(readLocalViewerEndpoint('exporters:\n  otlphttp/bmchelix:\n    endpoint: x\n')).toBe(null);
  });

  it('returns null for a viewer block with no endpoint keys', () => {
    expect(readLocalViewerEndpoint('exporters:\n  otlphttp/helix_local_viewer:\n    encoding: json\n'))
      .toBe(null);
  });

  it('returns null for non-string input', () => {
    expect(readLocalViewerEndpoint(null)).toBe(null);
  });
});
