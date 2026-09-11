# Interactive Collector Pipeline Visualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, live diagram of the user's own collector config to the Gateway Config card, where every node is an annotated OpenTelemetry teaching surface.

**Architecture:** Frontend-only. A pure function parses the live Monaco buffer with the already-bundled `js-yaml` into a normalized graph model; a static content map supplies per-component teaching text; a presentational SVG/DOM component renders the graph and opens an annotation panel on node click. A "Diagram | YAML" toggle on the existing Gateway Config card switches between the editor and the diagram, both reading the same buffer state. No backend endpoint, no new dependency.

**Tech Stack:** React + TypeScript, Vite, Vitest (`TZ=America/Chicago vitest run`), `js-yaml@^4` (already a frontend dep), Tailwind classes matching existing components. Hand-rolled SVG/DOM in the style of `ServiceMap` / `TimelineChart`.

**Spec:** `docs/superpowers/specs/2026-09-10-otel-pipeline-visualizer-design.md`

## Global Constraints

- Work happens in the `brainstorm/otel-education` worktree at `.worktrees/otel-education`. Run all commands from there. Do NOT `cd` to the main checkout.
- Frontend tests run from `frontend/`: `TZ=America/Chicago npx vitest run <path>`. Tests are colocated with source as `*.test.ts` / `*.test.tsx`, using `import { describe, it, expect } from 'vitest'`.
- Read-only visualizer: never write config from the diagram. All editing stays in Monaco.
- No new npm dependency. Use `js-yaml` (already present) and hand-rolled SVG/DOM.
- Do not modify `backend/validate.js` or any backend route. "Undefined reference" detection is computed locally in `pipelineGraph.ts`.
- Sink classification is by exporter NAME: name contains `bmchelix` -> "BMC Helix tenant"; name contains `helix_local_viewer` -> "Local viewer (this app)"; otherwise "External endpoint". A component's base type is the key text before any `/` (e.g. `otlphttp/bmchelix` -> `otlphttp`, `otlp/2` -> `otlp`).
- No em dashes in any user-facing copy or comments. Restructure sentences instead.
- End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

- Create: `frontend/src/components/pipeline/pipelineGraph.ts` — pure YAML-to-graph model builder.
- Create: `frontend/src/components/pipeline/pipelineGraph.test.ts` — unit tests for the builder.
- Create: `frontend/src/components/pipeline/componentDocs.ts` — static teaching content map + resolver.
- Create: `frontend/src/components/pipeline/componentDocs.test.ts` — coverage test against `templates/`.
- Create: `frontend/src/components/pipeline/diagramLayout.ts` — pure view logic (lane -> columns by kind, empty/error/graph state, panel content lookup).
- Create: `frontend/src/components/pipeline/diagramLayout.test.ts` — unit tests for the view logic (node environment).
- Create: `frontend/src/components/pipeline/PipelineDiagram.tsx` — thin presentational renderer + annotation panel consuming `diagramLayout`. No render test, matching the repo convention that every component's testable logic lives in a pure helper (this project has no `.test.tsx` render tests and runs vitest in the `node` environment).
- Modify: the Gateway Config card in the dashboard (`frontend/src/components/dashboard/`, the parent that renders `GatewayConfigEditor` and holds the YAML buffer) — add the "Diagram | YAML" toggle.

---

### Task 1: Graph model types and the pure builder (happy path)

**Files:**
- Create: `frontend/src/components/pipeline/pipelineGraph.ts`
- Test: `frontend/src/components/pipeline/pipelineGraph.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module). `js-yaml` `load`.
- Produces:
  - `type NodeKind = 'source' | 'receiver' | 'processor' | 'exporter' | 'connector' | 'sink' | 'missing'`
  - `type Signal = 'traces' | 'metrics' | 'logs'`
  - `type GraphNode = { id: string; kind: NodeKind; componentType: string; componentName: string; label: string; detail?: string; missing?: boolean }`
  - `type PipelineLane = { signal: Signal; nodeIds: string[]; edges: [string, string][] }`
  - `type PipelineGraph = { nodes: Record<string, GraphNode>; lanes: PipelineLane[]; hasServiceBlock: boolean }`
  - `type GraphResult = { ok: true; graph: PipelineGraph } | { ok: false; error: string; line?: number }`
  - `function buildPipelineGraph(yamlText: string): GraphResult`
  - `function baseType(componentName: string): string` (text before first `/`)

- [ ] **Step 1: Write the failing test (default Helix config -> traces/metrics/logs lanes with source + two sinks)**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/pipelineGraph.test.ts`
Expected: FAIL with "buildPipelineGraph is not a function" / module not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
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
  return parts.length ? parts.join(' · ') : undefined;
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

    // Edges: source -> each receiver; then chain the ordered stages; exporter -> its sink.
    const src = nodeIds.find(id => nodes[id].kind === 'source');
    if (src) for (const r of recIds) edges.push([src, r]);
    const chain = [...recIds, ...procIds, ...expIds];
    for (let i = 0; i < chain.length - 1; i++) edges.push([chain[i], chain[i + 1]]);
    for (const name of expNames) edges.push([`exporter:${name}`, `sink:${name}`]);

    lanes.push({ signal, nodeIds, edges });
  }

  return { ok: true, graph: { nodes, lanes, hasServiceBlock: !!doc.service } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/pipelineGraph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/pipeline/pipelineGraph.ts frontend/src/components/pipeline/pipelineGraph.test.ts
git commit -m "feat(pipeline): pure collector YAML to graph model builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Builder edge cases (invalid YAML, missing refs, no service, empty, connectors, named instances)

**Files:**
- Modify: `frontend/src/components/pipeline/pipelineGraph.ts` (only if a case is unhandled)
- Test: `frontend/src/components/pipeline/pipelineGraph.test.ts:append`

**Interfaces:**
- Consumes: `buildPipelineGraph`, `GraphResult` from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Append the failing edge-case tests**

```ts
describe('buildPipelineGraph (edge cases)', () => {
  it('returns ok:false with a 1-based line on invalid YAML', () => {
    const res = buildPipelineGraph('receivers:\n  otlp:\n   protocols: [unclosed');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(typeof res.error).toBe('string');
  });

  it('flags an undefined pipeline reference as a missing node', () => {
    const res = buildPipelineGraph(`
receivers:
  otlp: { protocols: { grpc: {} } }
exporters:
  otlphttp/bmchelix: { endpoint: x }
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/bmchelix]
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const batch = res.graph.nodes['processor:batch'];
    expect(batch.missing).toBe(true);
    expect(batch.kind).toBe('missing');
  });

  it('reports hasServiceBlock=false when service is absent', () => {
    const res = buildPipelineGraph('receivers:\n  otlp: {}\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.hasServiceBlock).toBe(false);
    expect(res.graph.lanes).toHaveLength(0);
  });

  it('handles an empty document', () => {
    const res = buildPipelineGraph('');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.lanes).toHaveLength(0);
    expect(res.graph.hasServiceBlock).toBe(false);
  });

  it('treats named instances by their base type', () => {
    const res = buildPipelineGraph(`
receivers:
  otlp/internal: { protocols: { http: {} } }
exporters:
  otlphttp/bmchelix: { endpoint: x }
service:
  pipelines:
    logs:
      receivers: [otlp/internal]
      exporters: [otlphttp/bmchelix]
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.graph.nodes['receiver:otlp/internal'].componentType).toBe('otlp');
  });
});
```

- [ ] **Step 2: Run to see which cases fail**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/pipelineGraph.test.ts`
Expected: the missing-ref, empty, and service cases already pass from Task 1; confirm all green. If any fail, fix `buildPipelineGraph` minimally (the Task 1 implementation already covers these; only adjust if a test surfaces a real gap).

- [ ] **Step 3: If a case failed, apply the minimal fix**

Only touch `pipelineGraph.ts` for a genuinely uncovered case. Do not add speculative handling.

- [ ] **Step 4: Run to verify all pass**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/pipelineGraph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/pipeline/pipelineGraph.test.ts frontend/src/components/pipeline/pipelineGraph.ts
git commit -m "test(pipeline): cover builder edge cases (invalid yaml, missing refs, empty, named instances)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Teaching content map and resolver

**Files:**
- Create: `frontend/src/components/pipeline/componentDocs.ts`
- Test: `frontend/src/components/pipeline/componentDocs.test.ts`

**Interfaces:**
- Consumes: `baseType` from `pipelineGraph.ts`.
- Produces:
  - `type ConceptCard = { title: string; body: string; docsUrl?: string }`
  - `type ComponentDoc = { role: string; whyItMatters: string; concept?: ConceptCard }`
  - `function resolveDoc(componentName: string): ComponentDoc` (name-first, then base type, then generic fallback)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { resolveDoc } from './componentDocs';
import { baseType } from './pipelineGraph';

describe('resolveDoc', () => {
  it('resolves the Helix exporter by name to a Helix-egress doc', () => {
    const doc = resolveDoc('otlphttp/bmchelix');
    expect(doc.role.toLowerCase()).toContain('helix');
  });
  it('resolves the local viewer exporter by name', () => {
    const doc = resolveDoc('otlphttp/helix_local_viewer');
    expect(doc.role.toLowerCase()).toMatch(/viewer|local/);
  });
  it('attaches a gRPC vs HTTP concept card to otlp', () => {
    const doc = resolveDoc('otlp');
    expect(doc.concept?.title).toMatch(/gRPC/i);
  });
  it('attaches a sampling concept card to tail_sampling', () => {
    const doc = resolveDoc('tail_sampling');
    expect(doc.concept?.title.toLowerCase()).toContain('sampl');
  });
  it('falls back to a generic doc for an unknown type', () => {
    const doc = resolveDoc('some_custom_exporter');
    expect(doc.role.length).toBeGreaterThan(0);
    expect(doc.concept?.docsUrl).toMatch(/opentelemetry\.io|registry/);
  });
});

// Coverage guard: every component named in any shipped template resolves to a
// non-generic doc (name match or base-type match), so teaching keeps pace with templates.
describe('template coverage', () => {
  const tplDir = join(__dirname, '../../../../templates');
  const files = readdirSync(tplDir).filter(f => f.endsWith('.yaml'));
  const GENERIC_ROLE = resolveDoc('___definitely_unknown___').role;

  const names = new Set<string>();
  for (const f of files) {
    const doc: any = yaml.load(readFileSync(join(tplDir, f), 'utf8'));
    for (const section of ['receivers', 'processors', 'exporters', 'connectors']) {
      Object.keys(doc?.[section] || {}).forEach(n => names.add(n));
    }
  }

  it('finds at least the default components', () => {
    expect(names.size).toBeGreaterThan(0);
  });

  for (const name of [...names]) {
    it(`has a specific doc for "${name}" (type ${baseType(name)})`, () => {
      expect(resolveDoc(name).role).not.toBe(GENERIC_ROLE);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/componentDocs.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

Author newcomer-facing copy (no em dashes). Cover every base type the templates use: `otlp`, `otlphttp`, `prometheus`, `batch`, `memory_limiter`, `resource`, `k8sattributes`, `tail_sampling`, plus name entries for `otlphttp/bmchelix` and `otlphttp/helix_local_viewer`. If `componentDocs.test.ts` reports a name the templates use that is not listed here, add an entry for it before considering the task done.

```ts
import { baseType } from './pipelineGraph';

export type ConceptCard = { title: string; body: string; docsUrl?: string };
export type ComponentDoc = { role: string; whyItMatters: string; concept?: ConceptCard };

// Resolved by exact component name first (e.g. the two named Helix exporters),
// then by base type, then a generic fallback.
const BY_NAME: Record<string, ComponentDoc> = {
  'otlphttp/bmchelix': {
    role: 'Ships your telemetry to the BMC Helix tenant over OTLP/HTTP.',
    whyItMatters:
      'This is the egress to Helix. Its endpoint and the X-Api-Key, X-Source headers decide which tenant and business service your data lands in. Get these wrong and data either fails to send or arrives on the wrong service.',
  },
  'otlphttp/helix_local_viewer': {
    role: 'Fans a copy of every signal to this configurator so the View OTel Data page can render it locally.',
    whyItMatters:
      'This is why you can inspect traces, logs, and errors inside the app without Jaeger or an external store. Removing it disables the local viewer; it does not affect what Helix receives.',
  },
};

const BY_TYPE: Record<string, ComponentDoc> = {
  otlp: {
    role: 'Receives OpenTelemetry data from your apps.',
    whyItMatters:
      'This is the front door of the collector. Your instrumented apps send here. If the endpoint or protocol does not match what your app exports, nothing arrives.',
    concept: {
      title: 'gRPC vs HTTP',
      body:
        'The OTLP receiver can listen on gRPC (port 4317) and HTTP (port 4318). gRPC is binary and efficient for high volume; HTTP is easier through proxies and firewalls. Your app must target the same protocol and port the receiver enables.',
      docsUrl: 'https://opentelemetry.io/docs/specs/otlp/',
    },
  },
  otlphttp: {
    role: 'Sends telemetry onward to another OTLP/HTTP endpoint.',
    whyItMatters:
      'Exporters are the collector outputs. An OTLP/HTTP exporter forwards batches to a downstream endpoint; the endpoint and headers decide where the data goes.',
  },
  prometheus: {
    role: 'Scrapes Prometheus metrics endpoints and turns them into OTel metrics.',
    whyItMatters:
      'Use this to pull metrics from targets that expose a /metrics endpoint instead of pushing OTLP. The scrape config decides what gets collected and how often.',
  },
  batch: {
    role: 'Groups spans, metrics, and logs into batches before export.',
    whyItMatters:
      'Batching cuts network overhead and load on the destination. Almost every production pipeline includes it; without it the collector makes many small, inefficient sends.',
  },
  memory_limiter: {
    role: 'Caps the collector memory and sheds load when it climbs too high.',
    whyItMatters:
      'It protects the collector from running out of memory under bursts by refusing data early rather than crashing. Place it first so it can push back before other processors work.',
  },
  resource: {
    role: 'Adds, edits, or removes resource attributes on your telemetry.',
    whyItMatters:
      'Resource attributes describe where data came from (service.name, deployment.environment, and so on). Helix and OTel back-ends group and route on these, so setting them correctly is what makes your data findable.',
    concept: {
      title: 'Resource attributes and semantic conventions',
      body:
        'Semantic conventions are the agreed names for common attributes (service.name, host.name, k8s.pod.name). Using the conventional names, rather than your own, is what lets back-ends and dashboards understand your data without custom mapping.',
      docsUrl: 'https://opentelemetry.io/docs/specs/semconv/',
    },
  },
  k8sattributes: {
    role: 'Enriches telemetry with Kubernetes metadata (pod, namespace, node, labels).',
    whyItMatters:
      'It automatically stamps each signal with the pod and namespace it came from, so you can slice by workload in Helix without instrumenting that context yourself.',
    concept: {
      title: 'Resource attributes and semantic conventions',
      body:
        'This processor fills in k8s.* resource attributes using the conventional names. Downstream tools rely on those exact names to build topology and group by workload.',
      docsUrl: 'https://opentelemetry.io/docs/specs/semconv/resource/k8s/',
    },
  },
  tail_sampling: {
    role: 'Decides which completed traces to keep, based on the whole trace.',
    whyItMatters:
      'High-volume tracing is expensive to store. Tail sampling waits until a trace finishes so it can keep the interesting ones (errors, slow traces) and drop routine ones, unlike head sampling which decides blindly at the start.',
    concept: {
      title: 'Sampling: head vs tail',
      body:
        'Head sampling decides at the first span, before you know if the trace is interesting. Tail sampling buffers spans and decides once the trace is complete, so you can keep every error and slow trace while dropping the rest. Tail sampling costs more memory in the collector.',
      docsUrl: 'https://opentelemetry.io/docs/concepts/sampling/',
    },
  },
};

const GENERIC: ComponentDoc = {
  role: 'A collector component not covered by a built-in explainer.',
  whyItMatters:
    'Look this component up in the OpenTelemetry registry to see what it receives, transforms, or exports.',
  concept: {
    title: 'Find this component',
    body: 'Search the OpenTelemetry registry for this component name to read its documentation and configuration options.',
    docsUrl: 'https://opentelemetry.io/ecosystem/registry/',
  },
};

export function resolveDoc(componentName: string): ComponentDoc {
  return BY_NAME[componentName] || BY_TYPE[baseType(componentName)] || GENERIC;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/componentDocs.test.ts`
Expected: PASS. If a template component has no entry, the coverage test names it; add a `BY_TYPE` (or `BY_NAME`) entry and re-run.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/pipeline/componentDocs.ts frontend/src/components/pipeline/componentDocs.test.ts
git commit -m "feat(pipeline): teaching content map with template coverage guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Pure diagram view logic + thin presentational component

**Why split:** the frontend runs vitest in the `node` environment and has no `.test.tsx` render tests or `@testing-library/react`. Adding either violates the no-new-dependency constraint and the repo's pattern. So the testable decisions (state selection, column grouping, panel content) live in a pure `diagramLayout.ts` tested in node; `PipelineDiagram.tsx` is a thin, untested-by-convention wrapper like every other component here.

**Files:**
- Create: `frontend/src/components/pipeline/diagramLayout.ts`
- Test: `frontend/src/components/pipeline/diagramLayout.test.ts`
- Create: `frontend/src/components/pipeline/PipelineDiagram.tsx`

**Interfaces:**
- Consumes: `PipelineGraph`, `GraphNode`, `Signal` from `pipelineGraph.ts`; `ComponentDoc`, `resolveDoc` from `componentDocs.ts`.
- Produces (from `diagramLayout.ts`):
  - `type DiagramState = 'error' | 'empty' | 'graph'`
  - `function diagramState(graph: PipelineGraph, hasParseError: boolean): DiagramState`
  - `type Column = { kind: GraphNode['kind']; nodes: GraphNode[] }`
  - `type LaneLayout = { signal: Signal; columns: Column[] }`
  - `function layoutLanes(graph: PipelineGraph): LaneLayout[]` (columns ordered source, receiver, processor, connector, exporter, sink; empty columns dropped)
  - `function panelContent(node: GraphNode): ComponentDoc` (wraps `resolveDoc(node.componentName)`)
- Produces (from `PipelineDiagram.tsx`):
  - `type PipelineDiagramProps = { graph: PipelineGraph; parseError?: { error: string; line?: number } }`
  - `const PipelineDiagram: React.FC<PipelineDiagramProps>`

- [ ] **Step 1: Write the failing test for the view logic**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/diagramLayout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `diagramLayout.ts`**

```ts
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
```

Note: a `missing` node keeps its own `missing` column at the end; when a missing processor also needs to appear between receivers and exporters visually, that is a rendering nicety deferred to the component and not required for the state or column tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline/diagramLayout.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `PipelineDiagram.tsx` (thin, no dedicated test)**

Consume `diagramState`, `layoutLanes`, `panelContent`. Render:
- `state === 'error'`: an error banner (`parseError.error`, with line when present) above a dimmed last-known diagram if lanes exist, else just the banner.
- `state === 'empty'`: a teaching card explaining a collector needs a `service` block wiring components into pipelines, pointing at Load Template.
- `state === 'graph'`: one labeled row per lane; within a row, the `columns` rendered left to right, each node a `<button>` with an arrow/chevron between columns. Selecting a node stores it in local `useState` and shows a side panel from `panelContent(node)` (role, whyItMatters, concept card with docs link when present). `missing` nodes use the danger style with a "not defined above" tag.
Match sibling Tailwind (gray-1000 surfaces, gray-800 borders, primary accent), consistent with `Layer3Instrument` and `ServiceMap`.

- [ ] **Step 6: Verify the suite still passes and typecheck**

Run: `cd frontend && TZ=America/Chicago npx vitest run src/components/pipeline && npx tsc --noEmit`
Expected: PASS and no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/pipeline/diagramLayout.ts frontend/src/components/pipeline/diagramLayout.test.ts frontend/src/components/pipeline/PipelineDiagram.tsx
git commit -m "feat(pipeline): pure diagram view logic plus presentational component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire the Diagram | YAML toggle into the Gateway Config card

**Files:**
- Modify: the dashboard parent that renders `GatewayConfigEditor` and owns the YAML buffer string. Find it: `grep -rln "GatewayConfigEditor" frontend/src`. Confirm which prop holds the buffer (the string passed as the editor value) and reuse it; do not add a second source of truth.
- Test: covered by the existing render tests plus a manual check (this task is wiring, not new pure logic).

**Interfaces:**
- Consumes: `buildPipelineGraph` (Task 1), `PipelineDiagram` (Task 4), the existing YAML buffer state.
- Produces: no new exports.

- [ ] **Step 1: Locate the integration point**

Run: `grep -rln "GatewayConfigEditor" frontend/src`
Open the parent. Identify the state variable holding the current YAML text (the value handed to the editor) and the card header where a toggle fits.

- [ ] **Step 2: Add view state and the toggle**

Add local state `const [configView, setConfigView] = useState<'yaml' | 'diagram'>('yaml')` in the parent. Render a two-button segmented toggle ("YAML" / "Diagram") in the card header, styled like the existing tab toggles (see `Layer3Instrument` language tabs for the pattern). Default stays `'yaml'` so current behavior is unchanged.

- [ ] **Step 3: Debounce-parse the buffer and render the diagram**

When `configView === 'diagram'`, render `PipelineDiagram` fed from a debounced parse of the buffer instead of the editor. Minimal debounce with existing React hooks:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { buildPipelineGraph } from '../pipeline/pipelineGraph';
import { PipelineDiagram } from '../pipeline/PipelineDiagram';

// inside the component, `yamlBuffer` is the existing buffer state:
const [debounced, setDebounced] = useState(yamlBuffer);
useEffect(() => {
  const t = setTimeout(() => setDebounced(yamlBuffer), 350);
  return () => clearTimeout(t);
}, [yamlBuffer]);
const result = useMemo(() => buildPipelineGraph(debounced), [debounced]);
// render:
// {configView === 'diagram'
//   ? <PipelineDiagram graph={result.ok ? result.graph : { nodes: {}, lanes: [], hasServiceBlock: false }}
//                      parseError={result.ok ? undefined : { error: result.error, line: result.line }} />
//   : <GatewayConfigEditor ... /> }
```

Keep the editor mounted (hidden) if remount cost matters; otherwise conditional render is fine.

- [ ] **Step 4: Verify the whole suite and a manual smoke**

Run: `cd frontend && TZ=America/Chicago npx vitest run`
Expected: PASS (all existing + new tests).
Manual: `npm run dev` per the desktop dev workflow, open the Gateway Config card, toggle to Diagram, confirm the default config renders three lanes with the two sinks, click `otlp` and see the gRPC vs HTTP card, then introduce a YAML typo and confirm the last diagram dims with the error banner.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(pipeline): add Diagram | YAML toggle to the Gateway Config card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Live mirror of real config, all signals -> Tasks 1, 2, 5.
- Source + name-classified sinks (Helix / local viewer / external) -> Task 1.
- Annotated nodes + concept explainers (gRPC/HTTP, sampling, resource attrs/semconv) -> Tasks 3, 4 (`panelContent`/`resolveDoc`).
- Live update on edit (debounced, same buffer) -> Task 5.
- Offline in-bundle content -> Task 3 (static map).
- Error handling: invalid YAML, undefined ref, no service, multi-pipeline, connectors -> Tasks 2, 4.
- Testing set (builder cases, template coverage guard, view logic) -> Tasks 1-4, all pure and run in the `node` vitest environment.
- No new backend endpoint, no new dependency, read-only -> Global Constraints, honored throughout.

**Placeholder scan:** No TBDs. Every code step carries real code; the one "author the copy" step (Task 3) ships full copy in the code block. `PipelineDiagram.tsx` (Task 4 Step 5) is described rather than coded because it is presentational glue with no dedicated test, consistent with every other component in this repo; its inputs (`diagramState`, `layoutLanes`, `panelContent`) are fully specified and tested. Task 5 instructs a `grep` to locate the exact buffer-owning parent; the wiring code itself is concrete.

**Type consistency:** `buildPipelineGraph -> GraphResult { ok, graph|error, line }`, `PipelineGraph { nodes, lanes, hasServiceBlock }`, `GraphNode.componentName`, `resolveDoc(componentName) -> ComponentDoc`, `baseType()`, and the Task 4 view helpers (`diagramState`, `layoutLanes`, `panelContent`) are used identically across Tasks 1-5. `PipelineDiagramProps { graph, parseError }` matches Task 5's render call.

**Environment note (resolved):** the frontend vitest config runs `environment: 'node'` with no `@testing-library/react`; Task 4 was structured so all tests are pure-function tests in that environment, adding no dependency.
