import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Clock, Database, Repeat, Server } from 'lucide-react';
import type { LogRecord, SpanDetail, TraceDetail } from '../types';
import { useSlowThreshold } from '../SlowThresholdContext';
import { collapsibleSpanIds, countMatchingSpans, detectNPlusOne, formatDuration, isErrorSpan, spanMatchesQuery, withAncestors } from '../utils';
import { colorForService } from './palette';
import { LogLine } from './LogLine';
import { SpanRow } from './SpanRow';
import { FlameView } from './FlameView';

const SummaryCell: React.FC<{
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: 'success' | 'warning' | 'danger';
}> = ({ label, value, icon, tone }) => {
  const toneClasses = tone === 'danger'
    ? 'text-[#ff8a8a]'
    : tone === 'warning'
      ? 'text-warning'
      : tone === 'success'
        ? 'text-[#5eead4]'
        : 'text-gray-100';
  return (
    <div className="adapt-card !p-3">
      <div className="flex items-center gap-1.5 text-tiny text-gray-500 uppercase tracking-wider font-semibold">
        {icon} {label}
      </div>
      <div className={`mt-1 tabular-nums text-base ${toneClasses}`}>{value}</div>
    </div>
  );
};

const RollupPanel: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  tone: 'info' | 'warning' | 'danger';
  columns: string[];
  rows: { key: string; cells: React.ReactNode[] }[];
  footer: string | null;
}> = ({ icon, title, subtitle, tone, columns, rows, footer }) => {
  const headerTone = tone === 'danger' ? 'text-[#ff8a8a]' : tone === 'warning' ? 'text-warning' : 'text-link';
  return (
    <div className="adapt-card !p-0 overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2 bg-gray-900 flex-shrink-0">
        <span className={headerTone}>{icon}</span>
        <span className="text-sm font-semibold text-gray-200">{title}</span>
        <span className="text-tiny text-gray-500 ml-auto">{subtitle}</span>
      </div>
      <div className="overflow-y-auto overflow-x-hidden max-h-[148px]" style={{ scrollbarGutter: 'stable' }}>
        <table className="w-full text-tiny relative border-collapse">
          <thead className="sticky top-0 bg-gray-900 z-10 shadow-[inset_0_-1px_0_#1f2937]">
            <tr className="text-left text-gray-500 uppercase tracking-wider bg-gray-900">
              {columns.map((c, i) => {
                const isLast = i === columns.length - 1;
                return (
                  <th
                    key={c}
                    className={`py-1 font-semibold ${i === 0 ? 'pl-3 pr-1' : 'text-right bg-gray-900'} ${isLast ? 'pr-4' : 'px-3'}`}
                  >
                    {c}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} className="border-t border-gray-800 hover:bg-gray-800/20">
                {r.cells.map((c, i) => {
                  const isLast = i === r.cells.length - 1;
                  return (
                    <td
                      key={i}
                      className={`py-1 ${i === 0 ? 'text-gray-200 pl-3 pr-1' : 'text-right text-gray-300 tabular-nums'} ${isLast ? 'pr-4' : 'px-3'}`}
                    >
                      {c}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && (
        <div className="px-3 py-1.5 border-t border-gray-800 text-tiny text-gray-500 bg-gray-1000 flex-shrink-0">{footer}</div>
      )}
    </div>
  );
};

const ServiceBreakdownPanel: React.FC<{
  breakdown: { name: string; totalMs: number }[];
  traceDurationMs: number;
  hoveredService: string | null;
  setHoveredService: (s: string | null) => void;
  selectedService: string | null;
  setSelectedService: (s: string | null) => void;
}> = ({ breakdown, traceDurationMs, hoveredService, setHoveredService, selectedService, setSelectedService }) => {
  const total = breakdown.reduce((acc, b) => acc + b.totalMs, 0);
  // Use the larger of trace duration vs sum-of-services for the denominator
  // — a perfectly serial trace will sum to ~trace duration, but a heavily
  // parallel one can sum to more (each parallel branch counts) and we still
  // want each segment proportional.
  const denom = Math.max(traceDurationMs, total);
  return (
    <div className="adapt-card !p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <Server className="w-3.5 h-3.5 text-link" />
        <span className="text-sm font-semibold text-gray-200">Service breakdown</span>
        { (hoveredService || selectedService) && (
          <button
            onClick={() => { setHoveredService(null); setSelectedService(null); }}
            className="text-[10px] text-gray-500 hover:text-gray-300 font-mono underline ml-2"
          >
            clear filter
          </button>
        )}
        <span className="text-tiny text-gray-500 ml-auto">where the time went (click/hover to filter spans)</span>
      </div>
      <div className="flex h-6 rounded overflow-hidden border border-gray-800 bg-gray-1000 flex-shrink-0">
        {breakdown.map(b => {
          const w = (b.totalMs / denom) * 100;
          if (w < 0.5) return null;
          const isHovered = hoveredService === b.name;
          const isSelected = selectedService === b.name;
          return (
            <button
              key={b.name}
              type="button"
              style={{ width: `${w}%`, backgroundColor: colorForService(b.name) }}
              title={`${b.name}: ${formatDuration(b.totalMs)} (${(b.totalMs / denom * 100).toFixed(1)}%)`}
              onMouseEnter={() => setHoveredService(b.name)}
              onMouseLeave={() => setHoveredService(null)}
              onClick={() => setSelectedService(selectedService === b.name ? null : b.name)}
              className={`h-full border-r border-gray-900/40 transition-all cursor-pointer outline-none ${
                isSelected 
                  ? 'ring-1 ring-white z-10 scale-y-110 shadow-lg' 
                  : isHovered 
                    ? 'brightness-110 opacity-100' 
                    : 'opacity-85'
              }`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-tiny">
        {breakdown.map(b => {
          const isHovered = hoveredService === b.name;
          const isSelected = selectedService === b.name;
          return (
            <button
              key={b.name}
              type="button"
              onMouseEnter={() => setHoveredService(b.name)}
              onMouseLeave={() => setHoveredService(null)}
              onClick={() => setSelectedService(selectedService === b.name ? null : b.name)}
              className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded cursor-pointer transition-all duration-[150ms] border ${
                isSelected 
                  ? 'bg-primary/20 border-primary text-white font-semibold shadow' 
                  : isHovered 
                    ? 'bg-gray-800/60 border-gray-700 text-gray-200' 
                    : 'bg-transparent border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: colorForService(b.name) }} />
              <span className="font-mono">{b.name}</span>
              <span className="text-gray-500 font-normal tabular-nums">{formatDuration(b.totalMs)}</span>
              <span className="text-gray-600 font-normal">({(b.totalMs / denom * 100).toFixed(0)}%)</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const Waterfall: React.FC<{ detail: TraceDetail; logs: LogRecord[] }> = ({ detail, logs }) => {
  const { spans, summary } = detail;
  const slowThresholdMs = useSlowThreshold();
  const [criticalPathOnly, setCriticalPathOnly] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [traceView, setTraceView] = useState<'waterfall' | 'flame'>('waterfall');
  const [spanSearchQuery, setSpanSearchQuery] = useState('');
  const [hoveredService, setHoveredService] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);

  // Match count for the "Find in spans" box — shared matcher with the page-
  // level helper so the highlight pass and this count can't disagree.
  const spanMatchCount = useMemo(
    () => countMatchingSpans(spans, spanSearchQuery),
    [spans, spanSearchQuery],
  );

  const isAnySearchOrFilterActive = !!spanSearchQuery || !!selectedService || !!hoveredService;

  const isSpanHighlighted = (span: SpanDetail): boolean => {
    if (spanSearchQuery && spanMatchesQuery(span, spanSearchQuery)) return true;
    const activeSvc = selectedService || hoveredService;
    if (activeSvc && span.serviceName === activeSvc) return true;
    return false;
  };

  const isSpanDimmed = (span: SpanDetail): boolean => {
    if (!isAnySearchOrFilterActive) return false;
    return !isSpanHighlighted(span);
  };

  // SpanId → true means "this span's subtree is hidden in the waterfall".
  // Toggled only from the SpanRow chevron (parents only); leaf rows never
  // see a toggle callback so the chevron keeps its legacy detail-open meaning.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const toggleCollapsed = (spanId: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId); else next.add(spanId);
      return next;
    });
  };
  // Every span that has children — the rows a "Collapse all" can fold. When all
  // of them are collapsed only the roots remain, so "Collapse all" disables;
  // "Expand all" disables when nothing is collapsed.
  const collapsibleIds = useMemo(() => collapsibleSpanIds(spans), [spans]);
  const allCollapsed = collapsibleIds.size > 0 && Array.from(collapsibleIds).every(id => collapsedIds.has(id));

  // "Errors only" — error spans plus their ancestor chains, so the waterfall
  // collapses to just the failing paths while keeping each failure's context
  // (who called it, through what) visible. Null when the toggle is off so the
  // render filter is a no-op. Off-state is forced when the trace has no error
  // spans (the toggle hides), so errorSpanIds is also the gate for showing it.
  const errorSpanIds = useMemo(() => {
    const s = new Set<string>();
    for (const sp of spans) if (isErrorSpan(sp)) s.add(sp.spanId);
    return s;
  }, [spans]);
  const errorsOnlyKeep = useMemo(
    () => (errorsOnly ? withAncestors(spans, errorSpanIds) : null),
    [errorsOnly, spans, errorSpanIds],
  );
  const traceStartNs = useMemo(() => {
    let min = Infinity;
    for (const s of spans) if (s.startTimeNs < min) min = s.startTimeNs;
    return min === Infinity ? 0 : min;
  }, [spans]);
  const traceEndNs = useMemo(() => {
    let max = 0;
    for (const s of spans) if (s.endTimeNs > max) max = s.endTimeNs;
    return max;
  }, [spans]);
  const traceDurationNs = Math.max(1, traceEndNs - traceStartNs);

  // Build a parent → children index, then walk depth-first so the rendered
  // order matches the typical waterfall (root, then nested children).
  const ordered = useMemo(() => {
    const byParent = new Map<string, SpanDetail[]>();
    for (const s of spans) {
      const p = s.parentSpanId || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(s);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.startTimeNs - b.startTimeNs);
    }
    const out: { span: SpanDetail; depth: number }[] = [];
    const allChildIds = new Set<string>();
    for (const s of spans) if (s.parentSpanId) allChildIds.add(s.spanId);
    // Roots = spans whose parent isn't in the trace (handles missing-root case).
    const roots = spans.filter(s => !s.parentSpanId || !spans.some(o => o.spanId === s.parentSpanId));
    const visit = (span: SpanDetail, depth: number) => {
      out.push({ span, depth });
      const children = byParent.get(span.spanId) || [];
      for (const c of children) visit(c, depth + 1);
    };
    for (const r of roots.sort((a, b) => a.startTimeNs - b.startTimeNs)) visit(r, 0);
    // Anything not visited (cycles, orphan loops) — append at depth 0.
    const visited = new Set(out.map(o => o.span.spanId));
    for (const s of spans) if (!visited.has(s.spanId)) out.push({ span: s, depth: 0 });
    return out;
  }, [spans]);

  // Transitive descendant count per span. Used to decide whether a row gets a
  // tree-collapse chevron, and to label collapsed parents with how many spans
  // are hidden underneath.
  const descendantCountById = useMemo(() => {
    const byParent = new Map<string, SpanDetail[]>();
    for (const s of spans) {
      const p = s.parentSpanId || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(s);
    }
    const counts = new Map<string, number>();
    const count = (id: string): number => {
      const cached = counts.get(id);
      if (cached != null) return cached;
      const kids = byParent.get(id) || [];
      let n = kids.length;
      for (const k of kids) n += count(k.spanId);
      counts.set(id, n);
      return n;
    };
    for (const s of spans) count(s.spanId);
    return counts;
  }, [spans]);

  // Filter the rendered list to hide any span whose ancestor chain crosses a
  // collapsed id. The collapsed parent itself stays visible.
  const visibleOrdered = useMemo(() => {
    if (collapsedIds.size === 0) return ordered;
    const parentById = new Map<string, string | null>();
    for (const s of spans) parentById.set(s.spanId, s.parentSpanId || null);
    const isHidden = (spanId: string): boolean => {
      let p = parentById.get(spanId) || null;
      while (p) {
        if (collapsedIds.has(p)) return true;
        p = parentById.get(p) || null;
      }
      return false;
    };
    return ordered.filter(o => !isHidden(o.span.spanId));
  }, [ordered, collapsedIds, spans]);

  const nPlusOne = useMemo(() => detectNPlusOne(spans), [spans]);

  // Item 9: Critical path — the chain of spans whose end times determine the
  // total trace duration. Walk from root, at each level pick the child whose
  // end_time is latest (the one the parent is actually waiting on). Rendered
  // with a thicker border + ⚡ marker so the eye lands on the bottleneck.
  const criticalPath = useMemo(() => {
    const set = new Set<string>();
    if (spans.length === 0) return set;
    const byParent = new Map<string, SpanDetail[]>();
    for (const s of spans) {
      const p = s.parentSpanId || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(s);
    }
    const roots = spans.filter(s => !s.parentSpanId || !spans.some(o => o.spanId === s.parentSpanId));
    const startRoot = roots.reduce((best, s) => (best == null || s.endTimeNs > best.endTimeNs ? s : best), null as SpanDetail | null);
    let cursor: SpanDetail | null = startRoot;
    while (cursor) {
      set.add(cursor.spanId);
      const children: SpanDetail[] = byParent.get(cursor.spanId) || [];
      if (children.length === 0) break;
      cursor = children.reduce((best, s) => (best == null || s.endTimeNs > best.endTimeNs ? s : best), null as SpanDetail | null);
    }
    return set;
  }, [spans]);

  // Item 5: SQL rollup. Group every DB span by system + statement (or
  // operation if no statement was captured) and report count + total time +
  // slowest exemplar so a busy trace's queries are visible at a glance.
  const sqlRollup = useMemo(() => {
    type Bucket = { system: string; key: string; display: string; count: number; totalMs: number; maxMs: number; exemplar: SpanDetail };
    const buckets = new Map<string, Bucket>();
    for (const s of spans) {
      const system = s.attributes['db.system'] || s.attributes['db.system.name'];
      if (!system) continue;
      const stmt = s.attributes['db.statement'] || s.attributes['db.query.text'];
      const op = s.attributes['db.operation'] || s.attributes['db.operation.name'] || s.attributes['db.query.summary'];
      const display = String(stmt || op || s.name);
      const key = `${system}|${display}`;
      const b = buckets.get(key);
      if (b) {
        b.count += 1;
        b.totalMs += s.durationMs;
        if (s.durationMs > b.maxMs) { b.maxMs = s.durationMs; b.exemplar = s; }
      } else {
        buckets.set(key, { system: String(system), key, display, count: 1, totalMs: s.durationMs, maxMs: s.durationMs, exemplar: s });
      }
    }
    return Array.from(buckets.values()).sort((a, b) => b.totalMs - a.totalMs);
  }, [spans]);
  const sqlTotalCount = sqlRollup.reduce((acc, b) => acc + b.count, 0);
  const sqlTotalMs = sqlRollup.reduce((acc, b) => acc + b.totalMs, 0);

  // Item 6: HTTP outbound rollup. Same shape as SQL rollup but for client
  // spans hitting external HTTP — surfaces fan-out and bad statuses.
  const httpRollup = useMemo(() => {
    type Bucket = { method: string; url: string; key: string; count: number; totalMs: number; maxMs: number; statuses: Map<number, number>; exemplar: SpanDetail };
    const buckets = new Map<string, Bucket>();
    for (const s of spans) {
      // OTel SpanKind enum: 1=INTERNAL 2=SERVER 3=CLIENT 4=PRODUCER 5=CONSUMER
      if (s.kind !== 3) continue;
      const method = String(s.attributes['http.method'] || s.attributes['http.request.method'] || '');
      const url = String(
        s.attributes['http.url']
        || s.attributes['url.full']
        || s.attributes['http.target']
        || s.attributes['url.path']
        || ''
      );
      const status = Number(s.attributes['http.status_code'] || s.attributes['http.response.status_code'] || 0);
      if (!method && !url) continue;
      // Strip query string + numeric IDs from path so /users/42 and /users/99
      // collapse into the same bucket — keeps the rollup readable on REST
      // APIs that bake IDs into the path.
      const normalized = url
        .replace(/\?.*$/, '')
        .replace(/\/\d+(?=\/|$)/g, '/{id}')
        .replace(/\/[0-9a-f-]{20,}(?=\/|$)/gi, '/{id}');
      const key = `${method} ${normalized}`;
      const b = buckets.get(key);
      if (b) {
        b.count += 1;
        b.totalMs += s.durationMs;
        if (s.durationMs > b.maxMs) { b.maxMs = s.durationMs; b.exemplar = s; }
        if (status) b.statuses.set(status, (b.statuses.get(status) || 0) + 1);
      } else {
        const statuses = new Map<number, number>();
        if (status) statuses.set(status, 1);
        buckets.set(key, { method, url: normalized, key, count: 1, totalMs: s.durationMs, maxMs: s.durationMs, statuses, exemplar: s });
      }
    }
    return Array.from(buckets.values()).sort((a, b) => b.totalMs - a.totalMs);
  }, [spans]);
  const httpTotalCount = httpRollup.reduce((acc, b) => acc + b.count, 0);
  const httpTotalMs = httpRollup.reduce((acc, b) => acc + b.totalMs, 0);
  const httpHasError = httpRollup.some(b => Array.from(b.statuses.keys()).some(s => s >= 400));

  // Item 1: Service breakdown — wall-clock time each service was busy in the
  // trace. Per-service intervals are merged so parallel spans of the same
  // service don't double-count. Sorted descending by total time.
  const serviceBreakdown = useMemo(() => {
    const byService = new Map<string, [number, number][]>();
    for (const s of spans) {
      const arr = byService.get(s.serviceName) || [];
      arr.push([s.startTimeNs, s.endTimeNs]);
      byService.set(s.serviceName, arr);
    }
    const out: { name: string; totalMs: number }[] = [];
    for (const [name, intervals] of byService) {
      intervals.sort((a, b) => a[0] - b[0]);
      let totalNs = 0;
      let curStart = intervals[0][0], curEnd = intervals[0][1];
      for (let i = 1; i < intervals.length; i++) {
        if (intervals[i][0] <= curEnd) curEnd = Math.max(curEnd, intervals[i][1]);
        else { totalNs += curEnd - curStart; curStart = intervals[i][0]; curEnd = intervals[i][1]; }
      }
      totalNs += curEnd - curStart;
      out.push({ name, totalMs: totalNs / 1e6 });
    }
    return out.sort((a, b) => b.totalMs - a.totalMs);
  }, [spans]);
  const serviceBreakdownDenom = Math.max(1, summary.duration_ms || serviceBreakdown.reduce((acc, s) => acc + s.totalMs, 0));

  // Item 2: CRISP-style refinement. For each on-path span, compute the
  // *portion* that's actually blocking — time after the last on-path child
  // finished. That's where the bottleneck lives. Render that segment as a
  // darker overlay on top of the bar (Grafana / Jaeger convention).
  const criticalIntervals = useMemo(() => {
    const map = new Map<string, { startNs: number; endNs: number }>();
    if (criticalPath.size === 0) return map;
    const byParent = new Map<string, SpanDetail[]>();
    for (const s of spans) {
      const p = s.parentSpanId || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(s);
    }
    for (const s of spans) {
      if (!criticalPath.has(s.spanId)) continue;
      const onPathChild = (byParent.get(s.spanId) || []).find(c => criticalPath.has(c.spanId));
      const start = onPathChild ? onPathChild.endTimeNs : s.startTimeNs;
      const end = s.endTimeNs;
      map.set(s.spanId, { startNs: start, endNs: end });
    }
    return map;
  }, [spans, criticalPath]);

  // Map logs to their nearest span (by spanId match) so we can inline-render
  // them under the appropriate row in the waterfall.
  const logsBySpan = useMemo(() => {
    const map = new Map<string, LogRecord[]>();
    for (const l of logs) {
      const key = l.spanId || '__trace__';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(l);
    }
    return map;
  }, [logs]);
  const logsAtTraceLevel = logsBySpan.get('__trace__') || [];

  return (
    <div className="px-6 py-5">
      {/* Trace summary row */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        <SummaryCell label="Service" value={summary.service_name} icon={<Server className="w-3.5 h-3.5" />} />
        <SummaryCell label="Duration" value={formatDuration(summary.duration_ms)} icon={<Clock className="w-3.5 h-3.5" />} tone={summary.duration_ms > slowThresholdMs ? 'warning' : undefined} />
        <SummaryCell label="Spans" value={String(summary.span_count)} icon={<Activity className="w-3.5 h-3.5" />} />
        <SummaryCell label="Status" value={summary.has_error ? 'Error' : 'OK'} icon={<AlertTriangle className="w-3.5 h-3.5" />} tone={summary.has_error ? 'danger' : 'success'} />
      </div>

      {nPlusOne && (
        <div className="mb-4 flex gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm items-start">
          <Repeat className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <div>
            <span className="text-warning font-semibold">Possible N+1 query pattern.</span>{' '}
            <span className="text-gray-300">
              {nPlusOne.count} spans share <code className="font-mono text-gray-200">db.operation = {nPlusOne.operation}</code>
              {nPlusOne.dbName && <> on <code className="font-mono text-gray-200">{nPlusOne.dbName}</code></>} in this trace.
              Consider batching or eager-loading.
            </span>
          </div>
        </div>
      )}

      {serviceBreakdown.length > 0 && (
        <ServiceBreakdownPanel
          breakdown={serviceBreakdown}
          traceDurationMs={serviceBreakdownDenom}
          hoveredService={hoveredService}
          setHoveredService={setHoveredService}
          selectedService={selectedService}
          setSelectedService={setSelectedService}
        />
      )}

      {(sqlRollup.length > 0 || httpRollup.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
          {sqlRollup.length > 0 && (
            <RollupPanel
              icon={<Database className="w-3.5 h-3.5" />}
              title="SQL"
              subtitle={`${sqlTotalCount} call${sqlTotalCount === 1 ? '' : 's'} • ${formatDuration(sqlTotalMs)} total`}
              tone={sqlRollup.some(b => b.maxMs > slowThresholdMs) ? 'warning' : 'info'}
              columns={['Query', 'Count', 'Total', 'Slowest']}
              rows={sqlRollup.slice(0, 50).map(b => ({
                key: b.key,
                cells: [
                  <span className="font-mono text-tiny truncate inline-block max-w-[24rem]" title={b.display}>
                    <span className="text-gray-500">{b.system}: </span>{b.display}
                  </span>,
                  String(b.count),
                  formatDuration(b.totalMs),
                  <div className="flex flex-col items-end">
                    <span className={b.maxMs > slowThresholdMs ? 'text-warning font-semibold' : ''}>{formatDuration(b.maxMs)}</span>
                    {b.maxMs > slowThresholdMs && (
                      <span className="text-[9px] text-warning/70 select-none font-normal leading-none mt-0.5 pr-0.5">
                        {`>${(b.maxMs / slowThresholdMs).toFixed(1)}x limit`}
                      </span>
                    )}
                  </div>,
                ],
              }))}
              footer={sqlRollup.length > 50 ? `+ ${sqlRollup.length - 50} more` : null}
            />
          )}
          {httpRollup.length > 0 && (
            <RollupPanel
              icon={<Activity className="w-3.5 h-3.5" />}
              title="HTTP outbound"
              subtitle={`${httpTotalCount} call${httpTotalCount === 1 ? '' : 's'} • ${formatDuration(httpTotalMs)} total`}
              tone={httpHasError ? 'danger' : httpRollup.some(b => b.maxMs > slowThresholdMs) ? 'warning' : 'info'}
              columns={['Endpoint', 'Count', 'Total', 'Status']}
              rows={httpRollup.slice(0, 50).map(b => ({
                key: b.key,
                cells: [
                  <span className="font-mono text-tiny truncate inline-block max-w-[24rem]" title={`${b.method} ${b.url}`}>
                    <span className="text-gray-500">{b.method || '?'} </span>{b.url || '(no url)'}
                  </span>,
                  String(b.count),
                  <div className="flex flex-col items-end">
                    <span className={b.maxMs > slowThresholdMs ? 'text-warning font-semibold' : ''}>{formatDuration(b.totalMs)}</span>
                    {b.maxMs > slowThresholdMs && (
                      <span className="text-[9px] text-warning/70 select-none font-normal leading-none mt-0.5">
                        {`max: ${formatDuration(b.maxMs)}`}
                      </span>
                    )}
                  </div>,
                  <span className="inline-flex flex-wrap gap-1">
                    {Array.from(b.statuses.entries()).sort((a, b2) => a[0] - b2[0]).map(([code, n]) => (
                      <span
                        key={code}
                        className={`text-tiny tabular-nums px-1 rounded ${code >= 500 ? 'bg-danger/20 text-[#ff8a8a]' : code >= 400 ? 'bg-warning/20 text-warning' : 'bg-gray-800 text-gray-300'}`}
                      >
                        {code}{n > 1 ? `×${n}` : ''}
                      </span>
                    ))}
                    {b.statuses.size === 0 && <span className="text-tiny text-gray-600">—</span>}
                  </span>,
                ],
              }))}
              footer={httpRollup.length > 50 ? `+ ${httpRollup.length - 50} more` : null}
            />
          )}
        </div>
      )}

      {/* Waterfall / Flame */}
      <div className="adapt-card !p-0 overflow-hidden">
        <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-3 bg-gray-900">
          <div className="flex gap-1">
            <button
              onClick={() => setTraceView('waterfall')}
              className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${traceView === 'waterfall' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >Waterfall</button>
            <button
              onClick={() => setTraceView('flame')}
              className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${traceView === 'flame' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >Flame</button>
          </div>
          {traceView === 'waterfall' && criticalPath.size > 0 && criticalPath.size < spans.length && (
            <label className="ml-3 inline-flex items-center gap-1.5 text-tiny text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={criticalPathOnly}
                onChange={(e) => setCriticalPathOnly(e.target.checked)}
                className="accent-active"
              />
              Critical path only
            </label>
          )}
          {traceView === 'waterfall' && errorSpanIds.size > 0 && errorSpanIds.size < spans.length && (
            <label className="ml-3 inline-flex items-center gap-1.5 text-tiny text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={(e) => setErrorsOnly(e.target.checked)}
                className="accent-active"
              />
              Errors only
              <span className="adapt-badge-danger" title={`${errorSpanIds.size} error span${errorSpanIds.size === 1 ? '' : 's'} in this trace`}>
                {errorSpanIds.size}
              </span>
            </label>
          )}
          {traceView === 'waterfall' && collapsibleIds.size > 0 && (
            <div className="ml-3 inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCollapsedIds(new Set())}
                disabled={collapsedIds.size === 0}
                title="Expand every collapsed subtree"
                className="px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-40 disabled:hover:bg-gray-800 disabled:hover:text-gray-400 disabled:cursor-not-allowed"
              >Expand all</button>
              <button
                type="button"
                onClick={() => setCollapsedIds(new Set(collapsibleIds))}
                disabled={allCollapsed}
                title="Collapse every subtree down to the root spans"
                className="px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-40 disabled:hover:bg-gray-800 disabled:hover:text-gray-400 disabled:cursor-not-allowed"
              >Collapse all</button>
            </div>
          )}
          {traceView === 'waterfall' && (
            <div className="flex items-center gap-1.5 ml-4">
              <input
                type="text"
                placeholder="Find in spans..."
                value={spanSearchQuery}
                onChange={(e) => setSpanSearchQuery(e.target.value)}
                className="bg-gray-1000 border border-gray-800 rounded px-2 py-0.5 text-tiny text-gray-100 focus:outline-none focus:border-link max-w-[12rem] transition-colors"
              />
              {spanSearchQuery && (
                <>
                  {/* Explicit hit count so an all-dimmed list reads as "0
                      matching" rather than looking broken. */}
                  <span
                    className={`text-tiny tabular-nums whitespace-nowrap ${spanMatchCount > 0 ? 'text-gray-400' : 'text-warning'}`}
                  >
                    {spanMatchCount} match{spanMatchCount === 1 ? '' : 'es'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSpanSearchQuery('')}
                    className="text-gray-500 hover:text-gray-300 text-tiny"
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
          <span className="ml-auto text-tiny text-gray-500">
            {traceView === 'waterfall' ? (() => {
              const passesFilters = (spanId: string) =>
                (!criticalPathOnly || criticalPath.has(spanId)) && (!errorsOnlyKeep || errorsOnlyKeep.has(spanId));
              const shown = visibleOrdered.filter(o => passesFilters(o.span.spanId)).length;
              const hidden = ordered.length - shown;
              return hidden > 0 ? `${shown} spans • ${hidden} hidden` : `${shown} spans`;
            })() : `${spans.length} spans • aggregated by depth`}
          </span>
        </div>
        {traceView === 'waterfall' ? (
          <>
            <div className="px-4 py-2 border-b border-gray-800 text-tiny font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-3">
              <span className="w-[28rem]">Span</span>
              <span className="flex-1">Timeline</span>
              <span className="w-20 text-right">Duration</span>
            </div>
            <div className="divide-y divide-gray-800">
              {visibleOrdered.filter(o => (!criticalPathOnly || criticalPath.has(o.span.spanId)) && (!errorsOnlyKeep || errorsOnlyKeep.has(o.span.spanId))).map(({ span, depth }) => {
                const descendantCount = descendantCountById.get(span.spanId) || 0;
                return (
                  <SpanRow
                    key={`${span.spanId}-${span.traceId}`}
                    span={span}
                    depth={depth}
                    traceStartNs={traceStartNs}
                    traceDurationNs={traceDurationNs}
                    logs={logsBySpan.get(span.spanId) || []}
                    isOnCriticalPath={criticalPath.has(span.spanId)}
                    criticalInterval={criticalIntervals.get(span.spanId) || null}
                    descendantCount={descendantCount}
                    isCollapsed={collapsedIds.has(span.spanId)}
                    onToggleCollapsed={descendantCount > 0 ? () => toggleCollapsed(span.spanId) : null}
                    isHighlighted={isSpanHighlighted(span)}
                    isDimmed={isSpanDimmed(span)}
                  />
                );
              })}
            </div>
          </>
        ) : (
          <FlameView
            spans={spans}
            traceStartNs={traceStartNs}
            traceDurationNs={traceDurationNs}
            criticalPath={criticalPath}
          />
        )}
      </div>

      {logsAtTraceLevel.length > 0 && (
        <div className="mt-4">
          <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Trace-level log records ({logsAtTraceLevel.length})
          </div>
          <div className="adapt-card !p-3 space-y-1.5">
            {logsAtTraceLevel.map(l => (
              <LogLine key={l.id} log={l} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
