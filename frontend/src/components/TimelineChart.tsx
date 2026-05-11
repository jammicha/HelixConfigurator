import React, { useLayoutEffect, useRef, useState } from 'react';

export type TimelineBucket = {
  tsMs: number;
  total: number;
  [segmentKey: string]: number | null | undefined;
};

export type TimelineSegment = {
  key: string;
  label: string;
  fill: string;
};

export type TimelinePercentile = {
  /** ms */
  p50?: number | null;
  /** ms */
  p95?: number | null;
};

type Props = {
  buckets: TimelineBucket[];
  segments: TimelineSegment[];
  bucketSizeMs: number;
  loading?: boolean;
  height?: number;
  /** Optional latency overlay. One entry per bucket, aligned by index. */
  percentiles?: TimelinePercentile[];
  /** Currently zoomed-in bucket window, in ms. Used to highlight + reflect the active filter. */
  selectedRange?: { sinceMs: number; untilMs: number } | null;
  onBucketClick?: (bucketStartMs: number, bucketEndMs: number) => void;
};

// Compact, hex-style color tokens that match the project's Tailwind palette.
// Picking by hand instead of pulling Tailwind classes because SVG `fill`
// doesn't accept utility classes and tailwind/colors aren't resolvable from
// component code without extra plumbing.
export const TIMELINE_COLORS = {
  ok: '#3759d8',       // active blue
  slow: '#ffd200',     // warning yellow
  error: '#b2001e',    // danger red
  errorSoft: '#a8002a',
  info: '#707589',     // gray-600
  debug: '#393b46',    // gray-800
  warn: '#ffd200',
  p50: '#8c8fa1',
  p95: '#389be1',
};

const formatTime = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};

const formatDuration = (ms: number) => {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export const TimelineChart: React.FC<Props> = ({
  buckets,
  segments,
  bucketSizeMs,
  loading,
  height = 80,
  percentiles,
  selectedRange,
  onBucketClick,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Resize observer so the chart scales with the container, not just the
  // initial mount width.
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

  const padding = { top: 4, right: 10, bottom: 18, left: 10 };
  const innerW = Math.max(0, width - padding.left - padding.right);
  const innerH = Math.max(0, height - padding.top - padding.bottom);

  // Derived scale ranges
  const maxTotal = Math.max(1, ...buckets.map(b => b.total || 0));
  const showPercentiles = !!percentiles && percentiles.some(p => p && (p.p50 != null || p.p95 != null));
  const maxLatencyMs = showPercentiles
    ? Math.max(1, ...(percentiles || []).map(p => Math.max(p?.p50 || 0, p?.p95 || 0)))
    : 0;

  const bucketWidth = buckets.length ? innerW / buckets.length : 0;
  const barWidth = Math.max(1, bucketWidth - 1);

  const xOf = (i: number) => padding.left + i * bucketWidth + bucketWidth / 2;
  const yOfCount = (count: number) => padding.top + innerH - (innerH * (count / maxTotal));
  const yOfLatency = (ms: number) => padding.top + innerH - (innerH * (ms / maxLatencyMs));

  const onMove = (e: React.MouseEvent<SVGElement>) => {
    if (!buckets.length || bucketWidth <= 0) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left - padding.left;
    const idx = Math.max(0, Math.min(buckets.length - 1, Math.floor(x / bucketWidth)));
    setHoverIdx(idx);
  };
  const onLeave = () => setHoverIdx(null);

  const handleBucketClick = (idx: number) => {
    if (!onBucketClick) return;
    const b = buckets[idx];
    onBucketClick(b.tsMs, b.tsMs + bucketSizeMs);
  };

  // Build the polyline points for the percentile overlay (only buckets where
  // we have a value contribute; gaps are bridged so the line stays continuous
  // and matches Stackify's "always there" feel).
  const polylinePoints = (key: 'p50' | 'p95') => {
    if (!percentiles) return '';
    const pts: string[] = [];
    for (let i = 0; i < percentiles.length; i++) {
      const v = percentiles[i]?.[key];
      if (typeof v === 'number' && v >= 0) {
        pts.push(`${xOf(i)},${yOfLatency(v)}`);
      }
    }
    return pts.join(' ');
  };

  // Axis ticks: just start, middle, end
  const axisTicks = buckets.length >= 2
    ? [
        { x: padding.left + 2, label: formatTime(buckets[0].tsMs) },
        { x: padding.left + innerW / 2, label: formatTime(buckets[Math.floor(buckets.length / 2)].tsMs) },
        { x: padding.left + innerW - 2, label: formatTime(buckets[buckets.length - 1].tsMs + bucketSizeMs) },
      ]
    : [];

  const hover = hoverIdx != null ? buckets[hoverIdx] : null;
  const hoverPct = hoverIdx != null && percentiles ? percentiles[hoverIdx] : null;
  const totalCount = buckets.reduce((acc, b) => acc + (b.total || 0), 0);

  return (
    <div ref={containerRef} className="relative w-full select-none">
      <svg
        width={width}
        height={height}
        className="block"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        {/* X axis baseline */}
        <line
          x1={padding.left}
          x2={padding.left + innerW}
          y1={padding.top + innerH + 0.5}
          y2={padding.top + innerH + 0.5}
          stroke="#393b46"
          strokeWidth={1}
        />

        {/* Selected range shading (covers the active sinceMs..untilMs window) */}
        {selectedRange && buckets.length > 0 && bucketSizeMs > 0 && (() => {
          const totalSpanMs = buckets.length * bucketSizeMs;
          const start = (Math.max(selectedRange.sinceMs, buckets[0].tsMs) - buckets[0].tsMs) / totalSpanMs;
          const end = (Math.min(selectedRange.untilMs, buckets[buckets.length - 1].tsMs + bucketSizeMs) - buckets[0].tsMs) / totalSpanMs;
          if (end <= start) return null;
          const x = padding.left + innerW * start;
          const w = innerW * (end - start);
          return (
            <rect x={x} y={padding.top} width={w} height={innerH} fill="#3759d8" fillOpacity={0.08} />
          );
        })()}

        {/* Stacked bars per bucket */}
        {buckets.map((b, i) => {
          if (!b.total) return null;
          let yCursor = padding.top + innerH;
          return (
            <g key={i} onClick={() => handleBucketClick(i)} className={onBucketClick ? 'cursor-pointer' : ''}>
              {segments.map(seg => {
                const v = Number(b[seg.key] || 0);
                if (v <= 0) return null;
                const h = innerH * (v / maxTotal);
                const y = yCursor - h;
                yCursor = y;
                return (
                  <rect
                    key={seg.key}
                    x={xOf(i) - barWidth / 2}
                    y={y}
                    width={barWidth}
                    height={h}
                    fill={seg.fill}
                    opacity={hoverIdx === i ? 1 : 0.85}
                  />
                );
              })}
            </g>
          );
        })}

        {/* Percentile overlay (p50 dashed, p95 solid) */}
        {showPercentiles && (
          <>
            <polyline
              fill="none"
              stroke={TIMELINE_COLORS.p50}
              strokeWidth={1.25}
              strokeDasharray="3 2"
              points={polylinePoints('p50')}
            />
            <polyline
              fill="none"
              stroke={TIMELINE_COLORS.p95}
              strokeWidth={1.5}
              points={polylinePoints('p95')}
            />
          </>
        )}

        {/* Hover vertical guide */}
        {hoverIdx != null && (
          <line
            x1={xOf(hoverIdx)}
            x2={xOf(hoverIdx)}
            y1={padding.top}
            y2={padding.top + innerH}
            stroke="#ffffff"
            strokeOpacity={0.18}
            strokeWidth={Math.max(2, barWidth + 2)}
            pointerEvents="none"
          />
        )}

        {/* X-axis tick labels */}
        {axisTicks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={height - 4}
            fill="#8c8fa1"
            fontSize={10}
            textAnchor={i === 0 ? 'start' : i === axisTicks.length - 1 ? 'end' : 'middle'}
            fontFamily="'Source Code Pro', monospace"
          >
            {t.label}
          </text>
        ))}
      </svg>

      {/* Top-right meta: total count + percentile legend */}
      <div className="absolute top-0.5 right-2 flex items-center gap-3 text-tiny text-gray-500 font-semibold uppercase tracking-wider pointer-events-none">
        <span>{totalCount.toLocaleString()} total</span>
        {showPercentiles && (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-px" style={{ background: TIMELINE_COLORS.p50, borderTop: `1px dashed ${TIMELINE_COLORS.p50}` }} />
              p50
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-0.5" style={{ background: TIMELINE_COLORS.p95 }} />
              p95
            </span>
          </>
        )}
      </div>

      {/* Loading veil */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-1000/40 text-tiny text-gray-500 uppercase tracking-wider">
          Loading…
        </div>
      )}

      {/* Hover tooltip — positioned near the bucket */}
      {hover && bucketSizeMs > 0 && (
        <div
          className="absolute z-10 pointer-events-none bg-gray-1000 border border-gray-700 rounded px-2.5 py-1.5 shadow-4 text-tiny text-gray-200"
          style={{
            left: Math.min(width - 200, Math.max(0, xOf(hoverIdx!) - 90)),
            top: -8,
            transform: 'translateY(-100%)',
            minWidth: 180,
          }}
        >
          <div className="font-mono text-gray-400 text-[10px]">
            {formatTime(hover.tsMs)} – {formatTime(hover.tsMs + bucketSizeMs)}
          </div>
          {hover.total > 0 ? (
            <>
              {segments.map(seg => {
                const v = Number(hover[seg.key] || 0);
                if (v <= 0) return null;
                return (
                  <div key={seg.key} className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-sm" style={{ background: seg.fill }} />
                      {seg.label}
                    </span>
                    <span className="font-mono">{v.toLocaleString()}</span>
                  </div>
                );
              })}
              <div className="border-t border-gray-800 mt-1 pt-1 flex items-center justify-between text-gray-400">
                <span>Total</span>
                <span className="font-mono">{hover.total.toLocaleString()}</span>
              </div>
              {hoverPct && (hoverPct.p50 != null || hoverPct.p95 != null) && (
                <div className="border-t border-gray-800 mt-1 pt-1">
                  {hoverPct.p50 != null && (
                    <div className="flex items-center justify-between gap-3 text-gray-400">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-3 h-px" style={{ borderTop: `1px dashed ${TIMELINE_COLORS.p50}` }} />
                        p50
                      </span>
                      <span className="font-mono">{formatDuration(hoverPct.p50)}</span>
                    </div>
                  )}
                  {hoverPct.p95 != null && (
                    <div className="flex items-center justify-between gap-3 text-gray-400">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-3 h-0.5" style={{ background: TIMELINE_COLORS.p95 }} />
                        p95
                      </span>
                      <span className="font-mono">{formatDuration(hoverPct.p95)}</span>
                    </div>
                  )}
                </div>
              )}
              {onBucketClick && (
                <div className="text-[10px] text-gray-500 mt-1">click to zoom</div>
              )}
            </>
          ) : (
            <div className="text-gray-500">No activity</div>
          )}
        </div>
      )}
    </div>
  );
};
