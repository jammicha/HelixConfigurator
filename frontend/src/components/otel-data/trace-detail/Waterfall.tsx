import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Clock, Database, Repeat, Server } from 'lucide-react';
import type { LogRecord, SpanDetail, TraceDetail } from '../types';
import { useSlowThreshold } from '../SlowThresholdContext';
import { detectNPlusOne, formatDuration } from '../utils';
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
  const headerTone = tone === 'danger' ? 'text-[#ff8a8a]' : tone === 'warning' ? 'text-warning' : 'text-active';
  return (
    <div className="adapt-card !p-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2 bg-gray-900">
        <span className={headerTone}>{icon}</span>
        <span className="text-sm font-semibold text-gray-200">{title}</span>
        <span className="text-tiny text-gray-500 ml-auto">{subtitle}</span>
      </div>
      <table className="w-full text-tiny">
        <thead>
          <tr className="text-left text-gray-500 uppercase tracking-wider">
            {columns.map((c, i) => (
              <th key={c} className={`px-3 py-1 font-semibold ${i === 0 ? '' : 'text-right'}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className="border-t border-gray-800">
              {r.cells.map((c, i) => (
                <td key={i} className={`px-3 py-1 ${i === 0 ? 'text-gray-200' : 'text-right text-gray-300 tabular-nums'}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && (
        <div className="px-3 py-1.5 border-t border-gray-800 text-tiny text-gray-500 bg-gray-1000">{footer}</div>
      )}
    </div>
  );
};

const ServiceBreakdownPanel: React.FC<{
  breakdown: { name: string; totalMs: number }[];
  traceDurationMs: number;
}> = ({ breakdown, traceDurationMs }) => {
  const total = breakdown.reduce((acc, b) => acc + b.totalMs, 0);
  // Use the larger of trace duration vs sum-of-services for the denominator
  // — a perfectly serial trace will sum to ~trace duration, but a heavily
  // parallel one can sum to more (each parallel branch counts) and we still
  // want each segment proportional.
  const denom = Math.max(traceDurationMs, total);
  return (
    <div className="adapt-card !p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <Server className="w-3.5 h-3.5 text-active" />
        <span className="text-sm font-semibold text-gray-200">Service breakdown</span>
        <span className="text-tiny text-gray-500 ml-auto">where the time went</span>
      </div>
      <div className="flex h-6 rounded overflow-hidden border border-gray-800 bg-gray-1000">
        {breakdown.map(b => {
          const w = (b.totalMs / denom) * 100;
          if (w < 0.5) return null;
          return (
            <div
              key={b.name}
              style={{ width: `${w}%`, backgroundColor: colorForService(b.name) }}
              title={`${b.name}: ${formatDuration(b.totalMs)} (${(b.totalMs / denom * 100).toFixed(1)}%)`}
              className="brightness-90 hover:brightness-110 transition-[filter]"
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-tiny">
        {breakdown.map(b => (
          <div key={b.name} className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: colorForService(b.name) }} />
            <span className="text-gray-300">{b.name}</span>
            <span className="text-gray-500 tabular-nums">{formatDuration(b.totalMs)}</span>
            <span className="text-gray-600">({(b.totalMs / denom * 100).toFixed(0)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const Waterfall: React.FC<{ detail: TraceDetail; logs: LogRecord[] }> = ({ detail, logs }) => {
  const { spans, summary } = detail;
  const slowThresholdMs = useSlowThreshold();
  const [criticalPathOnly, setCriticalPathOnly] = useState(false);
  const [traceView, setTraceView] = useState<'waterfall' | 'flame'>('waterfall');
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
        <ServiceBreakdownPanel breakdown={serviceBreakdown} traceDurationMs={serviceBreakdownDenom} />
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
              rows={sqlRollup.slice(0, 10).map(b => ({
                key: b.key,
                cells: [
                  <span className="font-mono text-tiny truncate inline-block max-w-[24rem]" title={b.display}>
                    <span className="text-gray-500">{b.system}: </span>{b.display}
                  </span>,
                  String(b.count),
                  formatDuration(b.totalMs),
                  <span className={b.maxMs > slowThresholdMs ? 'text-warning font-semibold' : ''}>{formatDuration(b.maxMs)}</span>,
                ],
              }))}
              footer={sqlRollup.length > 10 ? `+ ${sqlRollup.length - 10} more` : null}
            />
          )}
          {httpRollup.length > 0 && (
            <RollupPanel
              icon={<Activity className="w-3.5 h-3.5" />}
              title="HTTP outbound"
              subtitle={`${httpTotalCount} call${httpTotalCount === 1 ? '' : 's'} • ${formatDuration(httpTotalMs)} total`}
              tone={httpHasError ? 'danger' : httpRollup.some(b => b.maxMs > slowThresholdMs) ? 'warning' : 'info'}
              columns={['Endpoint', 'Count', 'Total', 'Status']}
              rows={httpRollup.slice(0, 10).map(b => ({
                key: b.key,
                cells: [
                  <span className="font-mono text-tiny truncate inline-block max-w-[24rem]" title={`${b.method} ${b.url}`}>
                    <span className="text-gray-500">{b.method || '?'} </span>{b.url || '(no url)'}
                  </span>,
                  String(b.count),
                  formatDuration(b.totalMs),
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
              footer={httpRollup.length > 10 ? `+ ${httpRollup.length - 10} more` : null}
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
          <span className="ml-auto text-tiny text-gray-500">
            {traceView === 'waterfall' ? (() => {
              const shown = visibleOrdered.filter(o => !criticalPathOnly || criticalPath.has(o.span.spanId)).length;
              const hidden = ordered.length - visibleOrdered.length;
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
              {visibleOrdered.filter(o => !criticalPathOnly || criticalPath.has(o.span.spanId)).map(({ span, depth }) => {
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
