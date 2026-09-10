import React, { useState } from 'react';
import { AlertTriangle, ArrowRight, ExternalLink } from 'lucide-react';
import type { PipelineGraph, GraphNode } from './pipelineGraph';
import { diagramState, layoutLanes, panelContent } from './diagramLayout';

export type PipelineDiagramProps = {
  graph: PipelineGraph;
  parseError?: { error: string; line?: number };
};

const SIGNAL_LABEL: Record<string, string> = {
  traces: 'Traces',
  metrics: 'Metrics',
  logs: 'Logs',
};

const NodeButton: React.FC<{
  node: GraphNode;
  isSelected: boolean;
  onSelect: (node: GraphNode) => void;
}> = ({ node, isSelected, onSelect }) => {
  const isMissing = node.kind === 'missing';
  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded border text-left transition-colors min-w-[140px] ${
        isMissing
          ? 'border-danger/40 bg-danger/10 text-danger-text hover:bg-danger/20'
          : isSelected
            ? 'border-primary bg-primary/10 text-gray-100'
            : 'border-gray-800 bg-gray-1000 text-gray-200 hover:bg-gray-800'
      }`}
    >
      <span className="text-tiny font-semibold">{node.label}</span>
      {isMissing && (
        <span className="text-[10px] uppercase tracking-wider text-danger-text">not defined above</span>
      )}
      {!isMissing && node.detail && (
        <span className="text-[10px] text-gray-500">{node.detail}</span>
      )}
    </button>
  );
};

const PanelBody: React.FC<{ node: GraphNode }> = ({ node }) => {
  const doc = panelContent(node);
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-1000 p-4">
      <div className="text-tiny uppercase tracking-wider text-blue-300 mb-1 font-semibold">
        {node.label}
      </div>
      <p className="text-sm text-gray-300 mb-3 leading-relaxed">{doc.role}</p>
      <p className="text-sm text-gray-400 mb-3 leading-relaxed">{doc.whyItMatters}</p>
      {doc.concept && (
        <div className="mt-3 pt-3 border-t border-gray-800">
          <div className="text-tiny font-semibold text-gray-300 mb-1">{doc.concept.title}</div>
          <p className="text-tiny text-gray-500 leading-relaxed mb-2">{doc.concept.body}</p>
          {doc.concept.docsUrl && (
            <a
              href={doc.concept.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-tiny text-link hover:underline"
            >
              Read the docs <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
};

const EmptyState: React.FC = () => (
  <div className="rounded-lg border border-gray-800 bg-gray-1000 p-6">
    <div className="text-tiny uppercase tracking-wider text-blue-300 mb-1 font-semibold">
      No pipeline yet
    </div>
    <p className="text-base text-gray-300 leading-relaxed mb-2">
      A collector needs a <code className="font-mono text-gray-200">service</code> block that wires
      receivers, processors, and exporters into pipelines before there is anything to diagram here.
    </p>
    <p className="text-sm text-gray-500 leading-relaxed">
      Use <span className="text-gray-300">Load Template</span> in the YAML editor to start from a
      working pipeline.
    </p>
  </div>
);

const ErrorBanner: React.FC<{ parseError: { error: string; line?: number } }> = ({ parseError }) => (
  <div className="flex items-start gap-3 p-3 rounded border border-danger/40 bg-danger/10 text-tiny text-danger-text" role="alert">
    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
    <span>
      {parseError.error}
      {parseError.line != null && <span className="text-gray-500"> (line {parseError.line})</span>}
    </span>
  </div>
);

export const PipelineDiagram: React.FC<PipelineDiagramProps> = ({ graph, parseError }) => {
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const state = diagramState(graph, !!parseError);
  const lanes = layoutLanes(graph);

  if (state === 'error') {
    return (
      <div className="flex flex-col gap-3">
        <ErrorBanner parseError={parseError!} />
        {lanes.length > 0 && (
          <div className="opacity-40 pointer-events-none">
            <LaneRows lanes={lanes} selected={selected} onSelect={setSelected} />
          </div>
        )}
      </div>
    );
  }

  if (state === 'empty') {
    return <EmptyState />;
  }

  return (
    <div className="flex gap-6">
      <div className="flex-1 min-w-0">
        <LaneRows lanes={lanes} selected={selected} onSelect={setSelected} />
      </div>
      {selected && (
        <div className="w-72 flex-shrink-0">
          <PanelBody node={selected} />
        </div>
      )}
    </div>
  );
};

const LaneRows: React.FC<{
  lanes: ReturnType<typeof layoutLanes>;
  selected: GraphNode | null;
  onSelect: (node: GraphNode) => void;
}> = ({ lanes, selected, onSelect }) => (
  <div className="flex flex-col gap-5">
    {lanes.map(lane => (
      <div key={lane.signal} className="rounded-lg border border-gray-800 bg-gray-1000 p-4">
        <div className="text-tiny uppercase tracking-wider text-gray-500 mb-3 font-semibold">
          {SIGNAL_LABEL[lane.signal] || lane.signal}
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          {lane.columns.map((column, colIdx) => (
            <React.Fragment key={`${column.kind}-${colIdx}`}>
              {colIdx > 0 && <ArrowRight className="w-4 h-4 text-gray-600 flex-shrink-0" aria-hidden="true" />}
              <div className="flex flex-col gap-1.5">
                {column.nodes.map(node => (
                  <NodeButton
                    key={node.id}
                    node={node}
                    isSelected={selected?.id === node.id}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    ))}
  </div>
);
