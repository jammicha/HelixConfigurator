import type { RefObject } from 'react';
import { LiveMetricsCards } from './LiveMetricsCards';

type MetricsSample = { received: number; sent: number; failed: number };
type TimelineEntry = { ts: number; kind: string; message: string };

// Tailwind classes per timeline event kind. Record<string> so callers don't
// have to share the App-local TimelineKind union; unknown kinds fall back to
// the neutral style.
const TIMELINE_KIND_CLASS: Record<string, string> = {
  'config-saved': 'bg-info/15 border-info/40 text-info',
  'restart': 'bg-warning/15 border-warning/40 text-warning',
  'attach': 'bg-success/15 border-success/40 text-success-text',
  'error-spike': 'bg-danger/15 border-danger/40 text-danger-text',
  'verify': 'bg-gray-800 border-gray-700 text-gray-300',
};
const NEUTRAL_KIND_CLASS = 'bg-gray-800 border-gray-700 text-gray-300';

type Props = {
  connectedApp: string | null;
  onShowRawMetrics: () => void;
  sseConnected: boolean;
  onReconnect: () => void;
  diagAlert: boolean;
  diagAlertCount: number;
  liveMetrics: MetricsSample;
  metricsHistory: MetricsSample[];
  timeline: TimelineEntry[];
  logFilter: 'helix' | 'all';
  onSetLogFilter: (filter: 'helix' | 'all') => void;
  logs: string[];
  visibleLogs: string[];
  logContainerRef: RefObject<HTMLDivElement>;
  logEndRef: RefObject<HTMLDivElement>;
  onLogScroll: () => void;
};

// The live diagnostic log card: stream header (with reconnect + drop-alert
// affordances), live counter cards, the session timeline strip, the log
// filter, and the auto-scrolling log pane itself.
export const DiagnosticLogPanel = ({
  connectedApp,
  onShowRawMetrics,
  sseConnected,
  onReconnect,
  diagAlert,
  diagAlertCount,
  liveMetrics,
  metricsHistory,
  timeline,
  logFilter,
  onSetLogFilter,
  logs,
  visibleLogs,
  logContainerRef,
  logEndRef,
  onLogScroll,
}: Props) => (
  <div className="adapt-card flex flex-col relative overflow-hidden">
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-gray-200">{connectedApp ? `${connectedApp} logs` : 'Helix gateway logs'}</h2>
        <button
          onClick={onShowRawMetrics}
          className="text-info text-tiny font-semibold uppercase tracking-wider hover:underline"
        >
          Show Raw Metrics
        </button>
        {!sseConnected && (
          <button
            onClick={onReconnect}
            className="flex items-center gap-1.5 bg-warning/15 border border-warning/40 text-warning px-2 py-0.5 rounded text-tiny font-semibold uppercase tracking-wider hover:bg-warning/25"
            title="Log stream disconnected. Click to reconnect."
          >
            <span className="w-1.5 h-1.5 rounded-full bg-warning"></span>
            Reconnect
          </button>
        )}
        {diagAlert && (
          <span
            className="flex items-center gap-2 bg-[#f5bcc6]/20 border border-danger/40 text-danger-text px-3 py-1 rounded text-tiny font-semibold uppercase tracking-wide"
            title="Counted from log lines containing 'sending queue is full', 'exporting failed', 'connection refused', or 'deadline exceeded' in the streamed container."
          >
            <span className="font-bold">!</span> Drop events in logs. Check network or queue limits.
            {diagAlertCount > 1 && (
              <span className="bg-danger text-white px-1.5 rounded-full text-[10px]">{diagAlertCount}</span>
            )}
          </span>
        )}
      </div>
      <LiveMetricsCards
        liveMetrics={liveMetrics}
        metricsHistory={metricsHistory}
        diagAlertCount={diagAlertCount}
      />
    </div>
    {timeline.length > 0 && (
      <div className="mb-3 pt-3 pb-2 border-t border-gray-800">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Timeline</span>
          <span className="text-tiny text-gray-600">{timeline.length} event{timeline.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {/* Newest first (reverse-chronological). The state array is
              append-only; we reverse here at render so insertion stays O(1)
              and slice semantics continue to evict oldest from the back. */}
          {[...timeline].reverse().map((ev, idx) => (
            <div
              key={idx}
              className={`flex-shrink-0 px-2.5 py-1 rounded border text-tiny font-medium ${TIMELINE_KIND_CLASS[ev.kind] || NEUTRAL_KIND_CLASS}`}
              title={ev.message}
            >
              <span className="font-mono opacity-70 mr-1.5">{new Date(ev.ts).toLocaleTimeString([], { hour12: false })}</span>
              <span>{ev.message}</span>
            </div>
          ))}
        </div>
      </div>
    )}
    <div className="flex items-center gap-2 mb-2">
      <span className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Filter:</span>
      <button
        onClick={() => onSetLogFilter('helix')}
        className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${logFilter === 'helix' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
      >
        Helix Only
      </button>
      <button
        onClick={() => onSetLogFilter('all')}
        className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${logFilter === 'all' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
      >
        All Logs
      </button>
      <span className="text-tiny text-gray-500 ml-auto">
        {logFilter === 'helix' ? `${visibleLogs.length} of ${logs.length}` : `${logs.length}`} lines
      </span>
    </div>
    <div
      ref={logContainerRef}
      onScroll={onLogScroll}
      className="bg-gray-1000 p-4 rounded border border-gray-800 h-64 overflow-y-auto font-mono text-sm text-success-text"
      style={{ fontFamily: "'Source Code Pro', monospace" }}
    >
      {visibleLogs.map((log, idx) => (
        <p key={idx} className="whitespace-pre-wrap mb-1">{log}</p>
      ))}
      <div ref={logEndRef} />
      <p className="animate-pulse">_</p>
    </div>
  </div>
);
