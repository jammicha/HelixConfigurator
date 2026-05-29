import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Database, ExternalLink, FileText, Loader2, Play, Server, X } from 'lucide-react';
import { TimelineChart, TIMELINE_COLORS } from '../TimelineChart';
import { BmcChevron } from './BmcChevron';
import { StatusPill } from './StatusPill';
import { MIN_DURATION_PRESETS } from './constants';
import { useSlowThreshold } from './SlowThresholdContext';
import { buildHelixTraceUrl, formatDuration, formatRelative, hasRealHelixEndpoint, serviceTraceView } from './utils';
import { useSyntheticRun } from '../../hooks/useSyntheticRun';
import type { HelixEnv, Histogram, TraceStatus, TraceSummary } from './types';

export const TracesTab: React.FC<{
  traces: TraceSummary[];
  services: { name: string; traceCount: number }[];
  serviceFilter: string;
  setServiceFilter: (s: string) => void;
  // Read-only — namespace/container dropdowns live in the page-level top
  // bar (visible from every tab). These values flow through here only so
  // the empty-state copy can accurately say "no traces match your filters"
  // when one of those filters is engaged.
  namespaceFilter: string;
  containerFilter: string;
  statusFilter: '' | TraceStatus;
  setStatusFilter: (s: '' | TraceStatus) => void;
  searchQuery: string;
  setSearchQuery: (s: string) => void;
  minMs: number;
  setMinMs: (n: number) => void;
  helixEnv: HelixEnv | null;
  operationP95: Map<string, number>;
  tracesLoading: boolean;
  onSelect: (traceId: string) => void;
  histogram: Histogram | null;
  customRange: { sinceMs: number; untilMs: number } | null;
  onBucketClick: (sinceMs: number, untilMs: number) => void;
  onClearCustomRange: () => void;
}> = ({
  traces, services, serviceFilter, setServiceFilter,
  namespaceFilter, containerFilter,
  statusFilter, setStatusFilter,
  searchQuery, setSearchQuery, minMs, setMinMs,
  helixEnv, operationP95, tracesLoading, onSelect,
  histogram, customRange, onBucketClick, onClearCustomRange,
}) => {
  const slowThresholdMs = useSlowThreshold();
  // Column sort. Default 'received' desc matches the SSE merge order; opting
  // into 'duration' / 'spans' is a deliberate analytical re-sort.
  type SortKey = 'received' | 'duration' | 'spans';
  const [sortKey, setSortKey] = useState<SortKey>('received');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };
  const sortedTraces = useMemo(() => {
    const arr = traces.slice();
    const cmp = (a: TraceSummary, b: TraceSummary) => {
      switch (sortKey) {
        case 'duration': return b.duration_ms - a.duration_ms;
        case 'spans': return (b.span_count || 0) - (a.span_count || 0);
        case 'received': return b.received_at - a.received_at;
      }
    };
    arr.sort(cmp);
    if (sortDir === 'asc') arr.reverse();
    return arr;
  }, [traces, sortKey, sortDir]);
  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'desc' ? ' ▾' : ' ▴') : '';
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-end gap-3 mb-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Service</label>
          <select
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-link min-w-[14rem]"
          >
            <option value="">All services</option>
            {services.map(s => (
              <option key={s.name} value={s.name}>{s.name} ({s.traceCount})</option>
            ))}
            {/* The Service list is narrowed by the active namespace/container.
                If the user picked a service and then a namespace that excludes
                it, render a self-referential option so the filter stays
                visible and clearable — same pattern as the Namespace dropdown
                in the page top bar. */}
            {serviceFilter && !services.some(s => s.name === serviceFilter) && (
              <option value={serviceFilter}>{serviceFilter} (stale)</option>
            )}
          </select>
        </div>
        {/*
          Namespace + Container filters were here originally but moved to the
          page-level top bar so Overview, Operations, and Logs/Errors share
          the same picker. The empty-state filtered flag below still checks
          namespaceFilter/containerFilter so the "no traces match your
          filters" copy stays accurate when one of those is engaged.
        */}
        <div className="flex flex-col gap-1">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | TraceStatus)}
            className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-link"
          >
            <option value="">All statuses</option>
            <option value="error">Error</option>
            <option value="slow">Slow (&gt;{slowThresholdMs}ms)</option>
            <option value="ok">OK</option>
            <option value="outlier">Outlier (&gt;2× p95)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Min duration</label>
          <select
            value={String(minMs)}
            onChange={(e) => setMinMs(parseInt(e.target.value, 10) || 0)}
            className={`bg-gray-1000 border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-link ${
              minMs > 0 ? 'border-warning/60 text-warning' : 'border-gray-800 text-gray-100'
            }`}
          >
            {MIN_DURATION_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
            {/* Custom value from URL state or drag-zoom that doesn't match a
                preset — render as its own option so the select doesn't silently
                fall back to "Any duration" and hide an active filter. */}
            {minMs > 0 && !MIN_DURATION_PRESETS.some(p => p.value === minMs) && (
              <option value={minMs}>≥ {minMs}ms (custom)</option>
            )}
          </select>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[16rem]">
          <label htmlFor="traces-search" className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Search</label>
          <div className="relative">
            <input
              id="traces-search"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="operation, service, or trace id…"
              className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-link pr-8"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="ml-auto text-tiny text-gray-500 pb-1">
          {(() => {
            const windowTotal = histogram?.buckets.reduce((a, b) => a + (b.total || 0), 0) ?? null;
            if (windowTotal != null && windowTotal > traces.length) {
              return <>{traces.length} of {windowTotal.toLocaleString()} traces in window <span className="text-gray-600" title="The table shows the most recent matching traces (server-capped). The volume chart counts everything in the window.">· most recent shown</span></>;
            }
            return <>{traces.length} trace{traces.length === 1 ? '' : 's'}</>;
          })()}
        </div>
      </div>

      {histogram && histogram.buckets.length > 0 && (
        <div className="adapt-card !p-3 mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Trace volume</div>
            {customRange && (
              <button
                onClick={onClearCustomRange}
                className="text-tiny text-link hover:underline font-semibold"
              >Clear time selection</button>
            )}
          </div>
          <TimelineChart
            buckets={histogram.buckets as any}
            bucketSizeMs={histogram.bucketSizeMs}
            height={84}
            segments={[
              { key: 'ok', label: 'OK', fill: TIMELINE_COLORS.ok },
              { key: 'slow', label: 'Slow', fill: TIMELINE_COLORS.slow },
              { key: 'error', label: 'Error', fill: TIMELINE_COLORS.error },
            ]}
            percentiles={histogram.buckets.map(b => ({ p50: b.p50 ?? null, p95: b.p95 ?? null }))}
            selectedRange={customRange}
            onBucketClick={onBucketClick}
            onRangeSelect={onBucketClick}
          />
        </div>
      )}

      {serviceFilter && (
        <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
          Traces for <span className="font-mono text-gray-100 normal-case tracking-normal">{serviceFilter}</span>
        </div>
      )}
      <div className="flex-1 overflow-auto adapt-card !p-0">
        {tracesLoading ? (
          <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading traces…
          </div>
        ) : traces.length === 0 ? (
          <TracesEmptyState filtered={!!serviceFilter || !!namespaceFilter || !!containerFilter || !!statusFilter || !!searchQuery || minMs > 0} />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
              <tr className="text-left text-tiny text-gray-400 uppercase tracking-wider">
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Service</th>
                <th className="px-4 py-2 font-semibold">{serviceFilter ? 'Operation' : 'Root operation'}</th>
                <th className="px-4 py-2 font-semibold text-right">
                  <button
                    onClick={() => handleSort('duration')}
                    className={`uppercase tracking-wider font-semibold ${sortKey === 'duration' ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
                  >Duration{sortIndicator('duration')}</button>
                </th>
                <th className="px-4 py-2 font-semibold text-right">
                  <button
                    onClick={() => handleSort('spans')}
                    className={`uppercase tracking-wider font-semibold ${sortKey === 'spans' ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
                  >Spans{sortIndicator('spans')}</button>
                </th>
                <th className="px-4 py-2 font-semibold">
                  <button
                    onClick={() => handleSort('received')}
                    className={`uppercase tracking-wider font-semibold ${sortKey === 'received' ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
                  >Received{sortIndicator('received')}</button>
                </th>
                {hasRealHelixEndpoint(helixEnv) && <th className="px-4 py-2 font-semibold w-10" aria-label="Helix" />}
              </tr>
            </thead>
            <tbody>
              {sortedTraces.map(t => {
                // When a service is selected, render the row from that service's
                // perspective — its entry span's operation/duration/status —
                // instead of the trace root. Falls back to root fields if the
                // backend didn't resolve an entry span (shouldn't happen for a
                // matched trace, but keeps the row well-formed).
                // Single source of truth with the page-level Status / Min-
                // duration / Outlier filters (serviceTraceView): when a service
                // is selected the row reflects that service's entry span, and
                // those filters classify by the same fields so they can't drift
                // (the bug where an Error filter showed OK rows).
                const v = serviceTraceView(t, serviceFilter, slowThresholdMs);
                const displayService = v.service;
                const displayOperation = v.operation;
                const displayDuration = v.durationMs;
                const displayStartNs = v.startNs;
                // Hand the pill an explicit status only under a service filter;
                // unfiltered, StatusPill derives the trace-level verdict itself,
                // so the no-service render is unchanged.
                const svcStatus: TraceStatus | undefined = serviceFilter ? v.status : undefined;
                const p95 = operationP95.get(`${displayService}|${displayOperation}`) || 0;
                return (
                <tr
                  key={t.trace_id}
                  onClick={() => onSelect(t.trace_id)}
                  className="border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2">
                    <StatusPill trace={t} status={svcStatus} />
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-100">
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      <Server className="w-3.5 h-3.5 text-gray-500" />
                      {displayService}
                      {(t.error_count || 0) > 0 && (
                        <span
                          className="adapt-badge-danger flex-shrink-0 inline-flex items-center gap-1"
                          title={`${t.error_count} error${t.error_count === 1 ? '' : 's'} in this trace`}
                        >
                          <AlertTriangle className="w-2.5 h-2.5" />{t.error_count}
                        </span>
                      )}
                      {(t.db_call_count || 0) > 0 && (
                        <span
                          className="adapt-badge-info flex-shrink-0 inline-flex items-center gap-1"
                          title={`${t.db_call_count} DB call${t.db_call_count === 1 ? '' : 's'} in this trace`}
                        >
                          <Database className="w-2.5 h-2.5" />{t.db_call_count}
                        </span>
                      )}
                      {(t.log_count || 0) > 0 && (
                        <span
                          className="adapt-badge-info flex-shrink-0 inline-flex items-center gap-1"
                          title={`${t.log_count} log record${t.log_count === 1 ? '' : 's'} in this trace`}
                        >
                          <FileText className="w-2.5 h-2.5" />{t.log_count}
                        </span>
                      )}
                      {p95 > 0 && displayDuration > p95 * 2 && (
                        <span
                          className="adapt-badge-warning flex-shrink-0 inline-flex items-center gap-1"
                          title={`Outlier: ${formatDuration(displayDuration)} is ${(displayDuration / p95).toFixed(1)}× this operation's p95 (${formatDuration(p95)})`}
                        >
                          <AlertTriangle className="w-2.5 h-2.5" />Outlier
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-300 text-tiny">
                    <button
                      onClick={(e) => { e.stopPropagation(); setSearchQuery(displayOperation); }}
                      title="Filter list to this operation"
                      className="text-left hover:text-link hover:underline truncate max-w-md"
                    >
                      {displayOperation}
                    </button>
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums ${displayDuration > slowThresholdMs ? 'text-warning font-semibold' : 'text-gray-300'}`}>
                    {formatDuration(displayDuration)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-400">{t.span_count}</td>
                  <td className="px-4 py-2 text-tiny text-gray-500">{formatRelative(t.received_at)}</td>
                  {hasRealHelixEndpoint(helixEnv) && (
                    <td className="px-4 py-2 text-right">
                      {(() => {
                        const url = buildHelixTraceUrl(helixEnv, {
                          traceId: t.trace_id,
                          serviceName: displayService,
                          timeNs: displayStartNs,
                          namespace: t.service_namespace,
                        });
                        if (!url) return null;
                        return (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open this trace in Helix"
                            className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-200"
                          >
                            <BmcChevron className="h-3.5 w-auto" />
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        );
                      })()}
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const TracesEmptyState: React.FC<{ filtered: boolean }> = ({ filtered }) => {
  // Only fire the synthetic-run hook in the unfiltered "no data anywhere"
  // branch — when filtered=true the user has data, just nothing matching,
  // and a generate-data CTA would be misleading.
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
        <Activity className="w-6 h-6 text-gray-500" />
      </div>
      <h3 className="text-base font-semibold text-gray-200 mb-2">
        {filtered ? 'No traces match these filters' : 'No traces received yet'}
      </h3>
      <p className="text-sm text-gray-400 max-w-md mb-3 leading-relaxed">
        {filtered ? (
          <>Try widening the time range, or clear the service filter to see all traces.</>
        ) : (
          <>Send traffic to your instrumented application. Spans will stream in here within a few seconds of arriving at the gateway.</>
        )}
      </p>
      {!filtered && (
        <>
          <p className="text-tiny text-gray-500 max-w-md leading-relaxed">
            Reminder: your application should be exporting OpenTelemetry traces to{' '}
            <code className="font-mono text-gray-300 bg-gray-1000 px-1.5 py-0.5 rounded">helix-gateway:4318</code>{' '}
            (HTTP) or <code className="font-mono text-gray-300 bg-gray-1000 px-1.5 py-0.5 rounded">helix-gateway:4317</code> (gRPC).
          </p>
          <SyntheticGenerateAffordance />
        </>
      )}
    </div>
  );
};

// "Or generate synthetic traces" CTA — only rendered inside the unfiltered
// empty state above. Same scenario the Step 0 page uses (60-second burst,
// ~service.namespace=Helix-Configurator-Demo), so the data appears in this
// table without any filter switching once spans arrive at the gateway.
// Reuses useSyntheticRun so this CTA reflects a run already in flight from
// /step-zero or the Overview tab.
const SyntheticGenerateAffordance: React.FC = () => {
  const { status, starting, startError, start } = useSyntheticRun();
  const isRunning = !!status?.running;

  return (
    <div className="mt-6 pt-6 border-t border-gray-800 max-w-md w-full">
      <p className="text-tiny text-gray-500 mb-2">No app to instrument yet?</p>
      {isRunning ? (
        <div className="inline-flex items-center gap-2 text-tiny text-gray-300">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-300" />
          Generating synthetic traces — {status!.sent_traces} sent
          {status!.eta_s != null && <> · {status!.eta_s}s remaining</>}
        </div>
      ) : (
        <button
          onClick={() => start()}
          disabled={starting}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-tiny rounded font-semibold bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60"
          title="Run a 60-second burst of realistic e-commerce traces. They'll appear here within a few seconds."
        >
          {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Generate synthetic traces
        </button>
      )}
      {startError && <p className="mt-2 text-tiny text-danger-text">{startError}</p>}
    </div>
  );
};
