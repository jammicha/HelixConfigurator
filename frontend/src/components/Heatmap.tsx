import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';

export type HeatmapData = {
  timeStart: number;
  timeEnd: number;
  timeBuckets: number;
  durationBuckets: number;
  timeBucketSizeMs: number;
  /** Length durationBuckets + 1; edges[i] is the inclusive lower bound of row i, edges[i+1] is the upper bound. */
  durationEdgesMs: number[];
  /** Row-major: cells[d * timeBuckets + t] = count. */
  cells: number[];
  maxCount: number;
};

type Props = {
  data: HeatmapData;
  height?: number;
  /** Single-hue palette anchor. ADAPT-flat default = active blue. Defines max-color end of the ramp. */
  fillHigh?: string;
  /** Click-cell drilldown. */
  onCellClick?: (sinceMs: number, untilMs: number, minDurationMs: number, maxDurationMs: number) => void;
  /** Shared crosshair: external time (ms) to draw a vertical guide at, regardless of local hover. */
  hoveredTimeMs?: number | null;
  /** Shared crosshair: notify the page-level coordinator about local time-X hover. */
  onHoverTimeChange?: (ms: number | null) => void;
};

// Memoized cell grid. Re-renders only when the heatmap data, dimensions, or
// fills change — not on hover state. With ~720 rects on a 60×12 chart this
// is the difference between a smooth hover and a 50ms reflow per pointermove.
type HeatmapCellsProps = {
  nT: number;
  nD: number;
  cells: number[];
  cellFills: string[];
  cellW: number;
  cellH: number;
  padLeft: number;
  padTop: number;
  isInteractive: boolean;
};
const HeatmapCells = React.memo<HeatmapCellsProps>(({ nT, nD, cells, cellFills, cellW, cellH, padLeft, padTop, isInteractive }) => {
  const w = Math.max(0, cellW - 0.5);
  const h = Math.max(0, cellH - 0.5);
  return (
    <g>
      {cells.map((count, idx) => {
        const t = idx % nT;
        const d = Math.floor(idx / nT);
        return (
          <rect
            key={idx}
            x={padLeft + t * cellW}
            y={padTop + (nD - 1 - d) * cellH}
            width={w}
            height={h}
            fill={cellFills[idx]}
            className={isInteractive && count > 0 ? 'cursor-pointer' : ''}
          />
        );
      })}
    </g>
  );
});
HeatmapCells.displayName = 'HeatmapCells';

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const formatDuration = (ms: number) =>
  ms < 1 ? `${ms.toFixed(2)}ms`
  : ms < 1000 ? `${Math.round(ms)}ms`
  : `${(ms / 1000).toFixed(1)}s`;

/**
 * Latency × time heatmap. Duration on Y (log-scaled, fast at bottom, slow at
 * top), time on X. Cell color encodes trace count — single hue from
 * transparent to fillHigh (ADAPT-flat single-hue ramp, no rainbow). Hover
 * cells for counts; click for drilldown.
 */
export const Heatmap: React.FC<Props> = ({ data, height = 220, fillHigh = '#3759d8', onCellClick, hoveredTimeMs, onHoverTimeChange }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ t: number; d: number } | null>(null);

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

  const padding = { top: 4, right: 8, bottom: 18, left: 56 };
  const innerW = Math.max(0, width - padding.left - padding.right);
  const innerH = Math.max(0, height - padding.top - padding.bottom);
  const { timeBuckets: nT, durationBuckets: nD, cells, durationEdgesMs, maxCount } = data;
  const cellW = nT > 0 ? innerW / nT : 0;
  const cellH = nD > 0 ? innerH / nD : 0;

  // Precompute the fill color for every cell, keyed by the actual inputs
  // (cells array, maxCount, fillHigh). Hover updates don't invalidate this
  // memo, which is what lets the cell <g> below stay rerender-free on
  // mousemove.
  const cellFills = useMemo(() => {
    const denom = maxCount > 0 ? Math.log10(1 + maxCount) : 0;
    return cells.map(count => {
      if (count <= 0 || denom <= 0) return 'rgba(255,255,255,0.02)';
      const t = Math.min(1, Math.log10(1 + count) / denom);
      return `${fillHigh}${Math.round(t * 0.92 * 255).toString(16).padStart(2, '0')}`;
    });
  }, [cells, maxCount, fillHigh]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!cellW || !cellH) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - padding.left;
    const y = e.clientY - rect.top - padding.top;
    if (x < 0 || x >= innerW || y < 0 || y >= innerH) {
      setHover(null);
      if (onHoverTimeChange) onHoverTimeChange(null);
      return;
    }
    const t = Math.min(nT - 1, Math.max(0, Math.floor(x / cellW)));
    // d=0 is bottom row (fastest); SVG y grows downward, so flip.
    const d = Math.min(nD - 1, Math.max(0, nD - 1 - Math.floor(y / cellH)));
    setHover({ t, d });
    if (onHoverTimeChange) onHoverTimeChange(data.timeStart + t * data.timeBucketSizeMs + data.timeBucketSizeMs / 2);
  };
  const onLeave = () => {
    setHover(null);
    if (onHoverTimeChange) onHoverTimeChange(null);
  };

  // Translate the shared-crosshair time-X into a time-bucket index.
  const externalT = (() => {
    if (typeof hoveredTimeMs !== 'number' || data.timeBucketSizeMs <= 0) return null;
    if (hoveredTimeMs < data.timeStart || hoveredTimeMs > data.timeEnd) return null;
    return Math.min(nT - 1, Math.max(0, Math.floor((hoveredTimeMs - data.timeStart) / data.timeBucketSizeMs)));
  })();

  const handleClick = () => {
    if (!hover || !onCellClick) return;
    const tStart = data.timeStart + hover.t * data.timeBucketSizeMs;
    const tEnd = tStart + data.timeBucketSizeMs;
    const dMin = durationEdgesMs[hover.d];
    const dMax = durationEdgesMs[hover.d + 1];
    onCellClick(tStart, tEnd, dMin, dMax);
  };

  // Y-axis labels: show min, mid, max of duration edges.
  const yTickIdxs = nD >= 4 ? [0, Math.floor(nD / 2), nD] : [0, nD];

  // X-axis labels at start / middle / end.
  const xTicks = nT >= 2 ? [
    { x: padding.left + 2, label: formatTime(data.timeStart) },
    { x: padding.left + innerW / 2, label: formatTime(data.timeStart + (data.timeBucketSizeMs * Math.floor(nT / 2))) },
    { x: padding.left + innerW - 2, label: formatTime(data.timeEnd) },
  ] : [];

  const hoverCount = hover ? (cells[hover.d * nT + hover.t] || 0) : 0;
  const hoverTimeStart = hover ? data.timeStart + hover.t * data.timeBucketSizeMs : 0;

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <svg width={width} height={height} className="block" onMouseMove={onMove} onMouseLeave={onLeave} onClick={handleClick}>
        {/* Cells — extracted to a memoized component so mousemove doesn't
            re-render all nT*nD rects. The hover highlight is a separate
            overlay rect below, also independent of the cell grid. */}
        <HeatmapCells
          nT={nT}
          nD={nD}
          cells={cells}
          cellFills={cellFills}
          cellW={cellW}
          cellH={cellH}
          padLeft={padding.left}
          padTop={padding.top}
          isInteractive={!!onCellClick}
        />
        {/* Hover highlight — single rect, replaces the per-cell stroke prop
            that used to invalidate every cell on every mousemove. */}
        {hover && cellW > 0 && cellH > 0 && (
          <rect
            x={padding.left + hover.t * cellW}
            y={padding.top + (nD - 1 - hover.d) * cellH}
            width={Math.max(0, cellW - 0.5)}
            height={Math.max(0, cellH - 0.5)}
            fill="none"
            stroke="#ffffff"
            strokeOpacity={0.4}
            strokeWidth={1}
            pointerEvents="none"
          />
        )}
        {/* Y axis labels */}
        {yTickIdxs.map(idx => (
          <text
            key={idx}
            x={padding.left - 6}
            y={padding.top + (nD - idx) * cellH + 3}
            fill="#8c8fa1"
            fontSize={10}
            textAnchor="end"
            fontFamily="'Open Sans', sans-serif"
          >
            {formatDuration(durationEdgesMs[idx])}
          </text>
        ))}
        {/* X axis labels */}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={height - 4}
            fill="#8c8fa1"
            fontSize={10}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontFamily="'Open Sans', sans-serif"
          >
            {t.label}
          </text>
        ))}
        {/* Shared-crosshair guide (suppressed when the user is hovering this chart directly) */}
        {externalT != null && !hover && cellW > 0 && (
          <line
            x1={padding.left + externalT * cellW + cellW / 2}
            x2={padding.left + externalT * cellW + cellW / 2}
            y1={padding.top}
            y2={padding.top + innerH}
            stroke="#ffffff"
            strokeOpacity={0.2}
            strokeWidth={1}
            pointerEvents="none"
          />
        )}

        {/* Axis baselines */}
        <line x1={padding.left} y1={padding.top + innerH + 0.5} x2={padding.left + innerW} y2={padding.top + innerH + 0.5} stroke="#393b46" strokeWidth={1} />
        <line x1={padding.left + 0.5} y1={padding.top} x2={padding.left + 0.5} y2={padding.top + innerH} stroke="#393b46" strokeWidth={1} />
      </svg>

      {/* Tooltip */}
      {hover && (
        <div
          className="absolute z-10 pointer-events-none bg-gray-1000 border border-gray-700 rounded px-2.5 py-1.5 shadow-4 text-tiny text-gray-200"
          style={{
            left: Math.min(width - 220, padding.left + hover.t * cellW + cellW / 2 - 100),
            top: padding.top + (nD - 1 - hover.d) * cellH - 8,
            transform: 'translateY(-100%)',
            minWidth: 200,
          }}
        >
          <div className="tabular-nums text-gray-400 text-[10px]">
            {formatDuration(durationEdgesMs[hover.d])} – {formatDuration(durationEdgesMs[hover.d + 1])}
          </div>
          <div className="tabular-nums text-gray-400 text-[10px] mb-1">
            {formatTime(hoverTimeStart)} – {formatTime(hoverTimeStart + data.timeBucketSizeMs)}
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-gray-500">Traces</span>
            <span className="text-base text-gray-100 tabular-nums">{hoverCount.toLocaleString()}</span>
          </div>
          {onCellClick && hoverCount > 0 && <div className="text-[10px] text-gray-500 mt-1">click to drill down</div>}
        </div>
      )}
    </div>
  );
};
