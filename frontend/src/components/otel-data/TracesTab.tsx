import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Database, ExternalLink, FileText, Loader2, Server, X } from 'lucide-react';
import { TimelineChart, TIMELINE_COLORS } from '../TimelineChart';
import { BmcChevron } from './BmcChevron';
import { StatusPill } from './StatusPill';
import { MIN_DURATION_PRESETS, SLOW_THRESHOLD_MS } from './constants';
import { buildHelixTraceUrl, formatDuration, formatRelative } from './utils';
import type { HelixEnv, Histogram, TraceStatus, TraceSummary } from './types';

export const TracesTab: React.FC<{
  traces: TraceSummary[];
  services: { name: string; traceCount: number }[];
  serviceFilter: string;
  setServiceFilter: (s: string) => void;
  statusFilter: '' | TraceStatus;
  setStatusFilter: (s: '' | TraceStatus) => void;
  searchQuery: string;
  setSearchQuery: (s: string) => void;
  minMs: number;
  setMinMs: (n: number) => void;
  paused: boolean;
  setPaused: React.Dispatch<React.SetStateAction<boolean>>;
  streamConnected: boolean;
  helixEnv: HelixEnv | null;
  operationP95: Map<string, number>;
  tracesLoading: boolean;
  onSelect: (traceId: string) => void;
  histogram: Histogram | null;
  customRange: { sinceMs: number; untilMs: number } | null;
  onBucketClick: (sinceMs: number, untilMs: number) => void;
  onClearCustomRange: () => void;
}> = ({
  traces, services, serviceFilter, setServiceFilter, statusFilter, setStatusFilter,
  searchQuery, setSearchQuery, minMs, setMinMs,
  paused, setPaused, streamConnected, helixEnv, operationP95, tracesLoading, onSelect,
  histogram, customRange, onBucketClick, onClearCustomRange,
}) => {
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
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Stream</label>
          <button
            onClick={() => setPaused(p => !p)}
            title={paused ? 'Resume live updates' : 'Pause incoming traces so the list stops moving'}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border bg-gray-1000 text-tiny uppercase tracking-wider font-semibold transition-colors ${
              paused
                ? 'border-warning/40 text-warning hover:border-warning'
                : streamConnected
                  ? 'border-gray-800 text-[#5eead4] hover:border-success/40'
                  : 'border-gray-800 text-gray-500 hover:text-gray-300'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${
              paused ? 'bg-warning' : streamConnected ? 'bg-success animate-pulse' : 'bg-gray-600'
            }`} />
            {paused ? 'Paused' : streamConnected ? 'Live' : 'Reconnecting…'}
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Service</label>
          <select
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active min-w-[14rem]"
          >
            <option value="">All services</option>
            {services.map(s => (
              <option key={s.name} value={s.name}>{s.name} ({s.traceCount})</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | TraceStatus)}
            className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active"
          >
            <option value="">All statuses</option>
            <option value="error">Error</option>
            <option value="slow">Slow (&gt;{SLOW_THRESHOLD_MS}ms)</option>
            <option value="ok">OK</option>
            <option value="outlier">Outlier (&gt;2× p95)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Min duration</label>
          <select
            value={String(minMs)}
            onChange={(e) => setMinMs(parseInt(e.target.value, 10) || 0)}
            className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active"
          >
            {MIN_DURATION_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[16rem]">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Search</label>
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="operation, service, or trace id…"
              className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active pr-8"
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
          {traces.length} trace{traces.length === 1 ? '' : 's'} • cap 500 (sliding window)
        </div>
      </div>

      {histogram && histogram.buckets.length > 0 && (
        <div className="adapt-card !p-3 mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Trace volume</div>
            {customRange && (
              <button
                onClick={onClearCustomRange}
                className="text-tiny text-active hover:underline font-semibold"
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

      <div className="flex-1 overflow-auto adapt-card !p-0">
        {tracesLoading ? (
          <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading traces…
          </div>
        ) : traces.length === 0 ? (
          <TracesEmptyState filtered={!!serviceFilter || !!statusFilter || !!searchQuery || minMs > 0} />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
              <tr className="text-left text-tiny text-gray-400 uppercase tracking-wider">
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Service</th>
                <th className="px-4 py-2 font-semibold">Root operation</th>
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
                {helixEnv?.endpoint && <th className="px-4 py-2 font-semibold w-10" aria-label="Helix" />}
              </tr>
            </thead>
            <tbody>
              {sortedTraces.map(t => (
                <tr
                  key={t.trace_id}
                  onClick={() => onSelect(t.trace_id)}
                  className="border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2">
                    <StatusPill trace={t} />
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-100">
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      <Server className="w-3.5 h-3.5 text-gray-500" />
                      {t.service_name}
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
                      {(() => {
                        const p95 = operationP95.get(`${t.service_name}|${t.root_operation}`) || 0;
                        if (p95 > 0 && t.duration_ms > p95 * 2) {
                          return (
                            <span
                              className="adapt-badge-warning flex-shrink-0 inline-flex items-center gap-1"
                              title={`Outlier — ${formatDuration(t.duration_ms)} is ${(t.duration_ms / p95).toFixed(1)}× this operation's p95 (${formatDuration(p95)})`}
                            >
                              <AlertTriangle className="w-2.5 h-2.5" />Outlier
                            </span>
                          );
                        }
                        return null;
                      })()}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-300 font-mono text-tiny">
                    <button
                      onClick={(e) => { e.stopPropagation(); setSearchQuery(t.root_operation || ''); }}
                      title="Filter list to this operation"
                      className="text-left hover:text-active hover:underline truncate max-w-md"
                    >
                      {t.root_operation}
                    </button>
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${t.duration_ms > SLOW_THRESHOLD_MS ? 'text-warning font-semibold' : 'text-gray-300'}`}>
                    {formatDuration(t.duration_ms)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-gray-400">{t.span_count}</td>
                  <td className="px-4 py-2 text-tiny text-gray-500">{formatRelative(t.received_at)}</td>
                  {helixEnv?.endpoint && (
                    <td className="px-4 py-2 text-right">
                      {(() => {
                        const url = buildHelixTraceUrl(helixEnv, {
                          traceId: t.trace_id,
                          serviceName: t.service_name,
                          timeNs: t.start_time_ns,
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
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const TracesEmptyState: React.FC<{ filtered: boolean }> = ({ filtered }) => (
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
      <p className="text-tiny text-gray-500 max-w-md leading-relaxed">
        Reminder: your application should be exporting OpenTelemetry traces to{' '}
        <code className="font-mono text-gray-300 bg-gray-1000 px-1.5 py-0.5 rounded">helix-gateway:4318</code>{' '}
        (HTTP) or <code className="font-mono text-gray-300 bg-gray-1000 px-1.5 py-0.5 rounded">helix-gateway:4317</code> (gRPC).
      </p>
    )}
  </div>
);
