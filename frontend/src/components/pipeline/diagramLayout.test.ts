import { describe, it, expect } from 'vitest';
import { diagramState, layoutLanes, panelContent } from './diagramLayout';
import type { PipelineGraph } from './pipelineGraph';

const graph: PipelineGraph = {
  hasServiceBlock: true,
  lanes: [{
    signal: 'traces',
    nodeIds: ['source:traces', 'receiver:otlp', 'processor:batch', 'exporter:otlphttp/bmchelix', 'sink:otlphttp/bmchelix'],
    edges: [],
  }],
  nodes: {
    'source:traces': { id: 'source:traces', kind: 'source', componentType: '', componentName: '', label: 'Your apps' },
    'receiver:otlp': { id: 'receiver:otlp', kind: 'receiver', componentType: 'otlp', componentName: 'otlp', label: 'otlp' },
    'processor:batch': { id: 'processor:batch', kind: 'processor', componentType: 'batch', componentName: 'batch', label: 'batch' },
    'exporter:otlphttp/bmchelix': { id: 'exporter:otlphttp/bmchelix', kind: 'exporter', componentType: 'otlphttp', componentName: 'otlphttp/bmchelix', label: 'otlphttp/bmchelix' },
    'sink:otlphttp/bmchelix': { id: 'sink:otlphttp/bmchelix', kind: 'sink', componentType: 'otlphttp', componentName: 'otlphttp/bmchelix', label: 'BMC Helix tenant' },
  },
};

describe('diagramState', () => {
  it('is error when there is a parse error', () => {
    expect(diagramState({ nodes: {}, lanes: [], hasServiceBlock: false }, true)).toBe('error');
  });
  it('is empty when no lanes and no service block and no parse error', () => {
    expect(diagramState({ nodes: {}, lanes: [], hasServiceBlock: false }, false)).toBe('empty');
  });
  it('is graph when lanes exist', () => {
    expect(diagramState(graph, false)).toBe('graph');
  });
});

describe('layoutLanes', () => {
  const [lane] = layoutLanes(graph);
  it('orders columns source, receiver, processor, exporter, sink', () => {
    expect(lane.columns.map(c => c.kind)).toEqual(['source', 'receiver', 'processor', 'exporter', 'sink']);
  });
  it('places the right node in each column', () => {
    expect(lane.columns[0].nodes[0].label).toBe('Your apps');
    expect(lane.columns.at(-1)!.nodes[0].label).toBe('BMC Helix tenant');
  });
});

describe('panelContent', () => {
  it('returns the resolved doc for a node', () => {
    const doc = panelContent(graph.nodes['receiver:otlp']);
    expect(doc.concept?.title).toMatch(/gRPC/i);
  });
});
