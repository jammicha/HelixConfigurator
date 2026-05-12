import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, X } from 'lucide-react';
import { TimelineChart, TIMELINE_COLORS } from '../TimelineChart';
import { BmcChevron } from './BmcChevron';
import { SEVERITY_OPTIONS } from './constants';
import { buildHelixTraceUrl, formatRelative, formatTime, normalizeSeverity, severityBadgeClass } from './utils';
import type { ErrorRecord, HelixEnv, Histogram, LogRecord } from './types';

export const LogsAndErrorsTab: React.FC<{
  logs: LogRecord[];
  errors: ErrorRecord[];
  paused: boolean;
  setPaused: React.Dispatch<React.SetStateAction<boolean>>;
  streamConnected: boolean;
  helixEnv: HelixEnv | null;
  onJumpToTrace: (traceId: string) => void;
  histogram: Histogram | null;
  customRange: { sinceMs: number; untilMs: number } | null;
  onBucketClick: (sinceMs: number, untilMs: number) => void;
  onClearCustomRange: () => void;
}> = ({ logs, errors, paused, setPaused, streamConnected, helixEnv, onJumpToTrace, histogram, customRange, onBucketClick, onClearCustomRange }) => {
  const [subTab, setSubTab] = useState<'logs' | 'errors'>('logs');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [logQuery, setLogQuery] = useState<string>('');

  const filteredLogs = useMemo(() => {
    let out = logs;
    if (severityFilter) out = out.filter(l => normalizeSeverity(l.severity) === severityFilter);
    if (logQuery.trim()) {
      const q = logQuery.trim().toLowerCase();
      out = out.filter(l =>
        (l.body || '').toLowerCase().includes(q) ||
        (l.serviceName || '').toLowerCase().includes(q),
      );
    }
    return out;
  }, [logs, severityFilter, logQuery]);

  // Errors histogram is derived client-side because span_errors lives in a
  // different table than log_records. Aligns to the same bucket grid as the
  // logs histogram so switching sub-tabs doesn't shift the time axis.
  const errorsHistogram = useMemo<Histogram | null>(() => {
    if (!histogram || !histogram.buckets.length || !histogram.bucketSizeMs) return null;
    const start = histogram.bucketStartMs;
    const size = histogram.bucketSizeMs;
    const n = histogram.buckets.length;
    const out: Histogram['buckets'] = histogram.buckets.map(b => ({ tsMs: b.tsMs, total: 0, error: 0 }));
    for (const e of errors) {
      const idx = Math.floor((e.received_at - start) / size);
      if (idx < 0 || idx >= n) continue;
      out[idx].total++;
      out[idx].error = (out[idx].error || 0) + 1;
    }
    return { bucketStartMs: start, bucketEndMs: histogram.bucketEndMs, bucketSizeMs: size, buckets: out };
  }, [errors, histogram]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-end justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Stream</label>
            <button
              onClick={() => setPaused(p => !p)}
              title={paused ? 'Resume live updates' : 'Pause incoming logs and errors so the list stops moving'}
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
          <div className="flex border-b border-gray-800 -mb-px">
            <button
              onClick={() => setSubTab('logs')}
              className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
                subTab === 'logs' ? 'border-active text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              Logs <span className="ml-1.5 text-tiny font-mono px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{logs.length}</span>
            </button>
            <button
              onClick={() => setSubTab('errors')}
              className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
                subTab === 'errors' ? 'border-active text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              Errors <span className={`ml-1.5 text-tiny font-mono px-1.5 py-0.5 rounded ${errors.length ? 'bg-danger/20 text-[#ff8a8a]' : 'bg-gray-800 text-gray-400'}`}>{errors.length}</span>
            </button>
          </div>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          {subTab === 'logs' && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Severity</label>
                <select
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active"
                >
                  {SEVERITY_OPTIONS.map(s => (
                    <option key={s} value={s}>{s ? s : 'All severities'}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1 w-64">
                <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Search</label>
                <div className="relative">
                  <input
                    type="text"
                    value={logQuery}
                    onChange={(e) => setLogQuery(e.target.value)}
                    placeholder="message body or service…"
                    className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active pr-8"
                  />
                  {logQuery && (
                    <button
                      onClick={() => setLogQuery('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {(() => {
        const chart = subTab === 'logs' ? histogram : errorsHistogram;
        if (!chart || chart.buckets.length === 0) return null;
        return (
          <div className="adapt-card !p-3 mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">
                {subTab === 'logs' ? 'Log volume by severity' : 'Errors over time'}
              </div>
              {customRange && (
                <button
                  onClick={onClearCustomRange}
                  className="text-tiny text-active hover:underline font-semibold uppercase tracking-wider"
                >Clear time selection</button>
              )}
            </div>
            <TimelineChart
              buckets={chart.buckets as any}
              bucketSizeMs={chart.bucketSizeMs}
              height={84}
              segments={subTab === 'logs' ? [
                { key: 'debug', label: 'Debug', fill: TIMELINE_COLORS.debug },
                { key: 'info', label: 'Info', fill: TIMELINE_COLORS.info },
                { key: 'warn', label: 'Warn', fill: TIMELINE_COLORS.warn },
                { key: 'error', label: 'Error', fill: TIMELINE_COLORS.error },
              ] : [
                { key: 'error', label: 'Error', fill: TIMELINE_COLORS.error },
              ]}
              selectedRange={customRange}
              onBucketClick={onBucketClick}
            />
          </div>
        );
      })()}

      {subTab === 'logs' && <LogsView logs={filteredLogs} onJumpToTrace={onJumpToTrace} totalUnfiltered={logs.length} helixEnv={helixEnv} />}
      {subTab === 'errors' && <ErrorsView errors={errors} onJumpToTrace={onJumpToTrace} helixEnv={helixEnv} />}
    </div>
  );
};

const LogsView: React.FC<{
  logs: LogRecord[];
  onJumpToTrace: (traceId: string) => void;
  totalUnfiltered: number;
  helixEnv: HelixEnv | null;
}> = ({ logs, onJumpToTrace, totalUnfiltered, helixEnv }) => {
  if (logs.length === 0) {
    return (
      <div className="flex-1 overflow-auto adapt-card !p-0">
        <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-gray-500" />
          </div>
          <h3 className="text-base font-semibold text-gray-200 mb-2">
            {totalUnfiltered > 0 ? 'No logs match these filters' : 'No logs received yet'}
          </h3>
          <p className="text-sm text-gray-400 max-w-md leading-relaxed">
            {totalUnfiltered > 0
              ? 'Try clearing the severity or search filter.'
              : 'helix-gateway fans the OTel logs pipeline to /api/otlp/logs. If you don\'t see anything here, check that your app emits log records (separate from span events) and that the gateway is on the same network as your app.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto adapt-card !p-0">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
          <tr className="text-left text-tiny text-gray-400 uppercase tracking-wider">
            <th className="px-4 py-2 font-semibold">Time</th>
            <th className="px-4 py-2 font-semibold">Service</th>
            <th className="px-4 py-2 font-semibold">Severity</th>
            <th className="px-4 py-2 font-semibold">Body</th>
            <th className="px-4 py-2 font-semibold text-right">Trace</th>
          </tr>
        </thead>
        <tbody>
          {logs.map(l => (
            <tr key={l.id} className="border-b border-gray-800 hover:bg-gray-800/50">
              <td className="px-4 py-2 text-tiny text-gray-500 whitespace-nowrap">{formatTime(l.receivedAt)}</td>
              <td className="px-4 py-2 text-gray-200 whitespace-nowrap">{l.serviceName}</td>
              <td className="px-4 py-2">
                <span className={severityBadgeClass(l.severity)}>{normalizeSeverity(l.severity)}</span>
              </td>
              <td className="px-4 py-2 text-gray-300 font-mono text-tiny break-all">
                {l.body || <em className="text-gray-500 not-italic">(empty)</em>}
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap">
                {l.traceId ? (
                  <span className="inline-flex items-center gap-2">
                    <button
                      onClick={() => onJumpToTrace(l.traceId)}
                      className="text-active hover:text-[#a5baff] text-tiny font-semibold uppercase tracking-wider"
                    >
                      Open trace →
                    </button>
                    {(() => {
                      const url = buildHelixTraceUrl(helixEnv, {
                        traceId: l.traceId,
                        serviceName: l.serviceName,
                        timeNs: l.timeUnixNano,
                      });
                      if (!url) return null;
                      return (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open in Helix"
                          className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-200"
                        >
                          <BmcChevron className="h-3.5 w-auto" />
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      );
                    })()}
                  </span>
                ) : (
                  <span className="text-tiny text-gray-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ErrorsView: React.FC<{
  errors: ErrorRecord[];
  onJumpToTrace: (traceId: string) => void;
  helixEnv: HelixEnv | null;
}> = ({ errors, onJumpToTrace, helixEnv }) => {
  const [grouped, setGrouped] = useState<boolean>(true);

  // Group errors by exception_type × service_name. The flat view is still
  // available — toggle in the header — for users who want raw timeline.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; type: string; service: string; count: number; firstSeen: number; lastSeen: number; samples: ErrorRecord[] }>();
    for (const e of errors) {
      const key = `${e.exception_type || '(none)'}|${e.service_name || '(unknown)'}`;
      const g = map.get(key);
      if (g) {
        g.count += 1;
        if (e.received_at < g.firstSeen) g.firstSeen = e.received_at;
        if (e.received_at > g.lastSeen) g.lastSeen = e.received_at;
        if (g.samples.length < 5) g.samples.push(e);
      } else {
        map.set(key, {
          key,
          type: e.exception_type || '(none)',
          service: e.service_name || '(unknown)',
          count: 1,
          firstSeen: e.received_at,
          lastSeen: e.received_at,
          samples: [e],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
  }, [errors]);

  if (errors.length === 0) {
    return (
      <div className="flex-1 overflow-auto adapt-card !p-0">
        <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-gray-500" />
          </div>
          <h3 className="text-base font-semibold text-gray-200 mb-2">No errors yet</h3>
          <p className="text-sm text-gray-400 max-w-md leading-relaxed">
            Span exception events from your application's telemetry will appear here. Distinct from the
            container-level Diagnostic Log Stream on the configurator dashboard.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto adapt-card !p-0">
      <div className="px-4 py-2 border-b border-gray-800 bg-gray-900 flex items-center justify-between sticky top-0 z-10">
        <span className="text-tiny text-gray-500">
          {grouped ? `${groups.length} group${groups.length === 1 ? '' : 's'} • ${errors.length} total` : `${errors.length} error${errors.length === 1 ? '' : 's'}`}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => setGrouped(true)}
            className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${grouped ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >Grouped</button>
          <button
            onClick={() => setGrouped(false)}
            className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${!grouped ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
          >Flat</button>
        </div>
      </div>
      {grouped ? (
        <div className="divide-y divide-gray-800">
          {groups.map(g => (
            <ErrorGroupRow key={g.key} group={g} onJumpToTrace={onJumpToTrace} helixEnv={helixEnv} />
          ))}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
            <tr className="text-left text-tiny text-gray-400 uppercase tracking-wider">
              <th className="px-4 py-2 font-semibold">Time</th>
              <th className="px-4 py-2 font-semibold">Service</th>
              <th className="px-4 py-2 font-semibold">Type</th>
              <th className="px-4 py-2 font-semibold">Message</th>
              <th className="px-4 py-2 font-semibold text-right">Trace</th>
            </tr>
          </thead>
          <tbody>
            {errors.map(e => (
              <tr key={`${e.id}-${e.received_at}`} className="border-b border-gray-800 hover:bg-gray-800/50">
                <td className="px-4 py-2 text-tiny text-gray-500 whitespace-nowrap">{formatTime(e.received_at)}</td>
                <td className="px-4 py-2 text-gray-200 whitespace-nowrap">{e.service_name}</td>
                <td className="px-4 py-2">
                  <span className="adapt-badge-danger font-mono">{e.exception_type}</span>
                </td>
                <td className="px-4 py-2 text-gray-300 font-mono text-tiny break-all">{e.message || <em className="text-gray-500 not-italic">(no message)</em>}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <button
                      onClick={() => onJumpToTrace(e.trace_id)}
                      className="text-active hover:text-[#a5baff] text-tiny font-semibold uppercase tracking-wider"
                    >
                      Open trace →
                    </button>
                    {(() => {
                      const url = buildHelixTraceUrl(helixEnv, {
                        traceId: e.trace_id,
                        serviceName: e.service_name,
                        timeNs: e.ts_ns,
                      });
                      if (!url) return null;
                      return (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open in Helix"
                          className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-200"
                        >
                          <BmcChevron className="h-3.5 w-auto" />
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      );
                    })()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const ErrorGroupRow: React.FC<{
  group: { key: string; type: string; service: string; count: number; firstSeen: number; lastSeen: number; samples: ErrorRecord[] };
  onJumpToTrace: (traceId: string) => void;
  helixEnv: HelixEnv | null;
}> = ({ group, onJumpToTrace, helixEnv }) => {
  const [open, setOpen] = useState(false);
  // Show the most-recent sample's message inline so users don't have to expand
  // the row just to see what the exception said. Samples are pushed in order,
  // last entry is the freshest.
  const previewMessage = group.samples.length
    ? (group.samples[group.samples.length - 1].message || '').trim()
    : '';
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/40 transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />}
        <span className="adapt-badge-danger font-mono flex-shrink-0">{group.type}</span>
        <span className="text-gray-200 font-mono text-tiny flex-shrink-0">{group.service}</span>
        <span className="text-gray-400 font-mono text-tiny truncate flex-1 min-w-0">
          {previewMessage || <em className="text-gray-600 not-italic">(no message)</em>}
        </span>
        <span className="flex items-center gap-3 text-tiny text-gray-500 flex-shrink-0">
          <span><span className="text-[#ff8a8a] font-mono font-semibold">{group.count}</span> hits</span>
          <span>first {formatRelative(group.firstSeen)}</span>
          <span>last {formatRelative(group.lastSeen)}</span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 pl-10 space-y-1.5 bg-gray-900/40">
          {group.samples.map(e => (
            <div key={`${e.id}-${e.received_at}`} className="flex items-start gap-3 text-tiny">
              <span className="text-gray-500 font-mono w-20 flex-shrink-0">{formatTime(e.received_at)}</span>
              <span className="text-gray-300 font-mono break-all flex-1 min-w-0">{e.message || <em className="text-gray-500 not-italic">(no message)</em>}</span>
              <span className="inline-flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => onJumpToTrace(e.trace_id)}
                  className="text-active hover:text-[#a5baff] font-semibold uppercase tracking-wider"
                >Open trace →</button>
                {(() => {
                  const url = buildHelixTraceUrl(helixEnv, { traceId: e.trace_id, serviceName: e.service_name, timeNs: e.ts_ns });
                  if (!url) return null;
                  return (
                    <a href={url} target="_blank" rel="noopener noreferrer" title="Open in Helix" className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-200">
                      <BmcChevron className="h-3.5 w-auto" />
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  );
                })()}
              </span>
            </div>
          ))}
          {group.count > group.samples.length && (
            <div className="text-tiny text-gray-500 italic">+ {group.count - group.samples.length} more not shown</div>
          )}
        </div>
      )}
    </div>
  );
};
