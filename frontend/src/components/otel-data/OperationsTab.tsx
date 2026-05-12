import React, { useMemo, useState } from 'react';
import { Loader2, Server } from 'lucide-react';
import { SLOW_THRESHOLD_MS, TIME_RANGES } from './constants';
import { formatDuration } from './utils';
import type { OperationStat, TimeRange } from './types';

export const OperationsTab: React.FC<{
  operations: OperationStat[];
  loading: boolean;
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  onJumpToOperation: (op: string) => void;
}> = ({ operations, loading, range, setRange, onJumpToOperation }) => {
  const [sortBy, setSortBy] = useState<'p95' | 'p50' | 'max' | 'count' | 'errors' | 'slow' | 'service'>('p95');
  const sorted = useMemo(() => {
    const arr = operations.slice();
    switch (sortBy) {
      case 'p95': arr.sort((a, b) => b.p95_ms - a.p95_ms); break;
      case 'p50': arr.sort((a, b) => b.p50_ms - a.p50_ms); break;
      case 'max': arr.sort((a, b) => b.max_ms - a.max_ms); break;
      case 'count': arr.sort((a, b) => b.trace_count - a.trace_count); break;
      case 'errors': arr.sort((a, b) => (b.error_count / Math.max(1, b.trace_count)) - (a.error_count / Math.max(1, a.trace_count))); break;
      case 'slow': arr.sort((a, b) => (b.slow_count / Math.max(1, b.trace_count)) - (a.slow_count / Math.max(1, a.trace_count))); break;
      case 'service': arr.sort((a, b) => a.service_name.localeCompare(b.service_name) || a.root_operation.localeCompare(b.root_operation)); break;
    }
    return arr;
  }, [operations, sortBy]);

  // Grafana-style color-by-value: subtle bg tint based on duration / error %
  // thresholds. Stays on ADAPT palette (success / warning / danger muted) so
  // the visual signal is readable without bright fills.
  const latencyTone = (ms: number): string => {
    if (ms <= 200) return 'bg-success/10 text-success';
    if (ms <= SLOW_THRESHOLD_MS) return 'bg-warning/10 text-warning';
    return 'bg-danger/15 text-[#ff8a8a]';
  };
  const errorPctTone = (pct: number): string => {
    if (pct <= 0) return 'text-gray-500';
    if (pct < 1) return 'bg-warning/10 text-warning';
    if (pct < 5) return 'bg-warning/15 text-warning';
    return 'bg-danger/20 text-[#ff8a8a]';
  };
  const slowPctTone = (pct: number): string => {
    if (pct <= 0) return 'text-gray-500';
    if (pct < 5) return 'bg-warning/5 text-warning';
    if (pct < 25) return 'bg-warning/15 text-warning';
    return 'bg-danger/15 text-[#ff8a8a]';
  };

  const Sortable: React.FC<{ id: typeof sortBy; align?: 'left' | 'right'; children: React.ReactNode }> = ({ id, align = 'right', children }) => (
    <button
      onClick={() => setSortBy(id)}
      className={`w-full ${align === 'right' ? 'text-right' : 'text-left'} font-semibold uppercase tracking-wider text-tiny ${sortBy === id ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
    >
      {children}{sortBy === id && ' ▾'}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-end gap-3 mb-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Time range</label>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as TimeRange)}
            className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active"
          >
            {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="ml-auto text-tiny text-gray-500 pb-1">
          {operations.length} operation{operations.length === 1 ? '' : 's'}
        </div>
      </div>
      <div className="flex-1 overflow-auto adapt-card !p-0">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading operations…
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
            <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
              <Server className="w-6 h-6 text-gray-500" />
            </div>
            <h3 className="text-base font-semibold text-gray-200 mb-2">No operations in this window</h3>
            <p className="text-sm text-gray-400 max-w-md leading-relaxed">
              Aggregates over root-span (service + operation) for the selected time range. Widen the range above to see more.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
              <tr>
                <th className="px-4 py-2"><Sortable id="service" align="left">Service · Operation</Sortable></th>
                <th className="px-4 py-2 w-20"><Sortable id="count">Count</Sortable></th>
                <th className="px-4 py-2 w-24"><Sortable id="p50">p50</Sortable></th>
                <th className="px-4 py-2 w-24"><Sortable id="p95">p95</Sortable></th>
                <th className="px-4 py-2 w-24"><Sortable id="max">Max</Sortable></th>
                <th className="px-4 py-2 w-24"><Sortable id="errors">Error %</Sortable></th>
                <th className="px-4 py-2 w-24"><Sortable id="slow">Slow</Sortable></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(op => {
                const errPct = op.trace_count ? (op.error_count / op.trace_count) * 100 : 0;
                const slowPct = op.trace_count ? (op.slow_count / op.trace_count) * 100 : 0;
                return (
                  <tr key={`${op.service_name}|${op.root_operation}`} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => onJumpToOperation(op.root_operation)}
                        title="Filter the trace list to this operation"
                        className="text-left hover:underline"
                      >
                        <span className="text-gray-200 font-mono">{op.service_name}</span>
                        <span className="text-gray-500"> · </span>
                        <span className="text-gray-300 font-mono text-tiny">{op.root_operation}</span>
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-300">{op.trace_count}</td>
                    <td className={`px-4 py-2 text-right font-mono ${latencyTone(op.p50_ms)}`}>{formatDuration(op.p50_ms)}</td>
                    <td className={`px-4 py-2 text-right font-mono font-semibold ${latencyTone(op.p95_ms)}`}>{formatDuration(op.p95_ms)}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-400">{formatDuration(op.max_ms)}</td>
                    <td className={`px-4 py-2 text-right font-mono ${errorPctTone(errPct)}`}>
                      {errPct > 0 ? `${errPct.toFixed(1)}%` : '—'}
                      <span className="text-tiny opacity-70 ml-1">({op.error_count})</span>
                    </td>
                    <td className={`px-4 py-2 text-right font-mono ${slowPctTone(slowPct)}`}>
                      {slowPct > 0 ? `${slowPct.toFixed(1)}%` : '—'}
                      <span className="text-tiny opacity-70 ml-1">({op.slow_count})</span>
                    </td>
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
