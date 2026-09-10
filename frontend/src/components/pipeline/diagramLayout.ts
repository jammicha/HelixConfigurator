import type { PipelineGraph, GraphNode, Signal } from './pipelineGraph';
import { resolveDoc, type ComponentDoc } from './componentDocs';

export type DiagramState = 'error' | 'empty' | 'graph';
export type Column = { kind: GraphNode['kind']; nodes: GraphNode[] };
export type LaneLayout = { signal: Signal; columns: Column[] };

const COLUMN_ORDER: GraphNode['kind'][] =
  ['source', 'receiver', 'processor', 'connector', 'exporter', 'sink', 'missing'];

export function diagramState(graph: PipelineGraph, hasParseError: boolean): DiagramState {
  if (hasParseError) return 'error';
  if (graph.lanes.length === 0 && !graph.hasServiceBlock) return 'empty';
  return 'graph';
}

export function layoutLanes(graph: PipelineGraph): LaneLayout[] {
  return graph.lanes.map(lane => {
    const byKind = new Map<GraphNode['kind'], GraphNode[]>();
    for (const id of lane.nodeIds) {
      const node = graph.nodes[id];
      if (!node) continue;
      const arr = byKind.get(node.kind) || [];
      arr.push(node);
      byKind.set(node.kind, arr);
    }
    const columns: Column[] = COLUMN_ORDER
      .filter(k => byKind.has(k))
      .map(k => ({ kind: k, nodes: byKind.get(k)! }));
    return { signal: lane.signal, columns };
  });
}

export function panelContent(node: GraphNode): ComponentDoc {
  return resolveDoc(node.componentName);
}
