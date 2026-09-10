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
  it('builds correct edges in traces lane with processors and multiple exporters', () => {
    if (!res.ok) return;
    const traces = res.graph.lanes.find(l => l.signal === 'traces')!;
    const edgeSet = new Set(traces.edges.map(e => `${e[0]}->${e[1]}`));

    // Expected edges with processors present
    expect(edgeSet.has('source:traces->receiver:otlp')).toBe(true);
    expect(edgeSet.has('receiver:otlp->processor:batch')).toBe(true);
    expect(edgeSet.has('processor:batch->exporter:otlphttp/bmchelix')).toBe(true);
    expect(edgeSet.has('processor:batch->exporter:otlphttp/helix_local_viewer')).toBe(true);
    expect(edgeSet.has('exporter:otlphttp/bmchelix->sink:otlphttp/bmchelix')).toBe(true);
    expect(edgeSet.has('exporter:otlphttp/helix_local_viewer->sink:otlphttp/helix_local_viewer')).toBe(
      true
    );

    // Should NOT have exporter->exporter edge
    expect(edgeSet.has('exporter:otlphttp/bmchelix->exporter:otlphttp/helix_local_viewer')).toBe(
      false
    );
  });
});

describe('buildPipelineGraph (no processors case)', () => {
  const NO_PROC_YAML = `
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
exporters:
  otlphttp/endpoint1:
    endpoint: http://endpoint1:4318
  otlphttp/endpoint2:
    endpoint: http://endpoint2:4318
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/endpoint1, otlphttp/endpoint2]
`;

  const res = buildPipelineGraph(NO_PROC_YAML);
  it('parses ok', () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.hasServiceBlock).toBe(true);
  });
  it('fans each receiver directly to each exporter when no processors', () => {
    if (!res.ok) return;
    const traces = res.graph.lanes.find(l => l.signal === 'traces')!;
    const edgeSet = new Set(traces.edges.map(e => `${e[0]}->${e[1]}`));

    // Receivers should fan out to all exporters
    expect(edgeSet.has('receiver:otlp->exporter:otlphttp/endpoint1')).toBe(true);
    expect(edgeSet.has('receiver:otlp->exporter:otlphttp/endpoint2')).toBe(true);

    // Exporters should connect to their sinks
    expect(edgeSet.has('exporter:otlphttp/endpoint1->sink:otlphttp/endpoint1')).toBe(true);
    expect(edgeSet.has('exporter:otlphttp/endpoint2->sink:otlphttp/endpoint2')).toBe(true);

    // Should NOT have receiver->receiver or exporter->exporter
    expect(edgeSet.has('receiver:otlp->receiver:otlp')).toBe(false);
    expect(edgeSet.has('exporter:otlphttp/endpoint1->exporter:otlphttp/endpoint2')).toBe(false);
  });
});
