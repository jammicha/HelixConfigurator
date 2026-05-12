import React, { useMemo, useState } from 'react';
import type { SpanDetail } from '../types';
import { formatDuration } from '../utils';
import { colorForService } from './palette';

// Item 4: flame graph (icicle, top-down). Layered by tree depth, each rect's
// width proportional to span duration, x position to its offset from trace
// start. Color by service so you can see service handoffs at a glance.
// Off-path spans dim to match the waterfall convention.
export const FlameView: React.FC<{
  spans: SpanDetail[];
  traceStartNs: number;
  traceDurationNs: number;
  criticalPath: Set<string>;
}> = ({ spans, traceStartNs, traceDurationNs, criticalPath }) => {
  const [hover, setHover] = useState<{ span: SpanDetail; x: number; y: number } | null>(null);
  const ROW_HEIGHT = 22;
  // Compute per-span depth via BFS from roots so siblings stay on the same row.
  const depths = useMemo(() => {
    const byParent = new Map<string, SpanDetail[]>();
    for (const s of spans) {
      const p = s.parentSpanId || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(s);
    }
    const depth = new Map<string, number>();
    const roots = spans.filter(s => !s.parentSpanId || !spans.some(o => o.spanId === s.parentSpanId));
    const stack: { span: SpanDetail; d: number }[] = roots.map(s => ({ span: s, d: 0 }));
    while (stack.length) {
      const { span, d } = stack.pop()!;
      depth.set(span.spanId, d);
      for (const c of byParent.get(span.spanId) || []) stack.push({ span: c, d: d + 1 });
    }
    // Spans missing from BFS (orphans) — put them at row 0.
    for (const s of spans) if (!depth.has(s.spanId)) depth.set(s.spanId, 0);
    return depth;
  }, [spans]);
  const maxDepth = Math.max(0, ...Array.from(depths.values()));
  const totalHeight = (maxDepth + 1) * ROW_HEIGHT;

  return (
    <div
      className="relative w-full bg-gray-1000"
      style={{ height: totalHeight }}
      onMouseLeave={() => setHover(null)}
    >
      {spans.map(s => {
        const d = depths.get(s.spanId) || 0;
        const left = ((s.startTimeNs - traceStartNs) / traceDurationNs) * 100;
        const width = Math.max(0.1, ((s.endTimeNs - s.startTimeNs) / traceDurationNs) * 100);
        const onPath = criticalPath.has(s.spanId);
        return (
          <div
            key={`${s.spanId}-${s.traceId}`}
            className="absolute border-r border-gray-1000 hover:brightness-125 transition-[filter] cursor-default"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              top: d * ROW_HEIGHT,
              height: ROW_HEIGHT - 1,
              backgroundColor: colorForService(s.serviceName),
              opacity: onPath ? 0.95 : 0.45,
            }}
            onMouseEnter={(e) => setHover({ span: s, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setHover({ span: s, x: e.clientX, y: e.clientY })}
          >
            <span className="block px-1 text-tiny text-white truncate font-medium leading-[20px]" style={{ fontSize: 10 }}>
              {width > 4 ? s.name : ''}
            </span>
          </div>
        );
      })}
      {hover && (() => {
        // Flip the tooltip to the left/above the cursor when it would
        // overflow the viewport — otherwise hovering near the right or
        // bottom of the trace drawer makes the tooltip unreadable.
        const TIP_W = 320;
        const TIP_H = 64;
        const PAD = 12;
        const flipX = typeof window !== 'undefined' && hover.x + TIP_W + PAD > window.innerWidth;
        const flipY = typeof window !== 'undefined' && hover.y + TIP_H + PAD > window.innerHeight;
        const left = flipX ? Math.max(8, hover.x - TIP_W - PAD) : hover.x + PAD;
        const top = flipY ? Math.max(8, hover.y - TIP_H - PAD) : hover.y + PAD;
        return (
          <div
            className="fixed z-50 pointer-events-none bg-gray-900 border border-gray-700 rounded px-2 py-1.5 shadow-4 text-tiny"
            style={{ left, top, maxWidth: TIP_W }}
          >
            <div className="text-gray-100 break-all">{hover.span.name}</div>
            <div className="text-gray-400 mt-0.5">
              <span>{hover.span.serviceName}</span>
              <span className="mx-1.5">·</span>
              <span>{formatDuration(hover.span.durationMs)}</span>
              {criticalPath.has(hover.span.spanId) && <><span className="mx-1.5">·</span><span className="text-warning">on critical path</span></>}
            </div>
          </div>
        );
      })()}
    </div>
  );
};
