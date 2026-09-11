# Interactive Collector Pipeline Visualizer

> **Spec** · Created 2026-09-10 · Status: **Draft**
> Branch/worktree: `brainstorm/otel-education` (off `brainstorm/electron-app`).
> First of four sub-projects in the "OTel education layer" initiative. The others
> (why-this-matters retrofit, Go language guide, desktop-native aha moments) get
> their own specs.

## 0. Summary

The configurator already lets a user edit the gateway collector config in a Monaco
YAML editor, validates it on save, and streams the resulting telemetry into a local
APM-style viewer. What it does not do is *explain* the config. A newcomer to
OpenTelemetry looking at `helix-otel-collector.yaml` cannot tell what a receiver,
processor, or exporter is, why `batch` is there, or how a span travels from their app
to their BMC Helix tenant.

This spec adds a **read-only pipeline visualizer**: a live diagram of the user's own
collector config in which every node is an annotated teaching surface. It renders the
real `receivers` / `processors` / `exporters` and the `service.pipelines` wiring, plus
a "Your apps" source node and a "BMC Helix tenant" sink node, so the single diagram
also shows the app-to-collector-to-Helix data flow. Concept explanations (receiver /
processor / exporter roles, gRPC vs HTTP, sampling, resource attributes, semantic
conventions) are anchored to the nodes the user's config actually uses, which keeps the
teaching concrete rather than generic.

**Guiding principle: teach through the user's own config, not through an abstract
model.** Where a choice trades breadth for groundedness, we stay grounded.

## 1. Goals / Non-goals

**Goals**

- Render the user's actual collector pipeline (all signals: traces, metrics, logs) as
  a left-to-right flow: Apps -> Receivers -> Processors -> Exporters -> BMC Helix.
- Make every node an annotated teaching surface, with concept explainers anchored to
  real component types.
- Update live as the user edits the YAML in the existing Monaco editor.
- Ship all teaching content in-bundle so it works fully offline (a requirement the
  Electron desktop distribution cares about).
- Reuse the existing frontend `js-yaml` capability and the editor's existing buffer
  state. No new backend endpoint.
- Establish the "educational overlay" component pattern (a presentational unit that
  reads live app state and annotates it) that the later education sub-projects reuse.

**Non-goals**

- Editing the config from the diagram. Editing stays in Monaco (read-only visualizer).
- A separate, abstract "how collectors work in general" diagram disconnected from the
  user's config. Teaching happens through annotations on real nodes instead.
- A new graph or diagramming dependency. We hand-roll SVG/DOM like the existing
  `ServiceMap` / `TimelineChart` viz components.
- Special routing UI for OTel connectors. If a connector is present it renders as a
  plain node; richer connector semantics are out of scope.
- Any change to backend validation. Authoritative lint stays in `backend/validate.js`
  on the save path.

## 2. Architecture

Four isolated units. Each has one clear purpose and a well-defined interface.

### 2.1 `pipelineGraph.ts` (pure function)

**What it does:** turns collector YAML text into a normalized graph model, or a parse
error. No I/O.

```
buildPipelineGraph(yamlText: string): PipelineGraph | { error: string; line?: number }
```

`PipelineGraph` shape (illustrative):

```
type NodeKind = 'source' | 'receiver' | 'processor' | 'exporter' | 'connector' | 'sink' | 'missing';

type GraphNode = {
  id: string;            // e.g. 'receiver:otlp', 'processor:batch'
  kind: NodeKind;
  componentType: string; // 'otlp', 'batch', 'bmchelix', ... ; '' for pseudo-nodes
  label: string;         // display label
  detail?: string;       // e.g. otlp protocols "gRPC :4317 · HTTP :4318"; exporter endpoint host
  missing?: boolean;     // referenced by a pipeline but not defined
};

type Signal = 'traces' | 'metrics' | 'logs';

type PipelineLane = {
  signal: Signal;
  nodeIds: string[];     // ordered: source, receivers…, processors…, exporters…, sink
  edges: [string, string][];
};

type PipelineGraph = {
  nodes: Record<string, GraphNode>;
  lanes: PipelineLane[];
  hasServiceBlock: boolean;
};
```

**Derivation rules:**

- Parse with `js-yaml`. On throw, return `{ error, line }` using the thrown mark.
- Nodes come from the top-level `receivers` / `processors` / `exporters` / `connectors`
  maps. The component type is the key's base name before any `/` (e.g. `otlp/2` ->
  `otlp`).
- Lanes come from `service.pipelines.{traces,metrics,logs}`. A pipeline's `receivers`,
  `processors`, `exporters` arrays define the ordered node ids and the edges between
  consecutive stages.
- **Source pseudo-node** ("Your apps") is prepended to every lane whose receivers
  include `otlp`; its `detail` reflects which protocols the otlp receiver enables
  (gRPC `:4317`, HTTP `:4318`).
- **Sink classification is by exporter name, not base type.** The real Helix config
  uses `otlphttp/bmchelix` (Helix tenant egress) and `otlphttp/helix_local_viewer`
  (fan-out that feeds the local View OTel Data page); both share the base type
  `otlphttp`. An exporter whose name contains `bmchelix` gets a **"BMC Helix tenant"**
  sink appended to its lanes; one whose name contains `helix_local_viewer` gets a
  **"Local viewer (this app)"** sink. Any other exporter appends a generic
  **"External endpoint"** sink. `detail` is the exporter's `endpoint` host when present.
- **Missing nodes:** a pipeline referencing a component absent from the top-level map
  yields a `missing: true` node (mirrors `validateConfig`'s "undefined pipeline
  reference" finding, computed locally for positioning).

### 2.2 `componentDocs.ts` (static content map)

**What it does:** maps a component identity (exporter/receiver name, then base type) to
teaching content. Pure data, in-bundle. Base types covered by the shipped templates:
`otlp`, `otlphttp`, `prometheus`, `batch`, `memory_limiter`, `resource`,
`k8sattributes`, `tail_sampling`; plus name-based entries for `otlphttp/bmchelix` and
`otlphttp/helix_local_viewer`.

```
type ComponentDoc = {
  role: string;          // one line: what this component does
  whyItMatters: string;  // short paragraph
  concept?: ConceptCard; // optional deeper explainer
};
```

Anchoring of the concept explainers the initiative calls for:

- `otlp` -> **gRPC vs HTTP** (ports 4317 / 4318, when each is used).
- `tail_sampling`, `probabilistic_sampler` -> **sampling** (head vs tail, why sampling
  exists).
- `resource`, `k8sattributes` -> **resource attributes and semantic conventions**.
- `batch`, `memory_limiter` -> role and why-it-matters (no deep card needed).
- `prometheus` (receiver) -> role and why-it-matters.
- `otlphttp` / `otlp` (exporter) -> what an OTLP exporter ships and where.

Docs resolve by exporter/receiver **name first, then base type**: `otlphttp/bmchelix`
resolves to a Helix-egress doc ("what it sends and to which tenant"),
`otlphttp/helix_local_viewer` to a doc explaining the local fan-out that powers View
OTel Data, and anything else falls back to the base-type doc. Unknown base types fall
back to a generic "custom component" doc plus a link to the OpenTelemetry registry. The
content is authored for a newcomer, not a reference.

### 2.3 `PipelineDiagram.tsx` (presentational)

**What it does:** renders a `PipelineGraph` and opens an annotation panel on node
click. No parsing, no state beyond the selected node.

- Hand-rolled SVG/DOM, styled to match existing viz components. No new dependency.
- One horizontal lane per present signal, stacked. Columns within a lane: Apps |
  Receivers | Processors | Exporters | Helix.
- A component shared across signals (e.g. `batch` in all three pipelines) is drawn
  once per lane rather than as a shared node, to keep edges readable.
- `missing` nodes render in the danger style with a "not defined above" tag.
- Clicking a node opens a side panel showing its `ComponentDoc` (role, why it matters,
  concept card when present).

### 2.4 Integration into the Gateway Config card

- Add a "Diagram | YAML" view toggle to the existing Gateway Config card that hosts
  `GatewayConfigEditor`. Default remains the YAML editor.
- The diagram reads the **same buffer state** the editor already holds in the dashboard
  (no second source of truth) and re-runs `buildPipelineGraph` debounced (~350 ms) on
  change.

## 3. Data flow

```
Monaco buffer (existing dashboard state)
  -> debounce ~350ms
  -> buildPipelineGraph(buffer)
  -> PipelineDiagram(graph)
  -> node click -> annotation panel (componentDocs[type])
```

No network request. `GET /api/config` still provides the initial buffer on load exactly
as today.

## 4. Error and edge handling

- **Invalid YAML:** keep the last successfully parsed diagram rendered but dimmed, and
  show the parse error (line-referenced) above it, matching the editor's own behavior.
  Never blank the pane on a transient keystroke.
- **Undefined pipeline reference:** render the referenced component as a `missing`
  ghost node in danger style rather than dropping it silently.
- **No `service.pipelines`:** render an empty-state teaching card explaining that a
  collector needs a `service` block to wire components into pipelines, with a pointer
  to Load Template.
- **Multiple pipelines:** stacked lanes, one per signal present.
- **Connectors present:** render as plain nodes; no special routing.

## 5. Testing

- `pipelineGraph.test.ts`: default Helix config; multi-signal config; a config with an
  undefined pipeline reference; a config with no `service` block; an empty document;
  a config using a connector; a config with a named component (`otlp/2`).
- `componentDocs.test.ts`: every component type referenced by any file in `templates/`
  has a `componentDocs` entry (guards against silent teaching gaps as templates grow).
- `PipelineDiagram` render test against a fixed `PipelineGraph`: expected nodes present,
  a `missing` node styled as danger, node click opens the annotation panel.
- All existing frontend and backend tests stay unchanged and green.

## 6. Desktop / Electron fit

The visualizer needs no native API in this phase, so it works identically in the
browser, native-zip, Docker, and Electron distributions. Two things make it a good
fit for the desktop app specifically: all teaching content ships in-bundle (offline),
and it establishes the educational-overlay component pattern the desktop-native
sub-project (first-span notification, native Save of snippets) will build on.

## 7. Phasing (this sub-project)

1. `pipelineGraph.ts` plus its tests (pure, no UI).
2. `componentDocs.ts` plus its coverage test.
3. `PipelineDiagram.tsx` render against a fixed model.
4. Wire the "Diagram | YAML" toggle into the Gateway Config card against the live
   buffer.

## 8. Open questions

- None blocking. Whether the annotation surface is a side panel or an inline popover is
  a visual detail to settle during implementation; both consume the same
  `componentDocs` data.
