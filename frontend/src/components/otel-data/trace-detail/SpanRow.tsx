import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Database, FileText } from 'lucide-react';
import type { LogRecord, SpanDetail } from '../types';
import { useSlowThreshold } from '../SlowThresholdContext';
import { formatDuration } from '../utils';
import { colorForService } from './palette';
import { LogLine } from './LogLine';

export const SpanRow: React.FC<{
  span: SpanDetail;
  depth: number;
  traceStartNs: number;
  traceDurationNs: number;
  logs: LogRecord[];
  isOnCriticalPath: boolean;
  criticalInterval: { startNs: number; endNs: number } | null;
  // Tree-collapse: parents pass a toggle callback + their transitive descendant
  // count. Leaves pass onToggleCollapsed=null and the chevron continues to
  // mean "open this row's detail panel" (legacy single-chevron behavior).
  descendantCount: number;
  isCollapsed: boolean;
  onToggleCollapsed: (() => void) | null;
  isHighlighted?: boolean;
  isDimmed?: boolean;
}> = ({ span, depth, traceStartNs, traceDurationNs, logs, isOnCriticalPath, criticalInterval, descendantCount, isCollapsed, onToggleCollapsed, isHighlighted = false, isDimmed = false }) => {
  const slowThresholdMs = useSlowThreshold();
  const [open, setOpen] = useState(false);
  const offsetNs = Math.max(0, span.startTimeNs - traceStartNs);
  const widthNs = Math.max(1, span.endTimeNs - span.startTimeNs);
  const leftPct = (offsetNs / traceDurationNs) * 100;
  const widthPct = Math.max(0.5, (widthNs / traceDurationNs) * 100);

  const isError = span.statusCode === 2 || span.events.some(e => e.name === 'exception');
  const isSlow = span.durationMs > slowThresholdMs;
  // OTel renamed several DB attributes in semconv 1.27+. Read both old and
  // new keys so spans from either era render the same way.
  const dbSystem = span.attributes['db.system'] || span.attributes['db.system.name'];
  const dbStatement: string | undefined =
    span.attributes['db.statement'] || span.attributes['db.query.text'];
  const dbOperation: string | undefined =
    span.attributes['db.operation']
    || span.attributes['db.operation.name']
    || span.attributes['db.query.summary'];
  const dbName: string | undefined =
    span.attributes['db.name']
    || span.attributes['db.namespace']
    || span.attributes['db.collection.name']
    || span.attributes['db.mongodb.collection'];
  const dbHighlights = useMemo(() => {
    // Sub-set of db.* attributes worth surfacing when there's no statement
    // (Redis/Valkey, .NET, Mongo etc. often omit the raw command for
    // performance or PII reasons). We pull these specific keys instead of
    // dumping every db.* so the panel stays readable.
    if (!dbSystem) return [] as Array<[string, string]>;
    const wanted = [
      'db.operation', 'db.operation.name', 'db.query.summary',
      'db.name', 'db.namespace', 'db.collection.name', 'db.mongodb.collection',
      'db.redis.database_index',
      'server.address', 'server.port', 'net.peer.name', 'net.peer.port',
    ];
    const out: Array<[string, string]> = [];
    for (const k of wanted) {
      const v = span.attributes[k];
      if (v != null && v !== '') out.push([k, String(v)]);
    }
    return out;
  }, [span.attributes, dbSystem]);
  const isSlowDb = !!dbSystem && span.durationMs > slowThresholdMs;

  // Bar hue encodes the SERVICE — matching the Service-breakdown legend and the
  // flame view, which both color via colorForService. Status (error/slow) is
  // NOT folded into the hue: the service palette already contains reds/ambers
  // that would be indistinguishable from a hue-encoded status, so status lives
  // on a separate channel (the ring/wash overlay below + the badges by the
  // name). Critical-path emphasis is opacity: on-path bars show full service
  // color (== the breakdown segment), off-path recede (the Elastic / Lightstep
  // pattern: emphasis by recession), mirroring the flame view's opacity dim.
  const serviceColor = colorForService(span.serviceName);

  const exceptions = span.events.filter(e => e.name === 'exception');

  // Highest log severity attached to this span — drives the badge tint so a
  // span carrying an ERROR log looks different from one with only INFO.
  const logSeverityTone = useMemo<'error' | 'warn' | 'info' | null>(() => {
    if (logs.length === 0) return null;
    let hasWarn = false;
    for (const l of logs) {
      const sev = (l.severity || '').toUpperCase();
      if (/FATAL|ERROR|CRITICAL/.test(sev)) return 'error';
      if (/WARN/.test(sev)) hasWarn = true;
    }
    return hasWarn ? 'warn' : 'info';
  }, [logs]);
  const logBadgeClass = logSeverityTone === 'error'
    ? 'adapt-badge-danger'
    : logSeverityTone === 'warn'
      ? 'adapt-badge-warning'
      : 'adapt-badge-info';

  return (
    <div className={`group transition-all duration-200 ${open ? 'bg-gray-900/60' : ''} ${isDimmed ? 'opacity-40' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-gray-800/40 transition-all ${isHighlighted ? 'bg-primary/10 border-l-[3px] border-primary' : ''}`}
      >
        <div className="w-[28rem] flex items-center gap-2 min-w-0" style={{ paddingLeft: depth * 14 }}>
          {/* Parent rows: the chevron is a tree-collapse toggle. We use a real
              <button> nested in the outer button (technically invalid HTML, but
              browsers accept it and React's stopPropagation reliably keeps the
              outer detail-toggle handler from also firing). Negative margins
              extend the hit area without changing the row's height so the
              caret is comfortable to click — 14px alone was too small.
              Leaf rows fall back to the legacy chevron-as-detail-indicator. */}
          {onToggleCollapsed ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleCollapsed(); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-gray-500 hover:text-gray-100 hover:bg-gray-700/60 cursor-pointer flex-shrink-0 inline-flex items-center justify-center rounded -my-2 -ml-2 pl-2 pr-1.5 py-2"
              title={isCollapsed ? `Expand ${descendantCount} hidden span${descendantCount === 1 ? '' : 's'}` : `Collapse ${descendantCount} child span${descendantCount === 1 ? '' : 's'}`}
              aria-label={isCollapsed ? 'Expand subtree' : 'Collapse subtree'}
            >
              {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          ) : (
            open ? <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-sm truncate ${isError ? 'text-[#ff8a8a]' : 'text-gray-100'}`}>{span.name}</span>
              {isError && <span className="adapt-badge-danger flex-shrink-0">Error</span>}
              {dbSystem && <span className="adapt-badge-info flex-shrink-0 inline-flex items-center gap-1"><Database className="w-2.5 h-2.5" />{dbSystem}</span>}
              {isSlow && !isError && <span className="adapt-badge-warning flex-shrink-0">Slow</span>}
              {isCollapsed && descendantCount > 0 && (
                <span
                  className="adapt-badge-info flex-shrink-0"
                  title={`Subtree is collapsed; ${descendantCount} span${descendantCount === 1 ? '' : 's'} hidden.`}
                >
                  +{descendantCount} hidden
                </span>
              )}
              {logs.length > 0 && (
                <span
                  className={`${logBadgeClass} flex-shrink-0 inline-flex items-center gap-1`}
                  title={`${logs.length} log record${logs.length === 1 ? '' : 's'} on this span. Expand to view.`}
                >
                  <FileText className="w-2.5 h-2.5" />{logs.length}
                </span>
              )}
            </div>
            <div className="text-tiny text-gray-500 truncate">
              <span
                className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle"
                style={{ backgroundColor: serviceColor }}
              />
              <span className="align-middle">{span.serviceName}</span>
              {dbStatement && (
                <>
                  {' · '}
                  <code className={`font-mono ${isSlowDb ? 'text-warning' : 'text-gray-400'}`}>
                    {dbStatement.length > 80 ? dbStatement.slice(0, 80) + '…' : dbStatement}
                  </code>
                </>
              )}
              {!dbStatement && dbOperation && <> · <span className="font-mono">{dbOperation}</span></>}
            </div>
          </div>
        </div>
        <div className="flex-1 relative h-5 bg-gray-1000 rounded-sm border border-gray-800 overflow-hidden">
          <div
            className="absolute top-0 bottom-0"
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              backgroundColor: serviceColor,
              opacity: isOnCriticalPath ? 1 : 0.5,
            }}
            title={`${span.serviceName} • ${formatDuration(span.durationMs)} @ +${formatDuration(offsetNs / 1e6)}${isOnCriticalPath ? ' • on critical path' : ''}`}
          />
          {/* Status accent — its own layer so the critical-path opacity above
              never weakens it. Error = bold red ring + faint red wash; slow =
              thinner amber ring (error outranks slow). The service hue still
              shows through, so the bar reads as "this service, but flagged". */}
          {(isError || isSlow) && (
            <div
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                boxShadow: isError ? 'inset 0 0 0 2px #b2001e' : 'inset 0 0 0 1.5px #ffd200',
                backgroundColor: isError ? 'rgba(178,0,30,0.30)' : undefined,
              }}
            />
          )}
          {criticalInterval && (() => {
            // Darker inner overlay for the actual blocking portion of the span
            // (CRISP). For leaf spans on the path that's the whole bar; for
            // ancestors it's just the time after the last on-path child
            // finished — i.e. the wrap-up the parent was waiting on.
            const cLeft = ((criticalInterval.startNs - traceStartNs) / traceDurationNs) * 100;
            const cWidth = Math.max(0.3, ((criticalInterval.endNs - criticalInterval.startNs) / traceDurationNs) * 100);
            return (
              <div
                className="absolute top-0 bottom-0 bg-black/40 pointer-events-none"
                style={{ left: `${cLeft}%`, width: `${cWidth}%` }}
              />
            );
          })()}
        </div>
        <div className={`w-20 text-right tabular-nums text-tiny ${isSlow ? 'text-warning font-semibold' : 'text-gray-300'}`}>
          {formatDuration(span.durationMs)}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 ml-7 space-y-3 text-sm" style={{ paddingLeft: 28 + depth * 14 }}>
          {exceptions.length > 0 && (
            <div className="space-y-2">
              {exceptions.map((ev, i) => (
                <div key={i} className="border border-danger/40 bg-danger/10 rounded p-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-[#ff8a8a]" />
                    <span className="text-tiny font-semibold text-[#ff8a8a]">
                      {ev.attributes['exception.type'] || 'exception'}
                    </span>
                  </div>
                  {ev.attributes['exception.message'] && (
                    <div className="text-sm text-gray-200">{ev.attributes['exception.message']}</div>
                  )}
                  {ev.attributes['exception.stacktrace'] && (
                    <pre className="mt-2 text-tiny text-gray-400 font-mono whitespace-pre-wrap break-all bg-gray-1000 rounded p-2 max-h-48 overflow-auto" style={{ fontFamily: "'Source Code Pro', monospace" }}>
                      {ev.attributes['exception.stacktrace']}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {dbStatement ? (
            <div>
              <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold mb-1">Query</div>
              <pre className="bg-gray-1000 border border-gray-800 rounded p-2 text-tiny text-gray-200 font-mono whitespace-pre-wrap break-all" style={{ fontFamily: "'Source Code Pro', monospace" }}>{dbStatement}</pre>
              {isSlowDb && (
                <div className="mt-1 text-tiny text-warning">⚠ This DB span is slow (&gt; 1 s). Consider an index, batching, or caching.</div>
              )}
            </div>
          ) : dbSystem && (
            <div>
              <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold mb-1">DB call</div>
              <div className="bg-gray-1000 border border-gray-800 rounded p-2 text-tiny font-mono space-y-0.5" style={{ fontFamily: "'Source Code Pro', monospace" }}>
                <div className="flex gap-3">
                  <span className="text-gray-500 flex-shrink-0">db.system</span>
                  <span className="text-gray-200 break-all">{dbSystem}</span>
                </div>
                {dbOperation && (
                  <div className="flex gap-3">
                    <span className="text-gray-500 flex-shrink-0">db.operation</span>
                    <span className="text-gray-200 break-all">{dbOperation}</span>
                  </div>
                )}
                {dbName && (
                  <div className="flex gap-3">
                    <span className="text-gray-500 flex-shrink-0">db.name</span>
                    <span className="text-gray-200 break-all">{dbName}</span>
                  </div>
                )}
                {dbHighlights
                  .filter(([k]) => k !== 'db.operation' && k !== 'db.operation.name' && k !== 'db.query.summary' && k !== 'db.name' && k !== 'db.namespace' && k !== 'db.collection.name' && k !== 'db.mongodb.collection')
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-3">
                      <span className="text-gray-500 flex-shrink-0">{k}</span>
                      <span className="text-gray-200 break-all">{v}</span>
                    </div>
                  ))}
              </div>
              <div className="mt-1.5 text-tiny text-gray-500">
                No <code className="font-mono">db.statement</code> / <code className="font-mono">db.query.text</code> captured by this client. Common with Redis/Valkey, .NET, and Mongo SDKs that omit raw commands for performance or PII reasons. The full attribute set is below.
              </div>
              {isSlowDb && (
                <div className="mt-1 text-tiny text-warning">⚠ This DB span is slow (&gt; 1 s). Consider an index, batching, or caching.</div>
              )}
            </div>
          )}

          {Object.keys(span.attributes).length > 0 && (
            <div>
              <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold mb-1">Attributes</div>
              <div className="bg-gray-1000 border border-gray-800 rounded p-2 text-tiny font-mono space-y-0.5 max-h-40 overflow-auto" style={{ fontFamily: "'Source Code Pro', monospace" }}>
                {Object.entries(span.attributes).map(([k, v]) => (
                  <div key={k} className="flex gap-3">
                    <span className="text-gray-500 flex-shrink-0">{k}</span>
                    <span className="text-gray-200 break-all">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {logs.length > 0 && (
            <div>
              <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold mb-1">
                Log records ({logs.length})
              </div>
              <div className="bg-gray-1000 border border-gray-800 rounded p-2 space-y-1">
                {logs.map(l => <LogLine key={l.id} log={l} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
