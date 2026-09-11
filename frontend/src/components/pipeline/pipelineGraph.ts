import yaml from 'js-yaml';

export type NodeKind =
  | 'source' | 'receiver' | 'processor' | 'exporter' | 'connector' | 'sink' | 'missing';
export type Signal = 'traces' | 'metrics' | 'logs';

export type GraphNode = {
  id: string;
  kind: NodeKind;
  componentType: string;
  componentName: string;
  label: string;
  detail?: string;
  missing?: boolean;
};
export type PipelineLane = { signal: Signal; nodeIds: string[]; edges: [string, string][] };
export type PipelineGraph = {
  nodes: Record<string, GraphNode>;
  lanes: PipelineLane[];
  hasServiceBlock: boolean;
};
export type GraphResult =
  | { ok: true; graph: PipelineGraph }
  | { ok: false; error: string; line?: number };

export function baseType(componentName: string): string {
  return componentName.split('/')[0];
}

const SIGNALS: Signal[] = ['traces', 'metrics', 'logs'];

function otlpProtocolDetail(receivers: Record<string, any> | undefined): string | undefined {
  const otlp = receivers?.otlp;
  if (!otlp) return undefined;
  const p = otlp.protocols || {};
  const parts: string[] = [];
  if (p.grpc) parts.push('gRPC :4317');
  if (p.http) parts.push('HTTP :4318');
  return parts.length ? parts.join(' - ') : undefined;
}

function sinkFor(name: string, endpointHost?: string): GraphNode {
  let label = 'External endpoint';
  if (name.includes('bmchelix')) label = 'BMC Helix tenant';
  else if (name.includes('helix_local_viewer')) label = 'Local viewer (this app)';
  return {
    id: `sink:${name}`,
    kind: 'sink',
    componentType: baseType(name),
    componentName: name,
    label,
    detail: endpointHost,
  };
}

function hostOf(exporterCfg: any): string | undefined {
  const ep = exporterCfg?.endpoint || exporterCfg?.traces_endpoint;
  if (typeof ep !== 'string') return undefined;
  return ep.replace(/^https?:\/\//, '').split('/')[0] || undefined;
}

export function buildPipelineGraph(yamlText: string): GraphResult {
  let doc: any;
  try {
    doc = yaml.load(yamlText);
  } catch (e: any) {
    const line = e?.mark?.line != null ? e.mark.line + 1 : undefined;
    return { ok: false, error: e?.reason || e?.message || 'Invalid YAML', line };
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: true, graph: { nodes: {}, lanes: [], hasServiceBlock: false } };
  }

  const receivers = doc.receivers || {};
  const processors = doc.processors || {};
  const exporters = doc.exporters || {};
  const pipelines = doc.service?.pipelines;
  const nodes: Record<string, GraphNode> = {};
  const lanes: PipelineLane[] = [];

  const defOf = (stage: 'receiver' | 'processor' | 'exporter', name: string) => {
    const map = stage === 'receiver' ? receivers : stage === 'processor' ? processors : exporters;
    const present = Object.prototype.hasOwnProperty.call(map, name);
    const id = `${stage}:${name}`;
    if (!nodes[id]) {
      nodes[id] = {
        id, kind: present ? stage : 'missing',
        componentType: baseType(name), componentName: name, label: name,
        missing: !present,
      };
    }
    return id;
  };

  const sourceDetail = otlpProtocolDetail(receivers);

  for (const signal of SIGNALS) {
    const pl = pipelines?.[signal];
    if (!pl) continue;
    const nodeIds: string[] = [];
    const edges: [string, string][] = [];

    const recNames: string[] = pl.receivers || [];
    const procNames: string[] = pl.processors || [];
    const expNames: string[] = pl.exporters || [];

    if (recNames.includes('otlp')) {
      const srcId = `source:${signal}`;
      nodes[srcId] = {
        id: srcId, kind: 'source', componentType: '', componentName: '',
        label: 'Your apps', detail: sourceDetail,
      };
      nodeIds.push(srcId);
    }

    const recIds = recNames.map(n => defOf('receiver', n));
    const procIds = procNames.map(n => defOf('processor', n));
    const expIds = expNames.map(n => defOf('exporter', n));
    nodeIds.push(...recIds, ...procIds, ...expIds);

    for (const name of expNames) {
      const sink = sinkFor(name, hostOf(exporters[name]));
      nodes[sink.id] = sink;
      nodeIds.push(sink.id);
    }

    // Edges: source -> each receiver; fan-in/fan-out through processors; exporter -> its sink.
    const src = nodeIds.find(id => nodes[id].kind === 'source');
    if (src) for (const r of recIds) edges.push([src, r]);

    if (procIds.length > 0) {
      // Each receiver fans in to the first processor.
      for (const r of recIds) edges.push([r, procIds[0]]);
      // Chain processors: proc[i] -> proc[i+1].
      for (let i = 0; i < procIds.length - 1; i++) {
        edges.push([procIds[i], procIds[i + 1]]);
      }
      // Last processor fans out to each exporter.
      for (const e of expIds) edges.push([procIds[procIds.length - 1], e]);
    } else {
      // No processors: each receiver fans out to each exporter.
      for (const r of recIds) {
        for (const e of expIds) edges.push([r, e]);
      }
    }

    for (const name of expNames) edges.push([`exporter:${name}`, `sink:${name}`]);

    lanes.push({ signal, nodeIds, edges });
  }

  return { ok: true, graph: { nodes, lanes, hasServiceBlock: !!doc.service } };
}
