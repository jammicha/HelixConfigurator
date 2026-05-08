import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Loader2,
  Repeat,
  Server,
  X,
} from 'lucide-react';

// View OTel Data — local trace viewer fed by the helix-gateway fan-out.
//
// Why a single component instead of a router-based layout: the rest of the
// configurator app uses path-based view switching from main.tsx (no router
// dependency). This page mirrors that pattern so the bundle stays tiny.

type TraceSummary = {
  trace_id: string;
  service_name: string;
  root_operation: string;
  start_time_ns: number;
  end_time_ns: number;
  duration_ms: number;
  span_count: number;
  has_error: number;
  received_at: number;
};

type SpanDetail = {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  serviceName: string;
  name: string;
  kind: number;
  startTimeNs: number;
  endTimeNs: number;
  durationMs: number;
  statusCode: number;
  statusMessage: string;
  attributes: Record<string, any>;
  events: { name: string; timeUnixNano: number; attributes: Record<string, any> }[];
};

type TraceDetail = {
  summary: TraceSummary;
  spans: SpanDetail[];
};

type ErrorRecord = {
  id: number;
  trace_id: string;
  span_id: string;
  service_name: string;
  exception_type: string;
  message: string;
  stack: string;
  ts_ns: number;
  received_at: number;
};

type LogRecord = {
  id: number;
  traceId: string;
  spanId: string | null;
  serviceName: string;
  severity: string;
  body: string;
  attributes: Record<string, any>;
  timeUnixNano: number;
  receivedAt: number;
};

type TimeRange = '5m' | '15m' | '1h' | '6h' | '24h' | 'all';
const TIME_RANGES: { value: TimeRange; label: string; ms: number | null }[] = [
  { value: '5m', label: 'Last 5 min', ms: 5 * 60_000 },
  { value: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: 'all', label: 'All', ms: null },
];

const formatDuration = (ms: number) => {
  if (!isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const formatRelative = (epochMs: number) => {
  const diff = Date.now() - epochMs;
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(epochMs).toLocaleString();
};

const formatTime = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const SLOW_THRESHOLD_MS = 1000;

// Detect N+1 pattern: 5+ spans with the same db.operation + db.name.
const detectNPlusOne = (spans: SpanDetail[]): { operation: string; dbName: string; count: number } | null => {
  const buckets = new Map<string, number>();
  for (const s of spans) {
    const op = s.attributes['db.operation'];
    const dbName = s.attributes['db.name'];
    if (!op) continue;
    const key = `${op}|${dbName || ''}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let worst: { operation: string; dbName: string; count: number } | null = null;
  for (const [key, count] of buckets) {
    if (count >= 5 && (!worst || count > worst.count)) {
      const [operation, dbName] = key.split('|');
      worst = { operation, dbName, count };
    }
  }
  return worst;
};

// Mirrors App.tsx's nav: render the Logout button only when auth is actually
// configured, hide it otherwise so the bar isn't cluttered on open-access setups.
const LogoutLink: React.FC = () => {
  const [authRequired, setAuthRequired] = useState(false);
  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => setAuthRequired(!!d.required))
      .catch(() => { /* non-fatal — leave hidden */ });
  }, []);
  if (!authRequired) return null;
  return (
    <button
      onClick={async () => {
        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        window.location.href = '/';
      }}
      className="hover:text-white transition-colors"
    >
      Logout
    </button>
  );
};

const StatusPill: React.FC<{ trace: TraceSummary }> = ({ trace }) => {
  if (trace.has_error) {
    return <span className="adapt-badge-danger">Error</span>;
  }
  if (trace.duration_ms > SLOW_THRESHOLD_MS) {
    return <span className="adapt-badge-warning">Slow</span>;
  }
  return <span className="adapt-badge-success">OK</span>;
};

export const OtelDataPage: React.FC<{ onExit?: () => void }> = ({ onExit }) => {
  const [activeTab, setActiveTab] = useState<'traces' | 'errors'>('traces');
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [services, setServices] = useState<{ name: string; traceCount: number }[]>([]);
  const [errors, setErrors] = useState<ErrorRecord[]>([]);
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [range, setRange] = useState<TimeRange>('1h');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traceDetail, setTraceDetail] = useState<TraceDetail | null>(null);
  const [traceLogs, setTraceLogs] = useState<LogRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [tracesLoading, setTracesLoading] = useState(true);

  const eventSourceRef = useRef<EventSource | null>(null);

  const refreshTraces = async () => {
    const range_ = TIME_RANGES.find(r => r.value === range);
    const params = new URLSearchParams();
    if (serviceFilter) params.set('service', serviceFilter);
    if (range_?.ms) params.set('sinceMs', String(Date.now() - range_.ms));
    const res = await fetch(`/api/traces?${params}`);
    if (res.ok) {
      const j = await res.json();
      setTraces(j.traces || []);
    }
    setTracesLoading(false);
  };

  const refreshServices = async () => {
    const res = await fetch('/api/traces/services');
    if (res.ok) {
      const j = await res.json();
      setServices(j.services || []);
    }
  };

  const refreshErrors = async () => {
    const res = await fetch('/api/traces/errors');
    if (res.ok) {
      const j = await res.json();
      setErrors(j.errors || []);
    }
  };

  // Initial load + reload when filters change.
  useEffect(() => {
    setTracesLoading(true);
    refreshTraces();
  }, [serviceFilter, range]);

  useEffect(() => {
    refreshServices();
    refreshErrors();
  }, []);

  // Realtime SSE — push new traces and errors into the lists without polling.
  // The connection is shared across both tabs; tab switches don't tear it down.
  useEffect(() => {
    const es = new EventSource('/api/traces/stream');
    eventSourceRef.current = es;
    es.addEventListener('connected', () => setStreamConnected(true));
    es.addEventListener('trace', (evt: MessageEvent) => {
      try {
        const summary: TraceSummary = JSON.parse(evt.data);
        setTraces(prev => {
          const filtered = prev.filter(t => t.trace_id !== summary.trace_id);
          // Keep newest first, cap at 200 to mirror server query.
          return [summary, ...filtered].slice(0, 200);
        });
        // New service? Refresh the dropdown.
        setServices(prev => prev.some(s => s.name === summary.service_name)
          ? prev
          : [...prev, { name: summary.service_name, traceCount: 1 }].sort((a, b) => a.name.localeCompare(b.name)));
      } catch { /* malformed event — ignore */ }
    });
    es.addEventListener('error_record', (evt: MessageEvent) => {
      try {
        const err: any = JSON.parse(evt.data);
        // Server fires the camelCase shape from the in-memory event; the GET
        // endpoint returns snake_case rows. Normalize to the snake_case shape
        // used by the table so a single render path handles both.
        const record: ErrorRecord = {
          id: Date.now(),
          trace_id: err.traceId || err.trace_id,
          span_id: err.spanId || err.span_id,
          service_name: err.serviceName || err.service_name,
          exception_type: err.exceptionType || err.exception_type,
          message: err.message,
          stack: err.stack,
          ts_ns: err.tsNs || err.ts_ns,
          received_at: err.receivedAt || err.received_at,
        };
        setErrors(prev => [record, ...prev].slice(0, 500));
      } catch { /* ignore */ }
    });
    es.onerror = () => setStreamConnected(false);
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  // Trace detail load on selection.
  useEffect(() => {
    if (!selectedTraceId) {
      setTraceDetail(null);
      setTraceLogs([]);
      return;
    }
    setDetailLoading(true);
    setTraceDetail(null);
    setTraceLogs([]);
    Promise.all([
      fetch(`/api/traces/${selectedTraceId}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/logs/${selectedTraceId}`).then(r => r.ok ? r.json() : { logs: [] }),
    ]).then(([detail, logs]) => {
      setTraceDetail(detail);
      setTraceLogs(logs.logs || []);
      setDetailLoading(false);
    }).catch(() => setDetailLoading(false));
  }, [selectedTraceId]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-gray-1000 font-sans text-gray-100 flex-col">
      <header className="bg-helixNav flex items-center px-4 py-3 font-helix w-full justify-between flex-shrink-0 sticky top-0 z-40 border-b border-[#0f1620]">
        <div className="flex items-center">
          <a href="/" className="flex items-center" aria-label="Helix OTel Configurator home">
            <img src="/bmc-logo.svg" alt="BMC" className="h-8 w-auto" />
          </a>
          <div className="h-8 w-px bg-helixDivider mx-4"></div>
          <h1 className="text-white font-light text-[1.3125rem] m-0 ml-[15px] tracking-wide">
            Helix OTel Configurator
          </h1>
        </div>
        <nav className="flex items-center space-x-5 text-sm text-[#cfd3da]">
          <button onClick={onExit} className="hover:text-white transition-colors">
            Onboarding
          </button>
          <span className="text-white font-semibold border-b-2 border-primary pb-0.5">
            View OTel Data
          </span>
          <LogoutLink />
        </nav>
      </header>

      <main className="flex-1 overflow-hidden flex flex-col max-w-[120rem] w-full mx-auto px-6 pt-6 pb-2">
        {/* Tabs */}
        <div className="flex items-end justify-between border-b border-gray-800 mb-4">
          <div className="flex">
            <TabButton
              active={activeTab === 'traces'}
              onClick={() => setActiveTab('traces')}
              icon={<Activity className="w-4 h-4" />}
              label="Traces"
              count={traces.length}
            />
            <TabButton
              active={activeTab === 'errors'}
              onClick={() => setActiveTab('errors')}
              icon={<AlertTriangle className="w-4 h-4" />}
              label="Logs & Errors"
              count={errors.length}
              countTone={errors.length ? 'danger' : 'neutral'}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <span
              className={`inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold ${
                streamConnected ? 'text-[#5eead4]' : 'text-gray-500'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${streamConnected ? 'bg-success animate-pulse' : 'bg-gray-600'}`} />
              {streamConnected ? 'Live' : 'Reconnecting…'}
            </span>
          </div>
        </div>

        {activeTab === 'traces' && (
          <TracesTab
            traces={traces}
            services={services}
            serviceFilter={serviceFilter}
            setServiceFilter={setServiceFilter}
            range={range}
            setRange={setRange}
            tracesLoading={tracesLoading}
            onSelect={setSelectedTraceId}
          />
        )}
        {activeTab === 'errors' && (
          <ErrorsTab
            errors={errors}
            onJumpToTrace={(traceId) => {
              setActiveTab('traces');
              setSelectedTraceId(traceId);
            }}
          />
        )}
      </main>

      {selectedTraceId && (
        <TraceDetailDrawer
          traceId={selectedTraceId}
          detail={traceDetail}
          logs={traceLogs}
          loading={detailLoading}
          onClose={() => setSelectedTraceId(null)}
        />
      )}
    </div>
  );
};

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  countTone?: 'neutral' | 'danger';
}> = ({ active, onClick, icon, label, count, countTone = 'neutral' }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
      active
        ? 'border-active text-gray-100'
        : 'border-transparent text-gray-400 hover:text-gray-200'
    }`}
  >
    {icon}
    {label}
    {typeof count === 'number' && count > 0 && (
      <span
        className={`text-tiny px-1.5 py-0.5 rounded font-mono ${
          countTone === 'danger'
            ? 'bg-danger/20 text-[#ff8a8a]'
            : active
              ? 'bg-active/20 text-[#a5baff]'
              : 'bg-gray-800 text-gray-400'
        }`}
      >
        {count}
      </span>
    )}
  </button>
);

const TracesTab: React.FC<{
  traces: TraceSummary[];
  services: { name: string; traceCount: number }[];
  serviceFilter: string;
  setServiceFilter: (s: string) => void;
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  tracesLoading: boolean;
  onSelect: (traceId: string) => void;
}> = ({ traces, services, serviceFilter, setServiceFilter, range, setRange, tracesLoading, onSelect }) => {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-end gap-3 mb-4">
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
          <label className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Time range</label>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as TimeRange)}
            className="bg-gray-1000 border border-gray-800 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-active"
          >
            {TIME_RANGES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div className="ml-auto text-tiny text-gray-500 pb-1">
          {traces.length} trace{traces.length === 1 ? '' : 's'} • cap 500 (sliding window)
        </div>
      </div>

      <div className="flex-1 overflow-auto adapt-card !p-0">
        {tracesLoading ? (
          <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading traces…
          </div>
        ) : traces.length === 0 ? (
          <TracesEmptyState filtered={!!serviceFilter} />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
              <tr className="text-left text-tiny text-gray-400 uppercase tracking-wider">
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Service</th>
                <th className="px-4 py-2 font-semibold">Root operation</th>
                <th className="px-4 py-2 font-semibold text-right">Duration</th>
                <th className="px-4 py-2 font-semibold text-right">Spans</th>
                <th className="px-4 py-2 font-semibold">Received</th>
              </tr>
            </thead>
            <tbody>
              {traces.map(t => (
                <tr
                  key={t.trace_id}
                  onClick={() => onSelect(t.trace_id)}
                  className="border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2">
                    <StatusPill trace={t} />
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-100">
                    <span className="inline-flex items-center gap-2">
                      <Server className="w-3.5 h-3.5 text-gray-500" />
                      {t.service_name}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-300 font-mono text-tiny">{t.root_operation}</td>
                  <td className={`px-4 py-2 text-right font-mono ${t.duration_ms > SLOW_THRESHOLD_MS ? 'text-warning font-semibold' : 'text-gray-300'}`}>
                    {formatDuration(t.duration_ms)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-gray-400">{t.span_count}</td>
                  <td className="px-4 py-2 text-tiny text-gray-500">{formatRelative(t.received_at)}</td>
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

const ErrorsTab: React.FC<{
  errors: ErrorRecord[];
  onJumpToTrace: (traceId: string) => void;
}> = ({ errors, onJumpToTrace }) => {
  if (errors.length === 0) {
    return (
      <div className="flex-1 overflow-auto adapt-card !p-0">
        <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-gray-500" />
          </div>
          <h3 className="text-base font-semibold text-gray-200 mb-2">No errors yet</h3>
          <p className="text-sm text-gray-400 max-w-md leading-relaxed">
            This feed shows OTel log records and span exception events extracted from your application's
            telemetry. It's distinct from the container-level Diagnostic Log Stream on the configurator
            dashboard. Once your app starts sending telemetry, any failed spans or exceptions will appear here.
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
              <td className="px-4 py-2 text-right">
                <button
                  onClick={() => onJumpToTrace(e.trace_id)}
                  className="text-active hover:text-[#a5baff] text-tiny font-semibold uppercase tracking-wider"
                >
                  Open trace →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const TraceDetailDrawer: React.FC<{
  traceId: string;
  detail: TraceDetail | null;
  logs: LogRecord[];
  loading: boolean;
  onClose: () => void;
}> = ({ traceId, detail, logs, loading, onClose }) => {
  // Press ESC to close — matches the existing modals in App.tsx.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <aside className="w-full max-w-[80rem] h-full bg-gray-1000 border-l border-gray-800 flex flex-col shadow-4">
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900">
          <div>
            <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Trace</div>
            <div className="font-mono text-sm text-gray-200 mt-0.5 select-all">{traceId}</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 p-1 rounded hover:bg-gray-800">
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-gray-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading trace…
            </div>
          ) : !detail ? (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">Trace not found.</div>
          ) : (
            <Waterfall detail={detail} logs={logs} />
          )}
        </div>
      </aside>
    </div>
  );
};

const Waterfall: React.FC<{ detail: TraceDetail; logs: LogRecord[] }> = ({ detail, logs }) => {
  const { spans, summary } = detail;
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

  const nPlusOne = useMemo(() => detectNPlusOne(spans), [spans]);

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
        <SummaryCell label="Duration" value={formatDuration(summary.duration_ms)} icon={<Clock className="w-3.5 h-3.5" />} tone={summary.duration_ms > SLOW_THRESHOLD_MS ? 'warning' : undefined} />
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

      {/* Waterfall */}
      <div className="adapt-card !p-0 overflow-hidden">
        <div className="px-4 py-2 border-b border-gray-800 text-tiny font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-3">
          <span className="w-[28rem]">Span</span>
          <span className="flex-1">Timeline</span>
          <span className="w-20 text-right">Duration</span>
        </div>
        <div className="divide-y divide-gray-800">
          {ordered.map(({ span, depth }) => (
            <SpanRow
              key={`${span.spanId}-${span.traceId}`}
              span={span}
              depth={depth}
              traceStartNs={traceStartNs}
              traceDurationNs={traceDurationNs}
              logs={logsBySpan.get(span.spanId) || []}
            />
          ))}
        </div>
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
      <div className={`mt-1 font-mono text-base ${toneClasses}`}>{value}</div>
    </div>
  );
};

const SpanRow: React.FC<{
  span: SpanDetail;
  depth: number;
  traceStartNs: number;
  traceDurationNs: number;
  logs: LogRecord[];
}> = ({ span, depth, traceStartNs, traceDurationNs, logs }) => {
  const [open, setOpen] = useState(false);
  const offsetNs = Math.max(0, span.startTimeNs - traceStartNs);
  const widthNs = Math.max(1, span.endTimeNs - span.startTimeNs);
  const leftPct = (offsetNs / traceDurationNs) * 100;
  const widthPct = Math.max(0.5, (widthNs / traceDurationNs) * 100);

  const isError = span.statusCode === 2 || span.events.some(e => e.name === 'exception');
  const isSlow = span.durationMs > SLOW_THRESHOLD_MS;
  const dbSystem = span.attributes['db.system'];
  const dbStatement: string | undefined = span.attributes['db.statement'];
  const dbOperation: string | undefined = span.attributes['db.operation'];
  const isSlowDb = !!dbSystem && span.durationMs > SLOW_THRESHOLD_MS;

  const barColor = isError
    ? 'bg-danger/80'
    : isSlow
      ? 'bg-warning/80'
      : dbSystem
        ? 'bg-active/80'
        : 'bg-primary/80';

  const exceptions = span.events.filter(e => e.name === 'exception');

  return (
    <div className={`group ${open ? 'bg-gray-900/60' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-gray-800/40 transition-colors"
      >
        <div className="w-[28rem] flex items-center gap-2 min-w-0" style={{ paddingLeft: depth * 14 }}>
          {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`text-sm truncate ${isError ? 'text-[#ff8a8a]' : 'text-gray-100'}`}>{span.name}</span>
              {isError && <span className="adapt-badge-danger flex-shrink-0">Error</span>}
              {dbSystem && <span className="adapt-badge-info flex-shrink-0 inline-flex items-center gap-1"><Database className="w-2.5 h-2.5" />{dbSystem}</span>}
              {isSlow && !isError && <span className="adapt-badge-warning flex-shrink-0">Slow</span>}
            </div>
            <div className="text-tiny text-gray-500 truncate">
              <span className="font-mono">{span.serviceName}</span>
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
            className={`absolute top-0 bottom-0 ${barColor}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            title={`${formatDuration(span.durationMs)} @ +${formatDuration(offsetNs / 1e6)}`}
          />
        </div>
        <div className={`w-20 text-right font-mono text-tiny ${isSlow ? 'text-warning font-semibold' : 'text-gray-300'}`}>
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
                    <span className="text-tiny font-semibold text-[#ff8a8a] font-mono">
                      {ev.attributes['exception.type'] || 'exception'}
                    </span>
                  </div>
                  {ev.attributes['exception.message'] && (
                    <div className="text-sm text-gray-200 font-mono">{ev.attributes['exception.message']}</div>
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

          {dbStatement && (
            <div>
              <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold mb-1">Query</div>
              <pre className="bg-gray-1000 border border-gray-800 rounded p-2 text-tiny text-gray-200 font-mono whitespace-pre-wrap break-all" style={{ fontFamily: "'Source Code Pro', monospace" }}>{dbStatement}</pre>
              {isSlowDb && (
                <div className="mt-1 text-tiny text-warning">⚠ This DB span is slow (&gt; 1 s) — consider an index, batching, or caching.</div>
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

const LogLine: React.FC<{ log: LogRecord }> = ({ log }) => {
  const sevTone = /error|fatal|critical/i.test(log.severity)
    ? 'text-[#ff8a8a]'
    : /warn/i.test(log.severity)
      ? 'text-warning'
      : 'text-gray-300';
  return (
    <div className="text-tiny font-mono flex gap-2" style={{ fontFamily: "'Source Code Pro', monospace" }}>
      <span className="text-gray-500 flex-shrink-0">{formatTime(log.receivedAt)}</span>
      {log.severity && <span className={`${sevTone} flex-shrink-0`}>{log.severity.toUpperCase()}</span>}
      <span className="text-gray-200 break-all">{log.body}</span>
    </div>
  );
};
