import { describe, it, expect } from 'vitest';
import {
  detectCollectorContainers,
  containerExposesOtlp,
  containerHasCollectorImage,
} from '../util.js';

// Fixture shape matches what docker.listContainers() returns. Only the
// fields the detector reads are populated.
const make = (name, { image = '', command = '', ports = [], networks = {} } = {}) => ({
  Names: [`/${name}`],
  Image: image,
  Command: command,
  Ports: ports,
  NetworkSettings: { Networks: networks },
});

const otlpPort = (privatePort) => ({ PrivatePort: privatePort, Type: 'tcp' });

describe('containerHasCollectorImage', () => {
  it('matches official contrib image', () => {
    expect(containerHasCollectorImage(make('x', { image: 'otel/opentelemetry-collector-contrib:0.110.0' }))).toBe(true);
  });
  it('matches non-contrib upstream image', () => {
    expect(containerHasCollectorImage(make('x', { image: 'otel/opentelemetry-collector:latest' }))).toBe(true);
  });
  it('matches otelcol in command line', () => {
    expect(containerHasCollectorImage(make('x', { image: 'busybox', command: '/otelcol --config=foo.yaml' }))).toBe(true);
  });
  it('rejects unrelated busybox', () => {
    expect(containerHasCollectorImage(make('x', { image: 'busybox', command: '/bin/sh' }))).toBe(false);
  });
});

describe('containerExposesOtlp', () => {
  it('matches port 4317', () => {
    expect(containerExposesOtlp(make('x', { ports: [otlpPort(4317)] }))).toBe(true);
  });
  it('matches port 4318', () => {
    expect(containerExposesOtlp(make('x', { ports: [otlpPort(4318)] }))).toBe(true);
  });
  it('ignores unrelated ports', () => {
    expect(containerExposesOtlp(make('x', { ports: [otlpPort(8080), otlpPort(9090)] }))).toBe(false);
  });
  it('handles missing Ports array', () => {
    expect(containerExposesOtlp(make('x'))).toBe(false);
  });
});

describe('detectCollectorContainers', () => {
  it('zero containers → empty list', () => {
    expect(detectCollectorContainers([])).toEqual([]);
  });

  it('zero collectors → empty list', () => {
    const containers = [
      make('redis', { image: 'redis:7' }),
      make('postgres', { image: 'postgres:16', ports: [otlpPort(5432)] }),
    ];
    expect(detectCollectorContainers(containers)).toEqual([]);
  });

  it('one image-only collector → detectedVia=image', () => {
    const containers = [make('otelcol-1', { image: 'otel/opentelemetry-collector-contrib:0.110.0' })];
    const result = detectCollectorContainers(containers);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('otelcol-1');
    expect(result[0].detectedVia).toBe('image');
  });

  it('one port-only collector (vendor distro) → detectedVia=ports', () => {
    const containers = [
      make('datadog-agent', { image: 'gcr.io/datadoghq/agent:7.55', ports: [otlpPort(4318)] }),
    ];
    const result = detectCollectorContainers(containers);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('datadog-agent');
    expect(result[0].detectedVia).toBe('ports');
  });

  it('dual-signal collector → detectedVia=image+ports', () => {
    const containers = [
      make('otelcol-2', {
        image: 'otel/opentelemetry-collector-contrib:latest',
        ports: [otlpPort(4317), otlpPort(4318)],
      }),
    ];
    const result = detectCollectorContainers(containers);
    expect(result[0].detectedVia).toBe('image+ports');
  });

  it('three collectors → all returned, ranked dual-signal > image > ports', () => {
    const containers = [
      make('port-only', { image: 'vendor/agent:1', ports: [otlpPort(4318)] }),
      make('image-only', { image: 'otel/opentelemetry-collector:0.100.0' }),
      make('dual', {
        image: 'otel/opentelemetry-collector-contrib:0.110.0',
        ports: [otlpPort(4318)],
      }),
    ];
    const result = detectCollectorContainers(containers);
    expect(result.map(r => r.name)).toEqual(['dual', 'image-only', 'port-only']);
    expect(result.map(r => r.detectedVia)).toEqual(['image+ports', 'image', 'ports']);
  });

  it('compose-prefixed names work', () => {
    const containers = [
      make('acme_otel-collector_1', { image: 'otel/opentelemetry-collector-contrib:latest' }),
    ];
    const result = detectCollectorContainers(containers);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('acme_otel-collector_1');
  });

  it('excludes the configured sidecar by name', () => {
    const containers = [
      make('helix-gateway', { image: 'otel/opentelemetry-collector-contrib:latest', ports: [otlpPort(4318)] }),
      make('user-otelcol', { image: 'otel/opentelemetry-collector:0.100.0' }),
    ];
    const result = detectCollectorContainers(containers, { sidecarName: 'helix-gateway' });
    expect(result.map(r => r.name)).toEqual(['user-otelcol']);
  });

  it('excludes other helix-* containers by prefix', () => {
    // A future helix-* sidecar (helix-configurator, hypothetical helix-anything)
    // must never be classified as a customer collector even if its image or
    // ports match — otherwise the apply/restart routes could be coerced into
    // operating on our own containers.
    const containers = [
      make('helix-configurator', { image: 'otel/opentelemetry-collector-contrib:latest', ports: [otlpPort(4318)] }),
      make('helix-something-else', { image: 'otel/opentelemetry-collector:latest' }),
    ];
    const result = detectCollectorContainers(containers, { sidecarName: 'helix-gateway' });
    expect(result).toEqual([]);
  });

  it('honors includeHelix override (for diagnostics use cases)', () => {
    const containers = [
      make('helix-gateway', { image: 'otel/opentelemetry-collector-contrib:latest' }),
    ];
    const result = detectCollectorContainers(containers, { sidecarName: 'something-else', includeHelix: true });
    expect(result).toHaveLength(1);
  });

  it('skips containers with no name', () => {
    const containers = [
      { Names: [], Image: 'otel/opentelemetry-collector:latest', Ports: [] },
      make('valid', { image: 'otel/opentelemetry-collector:latest' }),
    ];
    const result = detectCollectorContainers(containers);
    expect(result.map(r => r.name)).toEqual(['valid']);
  });
});
