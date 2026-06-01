import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';

export type ServiceMapData = {
  windowMs: { start: number; end: number };
  nodes: Array<{
    name: string;
    traceCount: number;
    errorCount: number;
    errorRate: number;
    avgMs: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    callCount: number;
    errorCount: number;
    errorRate: number;
    avgMs: number;
  }>;
};

type Props = {
  data: ServiceMapData;
  height?: number;
  /** Click a node → jump to Traces filtered by this service. */
  onNodeClick?: (serviceName: string) => void;
};

const NODE_W = 168;
const NODE_H = 44;
const Y_GAP = 16;

// Compute a layered DAG layout. Rank = longest distance from a root node (one
// with no incoming edges). Nodes at the same rank are stacked vertically and
// centered around the chart's mid-Y. Stable: same input shape always
// produces the same layout, so polling doesn't reshuffle the graph.
const layout = (data: ServiceMapData, width: number) => {
  const nodes = data.nodes;
  const edges = data.edges;
  const nameToIdx = new Map(nodes.map((n, i) => [n.name, i]));
  const indeg = new Map(nodes.map(n => [n.name, 0]));
  const outAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (!nameToIdx.has(e.source) || !nameToIdx.has(e.target)) continue;
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
    if (!outAdj.has(e.source)) outAdj.set(e.source, []);
    outAdj.get(e.source)!.push(e.target);
  }
  // Rank = longest path from any root (indeg=0 node). Iterative relaxation
  // for at most |nodes| rounds to settle. Cycle-tolerant — cyclic nodes
  // converge to a stable rank without crashing.
  const rank = new Map(nodes.map(n => [n.name, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const r = (rank.get(e.source) || 0) + 1;
      if (r > (rank.get(e.target) || 0)) {
        rank.set(e.target, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Group by rank.
  const byRank = new Map<number, string[]>();
  for (const n of nodes) {
    const r = rank.get(n.name) || 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n.name);
  }
  // Sort each rank's nodes deterministically (by trace count desc, then name).
  for (const [, group] of byRank) {
    group.sort((a, b) => {
      const ai = nameToIdx.get(a)!;
      const bi = nameToIdx.get(b)!;
      return nodes[bi].traceCount - nodes[ai].traceCount || a.localeCompare(b);
    });
  }
  const ranks = Array.from(byRank.keys()).sort((a, b) => a - b);
  const totalRanks = Math.max(1, ranks.length);
  // Compute height needed.
  const maxColCount = Math.max(1, ...Array.from(byRank.values()).map(g => g.length));
  const heightUsed = maxColCount * NODE_H + (maxColCount - 1) * Y_GAP;
  const cx = (i: number, count: number) => {
    // Distribute ranks horizontally with equal margins.
    const usableW = Math.max(NODE_W, width - 40);
    const slotW = totalRanks > 1 ? (usableW - NODE_W) / (totalRanks - 1) : 0;
    return 20 + i * slotW + NODE_W / 2;
  };
  const positions = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < ranks.length; i++) {
    const group = byRank.get(ranks[i])!;
    const colHeight = group.length * NODE_H + (group.length - 1) * Y_GAP;
    const startY = (heightUsed - colHeight) / 2;
    for (let j = 0; j < group.length; j++) {
      positions.set(group[j], {
        x: cx(i, totalRanks) - NODE_W / 2,
        y: startY + j * (NODE_H + Y_GAP),
      });
    }
  }
  return { positions, heightUsed: Math.max(heightUsed, NODE_H + 8) };
};

const nodeBorderTone = (errorRate: number) =>
  errorRate >= 0.05 ? '#b2001e'
  : errorRate >= 0.001 ? '#d9ae00'
  : '#393b46';

const formatDuration = (ms: number) =>
  ms < 1 ? `${ms.toFixed(2)} ms`
  : ms < 1000 ? `${Math.round(ms)} ms`
  : `${(ms / 1000).toFixed(2)} s`;

export const ServiceMap: React.FC<Props> = ({ data, height: heightProp, onNodeClick }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setWidth(Math.floor(cw));
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { positions, heightUsed } = useMemo(() => layout(data, width), [data, width]);
  const height = Math.max(120, heightProp ?? heightUsed + 24);

  if (data.nodes.length === 0) {
    return (
      <div className="text-tiny text-gray-500 py-3 text-center">
        No service-to-service calls in this window.
      </div>
    );
  }

  // Edge dimensions used for visual weight.
  const maxCallCount = Math.max(1, ...data.edges.map(e => e.callCount));

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <svg width={width} height={height} className="block">
        {/* Edges first, so they sit beneath nodes */}
        {data.edges.map((e, i) => {
          const sp = positions.get(e.source);
          const tp = positions.get(e.target);
          if (!sp || !tp) return null;
          const sx = sp.x + NODE_W;
          const sy = sp.y + NODE_H / 2;
          const tx = tp.x;
          const ty = tp.y + NODE_H / 2;
          // Bezier control points for a smooth left-to-right edge.
          const cx1 = sx + Math.max(20, (tx - sx) * 0.4);
          const cx2 = tx - Math.max(20, (tx - sx) * 0.4);
          const path = `M ${sx} ${sy} C ${cx1} ${sy}, ${cx2} ${ty}, ${tx} ${ty}`;
          const isHover = hoverEdge === `${e.source}|${e.target}`;
          const strokeColor = e.errorRate >= 0.05 ? '#b2001e' : e.errorRate >= 0.001 ? '#d9ae00' : '#555868';
          const strokeWidth = Math.max(1, 1 + (e.callCount / maxCallCount) * 2.5);
          return (
            <path
              key={i}
              d={path}
              fill="none"
              stroke={strokeColor}
              strokeOpacity={isHover ? 1 : 0.65}
              strokeWidth={isHover ? strokeWidth + 1 : strokeWidth}
              onMouseEnter={() => setHoverEdge(`${e.source}|${e.target}`)}
              onMouseLeave={() => setHoverEdge(null)}
              style={{ cursor: 'default' }}
            />
          );
        })}

        {/* Nodes */}
        {data.nodes.map(n => {
          const p = positions.get(n.name);
          if (!p) return null;
          const isHover = hoverNode === n.name;
          const isClickable = !!onNodeClick;
          return (
            <g
              key={n.name}
              transform={`translate(${p.x}, ${p.y})`}
              onMouseEnter={() => setHoverNode(n.name)}
              onMouseLeave={() => setHoverNode(null)}
              onClick={() => onNodeClick && onNodeClick(n.name)}
              style={{ cursor: isClickable ? 'pointer' : 'default' }}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={4}
                ry={4}
                fill="#1c1d22"
                stroke={nodeBorderTone(n.errorRate)}
                strokeWidth={isHover ? 2 : 1}
              />
              <text
                x={10}
                y={18}
                fill="#f1f1f4"
                fontSize={12}
                fontFamily="'Open Sans', sans-serif"
                style={{ pointerEvents: 'none' }}
              >
                {n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name}
              </text>
              <text
                x={10}
                y={34}
                fill="#8c8fa1"
                fontSize={10}
                fontFamily="'Open Sans', sans-serif"
                style={{ pointerEvents: 'none' }}
              >
                {n.traceCount} • {formatDuration(n.avgMs)}
              </text>
              {n.errorRate >= 0.001 && (
                <text
                  x={NODE_W - 10}
                  y={34}
                  fill={n.errorRate >= 0.05 ? '#ff8a8a' : '#d9ae00'}
                  fontSize={10}
                  textAnchor="end"
                  fontFamily="'Open Sans', sans-serif"
                  style={{ pointerEvents: 'none' }}
                >
                  {(n.errorRate * 100).toFixed(1)}% err
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip for hovered edge */}
      {hoverEdge && (() => {
        const [src, tgt] = hoverEdge.split('|');
        const e = data.edges.find(x => x.source === src && x.target === tgt);
        if (!e) return null;
        const sp = positions.get(src);
        const tp = positions.get(tgt);
        if (!sp || !tp) return null;
        const midX = (sp.x + NODE_W + tp.x) / 2;
        const midY = (sp.y + NODE_H / 2 + tp.y + NODE_H / 2) / 2;
        return (
          <div
            className="absolute z-10 pointer-events-none bg-gray-1000 border border-gray-700 rounded px-2.5 py-1.5 shadow-4 text-tiny text-gray-200"
            style={{ left: Math.min(width - 200, Math.max(0, midX - 90)), top: midY - 8, transform: 'translateY(-100%)', minWidth: 180 }}
          >
            <div className="text-gray-400 text-[10px] mb-1">{src} → {tgt}</div>
            <div className="flex items-baseline justify-between gap-3"><span className="text-gray-500">Calls</span><span className="tabular-nums">{e.callCount.toLocaleString()}</span></div>
            <div className="flex items-baseline justify-between gap-3"><span className="text-gray-500">Avg</span><span className="tabular-nums">{formatDuration(e.avgMs)}</span></div>
            {e.errorRate > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-gray-500">Error %</span>
                <span className="tabular-nums text-[#ff8a8a]">{(e.errorRate * 100).toFixed(1)}%</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* Tooltip for hovered node */}
      {hoverNode && (() => {
        const n = data.nodes.find(x => x.name === hoverNode);
        const p = positions.get(hoverNode);
        if (!n || !p) return null;
        return (
          <div
            className="absolute z-10 pointer-events-none bg-gray-1000 border border-gray-700 rounded px-2.5 py-1.5 shadow-4 text-tiny text-gray-200"
            style={{ left: Math.min(width - 200, Math.max(0, p.x + NODE_W / 2 - 90)), top: p.y - 8, transform: 'translateY(-100%)', minWidth: 180 }}
          >
            <div className="text-gray-200 text-tiny mb-1">{n.name}</div>
            <div className="flex items-baseline justify-between gap-3"><span className="text-gray-500">Traces</span><span className="tabular-nums">{n.traceCount.toLocaleString()}</span></div>
            <div className="flex items-baseline justify-between gap-3"><span className="text-gray-500">Avg span</span><span className="tabular-nums">{formatDuration(n.avgMs)}</span></div>
            {n.errorRate > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-gray-500">Error %</span>
                <span className="tabular-nums text-[#ff8a8a]">{(n.errorRate * 100).toFixed(1)}%</span>
              </div>
            )}
            {onNodeClick && <div className="text-[10px] text-gray-500 mt-1">click to filter traces</div>}
          </div>
        );
      })()}
    </div>
  );
};
