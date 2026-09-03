import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { syncManagedExporters, readManagedExporters, verifyManagedYaml } from '../collectorConnections.js';

const SHIPPED = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  batch:
    timeout: 1s
exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
    headers:
      X-Api-Key: \${env:HELIX_API_KEY}
      X-Source: \${env:X_SOURCE}
  # Don't remove this - /otel-data depends on it.
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
    encoding: json
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters:
        - otlphttp/bmchelix
        - otlphttp/helix_local_viewer
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters:
        - otlphttp/bmchelix
        - otlphttp/helix_local_viewer
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters:
        - otlphttp/bmchelix
        - otlphttp/helix_local_viewer
`;

const allSignals = { traces: true, metrics: true, logs: true };

describe('syncManagedExporters', () => {
  it('renames legacy bmchelix to _default and keeps it in all pipelines', () => {
    const out = syncManagedExporters(SHIPPED, [{ id: 'default', signals: allSignals }]);
    const doc = yaml.load(out);
    expect(Object.keys(doc.exporters)).toContain('otlphttp/bmchelix_default');
    expect(Object.keys(doc.exporters)).not.toContain('otlphttp/bmchelix');
    for (const sig of ['traces', 'metrics', 'logs']) {
      expect(doc.service.pipelines[sig].exporters).toContain('otlphttp/bmchelix_default');
      expect(doc.service.pipelines[sig].exporters).toContain('otlphttp/helix_local_viewer');
    }
  });

  it('adds a second connection and respects per-signal membership', () => {
    const out = syncManagedExporters(SHIPPED, [
      { id: 'default', signals: allSignals },
      { id: 'beta', signals: { traces: true, metrics: false, logs: false } },
    ]);
    const doc = yaml.load(out);
    expect(doc.exporters['otlphttp/bmchelix_beta'].endpoint).toBe('${env:HELIX_ENDPOINT_BETA}');
    expect(doc.exporters['otlphttp/bmchelix_beta'].headers['X-Api-Key']).toBe('${env:HELIX_API_KEY_BETA}');
    expect(doc.service.pipelines.traces.exporters).toContain('otlphttp/bmchelix_beta');
    expect(doc.service.pipelines.metrics.exporters).not.toContain('otlphttp/bmchelix_beta');
    expect(doc.service.pipelines.logs.exporters).not.toContain('otlphttp/bmchelix_beta');
  });

  it('removes an exporter dropped from the connection list', () => {
    const two = syncManagedExporters(SHIPPED, [{ id: 'default', signals: allSignals }, { id: 'beta', signals: allSignals }]);
    const one = syncManagedExporters(two, [{ id: 'default', signals: allSignals }]);
    const doc = yaml.load(one);
    expect(Object.keys(doc.exporters)).not.toContain('otlphttp/bmchelix_beta');
    for (const sig of ['traces', 'metrics', 'logs']) {
      expect(doc.service.pipelines[sig].exporters).not.toContain('otlphttp/bmchelix_beta');
    }
  });

  it('preserves comments, the viewer exporter, and a hand-added exporter with a processor', () => {
    const handEdited = SHIPPED
      .replace('processors:\n  batch:\n    timeout: 1s', 'processors:\n  batch:\n    timeout: 1s\n  memory_limiter:\n    limit_mib: 400')
      .replace('  otlphttp/helix_local_viewer:', '  otlphttp/my_own:\n    endpoint: http://mine:4318\n  otlphttp/helix_local_viewer:');
    const out = syncManagedExporters(handEdited, [{ id: 'default', signals: allSignals }]);
    expect(out).toContain("# Don't remove this - /otel-data depends on it.");
    expect(out).toContain('otlphttp/my_own:');
    expect(out).toContain('memory_limiter:');
    const doc = yaml.load(out);
    expect(doc.exporters['otlphttp/my_own'].endpoint).toBe('http://mine:4318');
  });

  it('emits no managed exporter and leaves the viewer in the pipelines when the list is empty', () => {
    const out = syncManagedExporters(SHIPPED, []);
    const doc = yaml.load(out);
    expect(readManagedExporters(out)).toEqual([]);
    for (const sig of ['traces', 'metrics', 'logs']) {
      expect(doc.service.pipelines[sig].exporters).toContain('otlphttp/helix_local_viewer');
      expect(doc.service.pipelines[sig].exporters.some((e) => e.startsWith('otlphttp/bmchelix'))).toBe(false);
    }
  });
});

describe('verifyManagedYaml', () => {
  it('passes when exporters, pipelines, and env keys all agree', () => {
    const out = syncManagedExporters(SHIPPED, [{ id: 'default', signals: allSignals }]);
    const env = { HELIX_ENDPOINT_DEFAULT: 'x', HELIX_API_KEY_DEFAULT: 'y', X_SOURCE_DEFAULT: 'z' };
    expect(() => verifyManagedYaml(out, [{ id: 'default', signals: allSignals }], env)).not.toThrow();
  });
  it('throws when a referenced env key is missing', () => {
    const out = syncManagedExporters(SHIPPED, [{ id: 'default', signals: allSignals }]);
    expect(() => verifyManagedYaml(out, [{ id: 'default', signals: allSignals }], {})).toThrow(/env key/i);
  });
});
