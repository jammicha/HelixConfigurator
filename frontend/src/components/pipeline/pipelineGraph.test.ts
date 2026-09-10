import { describe, it, expect } from 'vitest';
import { buildPipelineGraph, baseType } from './pipelineGraph';

const DEFAULT_HELIX = `
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
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix, otlphttp/helix_local_viewer]
`;

describe('baseType', () => {
  it('strips the instance suffix', () => {
    expect(baseType('otlphttp/bmchelix')).toBe('otlphttp');
    expect(baseType('otlp/2')).toBe('otlp');
    expect(baseType('batch')).toBe('batch');
  });
});

describe('buildPipelineGraph (default Helix config)', () => {
  const res = buildPipelineGraph(DEFAULT_HELIX);
  it('parses ok with a service block', () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.hasServiceBlock).toBe(true);
  });
  it('produces three lanes, one per signal', () => {
    if (!res.ok) return;
    expect(res.graph.lanes.map(l => l.signal).sort()).toEqual(['logs', 'metrics', 'traces']);
  });
  it('prepends a source node and appends helix + local-viewer sinks in the traces lane', () => {
    if (!res.ok) return;
    const traces = res.graph.lanes.find(l => l.signal === 'traces')!;
    const kinds = traces.nodeIds.map(id => res.graph.nodes[id].kind);
    expect(kinds[0]).toBe('source');
    expect(kinds.filter(k => k === 'sink').length).toBe(2);
    const labels = traces.nodeIds.map(id => res.graph.nodes[id].label);
    expect(labels).toContain('BMC Helix tenant');
    expect(labels).toContain('Local viewer (this app)');
  });
  it('records otlp protocols on the source detail', () => {
    if (!res.ok) return;
    const traces = res.graph.lanes.find(l => l.signal === 'traces')!;
    const source = res.graph.nodes[traces.nodeIds[0]];
    expect(source.detail).toMatch(/gRPC/);
    expect(source.detail).toMatch(/4317/);
    expect(source.detail).toMatch(/4318/);
  });
});
