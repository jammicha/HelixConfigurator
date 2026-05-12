import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  FileText,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  Repeat,
  Server,
  Wrench,
  X,
} from 'lucide-react';
import { TimelineChart, TIMELINE_COLORS } from './TimelineChart';
import { OverviewTab } from './OverviewTab';
import { useOverview } from '../hooks/useOverview';
import { usePageRefresh, REFRESH_INTERVAL_MS } from '../hooks/usePageRefresh';
import type { RefreshInterval } from '../hooks/usePageRefresh';
import { useLocalStorageState } from '../hooks/useLocalStorageState';

// Shared types/utilities + sub-tab components — moved out of this file to
// keep OtelDataPage focused on page-level wiring rather than per-tab UI.
import type { HelixEnv, OperationStat, TraceDetail, TraceStatus, TraceSummary, TimeRange, LogRecord, ErrorRecord, SpanDetail } from './otel-data/types';
import { TIME_RANGES, SLOW_THRESHOLD_MS, INTERNAL_SERVICES } from './otel-data/constants';
import { buildHelixTraceUrl, detectNPlusOne, formatDuration, formatRelative, formatTime, normalizeSeverity, severityBadgeClass, traceStatus } from './otel-data/utils';
import { BmcChevron } from './otel-data/BmcChevron';
import { CustomRangePopover } from './otel-data/CustomRangePopover';
import { TabButton } from './otel-data/TabButton';
import { TracesTab } from './otel-data/TracesTab';
import { OperationsTab } from './otel-data/OperationsTab';
import { LogsAndErrorsTab } from './otel-data/LogsAndErrorsTab';


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


const readUrlState = () => {
  if (typeof window === 'undefined') return { service: '', status: '' as '' | TraceStatus, range: '1h' as TimeRange, q: '', minMs: 0, selected: null as string | null };
  const p = new URLSearchParams(window.location.search);
  const range = (p.get('range') as TimeRange) || '1h';
  const validRange = TIME_RANGES.some(r => r.value === range) ? range : '1h';
  const status = p.get('status') as '' | TraceStatus;
  const validStatus = (['', 'error', 'slow', 'ok', 'outlier'].includes(status) ? status : '') as '' | TraceStatus;
  const minMsRaw = parseInt(p.get('minMs') || '0', 10);
  return {
    service: p.get('service') || '',
    status: validStatus,
    range: validRange,
    q: p.get('q') || '',
    minMs: Number.isFinite(minMsRaw) && minMsRaw > 0 ? minMsRaw : 0,
    selected: p.get('selected'),
  };
};



export const OtelDataPage: React.FC = () => {
  const initial = readUrlState();
  // Persisted so a refresh / new session lands on whichever tab the user was
  // last using. Validates against the allowed enum so stale stored values
  // from an earlier build can't crash the page.
  const ALLOWED_TABS: Array<'overview' | 'traces' | 'operations' | 'errors'> = ['overview', 'traces', 'operations', 'errors'];
  const [activeTab, setActiveTab] = useLocalStorageState<'overview' | 'traces' | 'operations' | 'errors'>(
    'helix-otel.activeTab',
    'overview',
    (v): v is 'overview' | 'traces' | 'operations' | 'errors' => typeof v === 'string' && ALLOWED_TABS.includes(v as any),
  );
  const [operations, setOperations] = useState<OperationStat[]>([]);
  const [operationsLoading, setOperationsLoading] = useState<boolean>(false);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [services, setServices] = useState<{ name: string; traceCount: number }[]>([]);
  const [errors, setErrors] = useState<ErrorRecord[]>([]);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [serviceFilter, setServiceFilter] = useState<string>(initial.service);
  const [statusFilter, setStatusFilter] = useState<'' | TraceStatus>(initial.status);
  const [range, setRange] = useState<TimeRange>(initial.range);
  const [searchQuery, setSearchQuery] = useState<string>(initial.q);
  const [minMs, setMinMs] = useState<number>(initial.minMs);
  // Pause is per-tab so the user can freeze one feed while watching the
  // other (e.g. read a trace without the logs view scrolling underneath).
  const [tracesPaused, setTracesPaused] = useState<boolean>(false);
  const [logsPaused, setLogsPaused] = useState<boolean>(false);
  const [helixEnv, setHelixEnv] = useState<HelixEnv | null>(null);
  // Detected upstream OTel collectors and the "stream stalled? restart it"
  // affordance. Populated on mount + every 60s so the menu always reflects
  // current host state.
  const [detectedCollectors, setDetectedCollectors] = useState<Array<{ name: string; image: string }>>([]);
  const [diagOpen, setDiagOpen] = useState(false);
  const [restartingName, setRestartingName] = useState<string | null>(null);
  const [restartResult, setRestartResult] = useState<{ name: string; ok: boolean; message: string } | null>(null);
  const diagRef = useRef<HTMLDivElement | null>(null);

  // Timeline state. customRange is set when the user clicks a bucket on the
  // chart — it zooms the trace/log list into that bucket's window while the
  // chart itself stays at the broader `range` and shades the selection.
  const [customRange, setCustomRange] = useState<{ sinceMs: number; untilMs: number } | null>(null);
  const ALLOWED_REFRESH: RefreshInterval[] = ['off', '10s', '30s', '60s', '5m'];
  const [refreshInterval, setRefreshInterval] = useLocalStorageState<RefreshInterval>(
    'helix-otel.refreshInterval',
    '60s',
    (v): v is RefreshInterval => typeof v === 'string' && ALLOWED_REFRESH.includes(v as RefreshInterval),
  );
  const [customRangePopoverOpen, setCustomRangePopoverOpen] = useState(false);
  const customRangePopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        const res = await fetch('/api/discovery/collectors');
        if (!res.ok) return;
        const data = await res.json();
        setDetectedCollectors((data.collectors || []).map((c: any) => ({ name: c.name, image: c.image })));
      } catch { /* non-fatal */ }
    };
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  // Click outside the diagnostics popover closes it.
  useEffect(() => {
    if (!diagOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (diagRef.current && !diagRef.current.contains(e.target as Node)) setDiagOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [diagOpen]);

  // Same pattern for the custom-range popover.
  useEffect(() => {
    if (!customRangePopoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (customRangePopoverRef.current && !customRangePopoverRef.current.contains(e.target as Node)) {
        setCustomRangePopoverOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCustomRangePopoverOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [customRangePopoverOpen]);

  const restartCollector = async (name: string) => {
    if (restartingName) return;
    setRestartingName(name);
    setRestartResult(null);
    try {
      const res = await fetch('/api/lifecycle/restart-container', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      setRestartResult({ name, ok: res.ok, message: data.message || data.error || 'Done' });
    } catch (e: any) {
      setRestartResult({ name, ok: false, message: e.message || 'Request failed' });
    } finally {
      setRestartingName(null);
    }
  };

  // Fetch Helix endpoint + tenant id (first ::-segment of HELIX_API_KEY) +
  // source so trace rows can deep-link to Helix's OTelTraceDetails dashboard.
  useEffect(() => {
    fetch('/api/env')
      .then(r => r.ok ? r.json() : null)
      .then(env => {
        if (!env) return;
        const tenantId = (env.HELIX_API_KEY || '').split('::')[0] || '';
        setHelixEnv({
          endpoint: env.HELIX_ENDPOINT || '',
          tenantId,
          source: env.X_SOURCE || '',
        });
      })
      .catch(() => { /* env unset — links just won't render */ });
  }, []);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(initial.selected);
  const [traceDetail, setTraceDetail] = useState<TraceDetail | null>(null);
  const [traceLogs, setTraceLogs] = useState<LogRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [tracesLoading, setTracesLoading] = useState(true);

  const visibleTraces = useMemo(() => {
    let out = traces.filter(t => !INTERNAL_SERVICES.has(t.service_name));
    if (statusFilter === 'outlier') {
      // Outlier = trace's duration > 2× its operation's p95. Build the map
      // only when the filter is active; depends on the same operations data
      // the inline badge uses, so the dropdown and the badge agree.
      const p95Map = new Map(operations.map(o => [`${o.service_name}|${o.root_operation}`, o.p95_ms]));
      out = out.filter(t => {
        const p95 = p95Map.get(`${t.service_name}|${t.root_operation}`) || 0;
        return p95 > 0 && t.duration_ms > p95 * 2;
      });
    } else if (statusFilter) {
      out = out.filter(t => traceStatus(t) === statusFilter);
    }
    if (minMs > 0) out = out.filter(t => t.duration_ms >= minMs);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      out = out.filter(t =>
        (t.root_operation || '').toLowerCase().includes(q) ||
        (t.service_name || '').toLowerCase().includes(q) ||
        (t.trace_id || '').toLowerCase().includes(q),
      );
    }
    return out;
  }, [traces, statusFilter, minMs, searchQuery, operations]);
  const visibleServices = useMemo(
    () => services.filter(s => !INTERNAL_SERVICES.has(s.name)),
    [services],
  );
  const visibleErrors = useMemo(
    () => errors.filter(e => !INTERNAL_SERVICES.has(e.service_name)),
    [errors],
  );
  const visibleLogs = useMemo(
    () => logs.filter(l => !INTERNAL_SERVICES.has(l.serviceName)),
    [logs],
  );

  const eventSourceRef = useRef<EventSource | null>(null);
  // Read inside the SSE handler so toggling pause doesn't tear down/rebuild
  // the EventSource — the closure captures the refs, not the booleans.
  const tracesPausedRef = useRef(tracesPaused);
  const logsPausedRef = useRef(logsPaused);
  useEffect(() => { tracesPausedRef.current = tracesPaused; }, [tracesPaused]);
  useEffect(() => { logsPausedRef.current = logsPaused; }, [logsPaused]);

  // Push current filter + selection state into the URL. replaceState (not
  // push) so each keystroke in the search box doesn't pile up history.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams();
    if (serviceFilter) p.set('service', serviceFilter);
    if (statusFilter) p.set('status', statusFilter);
    if (range !== '1h') p.set('range', range);
    if (searchQuery) p.set('q', searchQuery);
    if (minMs > 0) p.set('minMs', String(minMs));
    if (selectedTraceId) p.set('selected', selectedTraceId);
    const qs = p.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
  }, [serviceFilter, statusFilter, range, searchQuery, minMs, selectedTraceId]);

  // Resolve the active time window. customRange (set by clicking a bucket on
  // the timeline chart) takes precedence over the relative TIME_RANGES picker.
  const resolveWindow = (): { sinceMs?: number; untilMs?: number } => {
    if (customRange) return { sinceMs: customRange.sinceMs, untilMs: customRange.untilMs };
    const r = TIME_RANGES.find(x => x.value === range);
    if (r?.ms) return { sinceMs: Date.now() - r.ms };
    return {};
  };

  // Window for the timeline chart itself. Stays at the broad `range` even when
  // customRange is set — that way the chart shades the active selection rather
  // than collapsing into it.
  const resolveChartWindow = (): { sinceMs?: number; untilMs?: number } => {
    const r = TIME_RANGES.find(x => x.value === range);
    if (r?.ms) return { sinceMs: Date.now() - r.ms, untilMs: Date.now() };
    return {};
  };

  const refreshTraces = async () => {
    const params = new URLSearchParams();
    if (serviceFilter) params.set('service', serviceFilter);
    const w = resolveWindow();
    if (w.sinceMs != null) params.set('sinceMs', String(w.sinceMs));
    if (w.untilMs != null) params.set('untilMs', String(w.untilMs));
    const res = await fetch(`/api/traces?${params}`);
    if (res.ok) {
      const j = await res.json();
      setTraces(j.traces || []);
    }
    setTracesLoading(false);
  };

  // The six overview-tab datasets (overview stats, traces/logs histograms,
  // prior-window totals, heatmap, insights, service map) are now fetched in
  // one composite round-trip via useOverview. Auto-refreshes when serviceFilter
  // or chart window changes; refresh() below is what the page-wide refresh
  // interval calls to poll.
  const overviewWindow = resolveChartWindow();
  const ov = useOverview({
    sinceMs: overviewWindow.sinceMs,
    untilMs: overviewWindow.untilMs,
    service: serviceFilter || undefined,
  });

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

  const refreshLogs = async () => {
    const params = new URLSearchParams({ limit: '500' });
    const w = resolveWindow();
    if (w.sinceMs != null) params.set('sinceMs', String(w.sinceMs));
    const res = await fetch(`/api/logs?${params}`);
    if (res.ok) {
      const j = await res.json();
      setLogs(j.logs || []);
    }
  };

  const refreshOperations = async () => {
    setOperationsLoading(true);
    try {
      const params = new URLSearchParams();
      const w = resolveWindow();
      if (w.sinceMs != null) params.set('sinceMs', String(w.sinceMs));
      if (w.untilMs != null) params.set('untilMs', String(w.untilMs));
      const res = await fetch(`/api/operations?${params}`);
      if (res.ok) {
        const j = await res.json();
        setOperations(j.operations || []);
      }
    } finally {
      setOperationsLoading(false);
    }
  };

  // Reload operations whenever the tab opens or the trace time range changes.
  // Also fetch on initial mount + every 60s regardless of which tab is open,
  // so the trace list can flag rows whose duration exceeds 2× p95 of their
  // operation (Item 3: outlier highlighting).
  useEffect(() => {
    if (activeTab === 'operations') refreshOperations();
  }, [activeTab, range]);
  useEffect(() => {
    refreshOperations();
    const id = setInterval(refreshOperations, 60_000);
    return () => clearInterval(id);
  }, [range]);

  const operationP95 = useMemo(() => {
    const m = new Map<string, number>();
    for (const op of operations) {
      m.set(`${op.service_name}|${op.root_operation}`, op.p95_ms);
    }
    return m;
  }, [operations]);

  // Initial load + reload when filters change. customRange is included so
  // clicking a histogram bucket zooms the list into that bucket immediately.
  useEffect(() => {
    setTracesLoading(true);
    refreshTraces();
  }, [serviceFilter, range, customRange]);

  // Reload logs whenever the active time window changes (including click-zoom).
  useEffect(() => {
    refreshLogs();
  }, [range, customRange]);

  // Periodic re-fetch so the rollup counts (logs/errors/db calls) on
  // SSE-pushed traces catch up — those arrive with counts at 0 because
  // the trace summary is emitted before logs and the rest of the spans
  // settle. Skip while paused to respect the user's freeze.
  useEffect(() => {
    const id = setInterval(() => {
      if (tracesPausedRef.current) return;
      refreshTraces();
    }, 30_000);
    return () => clearInterval(id);
  }, [serviceFilter, range, customRange]);

  // Page-wide refresh cadence. useOverview auto-fetches when its inputs
  // (serviceFilter, chart window) change; this hook drives the periodic
  // re-poll cadence. Auto-pauses when the tab is hidden.
  usePageRefresh(refreshInterval, ov.refresh);

  // Clearing the customRange when the user switches the relative range keeps
  // the two pickers consistent — the new range implies "show everything in
  // this window, no sub-zoom".
  useEffect(() => {
    setCustomRange(null);
  }, [range]);

  useEffect(() => {
    refreshServices();
    refreshErrors();
    refreshLogs();
    // The service list now reflects every service that participates in any
    // trace (spans table), so it can grow as new downstream services emit
    // their first span. Refresh every 30s so the dropdown picks them up
    // without a full page reload.
    const id = setInterval(refreshServices, 30_000);
    return () => clearInterval(id);
  }, []);

  // Realtime SSE — push new traces and errors into the lists without polling.
  // The connection is shared across both tabs; tab switches don't tear it down.
  useEffect(() => {
    const es = new EventSource('/api/traces/stream');
    eventSourceRef.current = es;
    es.addEventListener('connected', () => setStreamConnected(true));
    es.addEventListener('trace', (evt: MessageEvent) => {
      // Pause: stop merging incoming traces so the user's view stays stable
      // while they read. Unpausing resumes the live feed; a fresh /api/traces
      // call would be needed to backfill what was missed (we don't bother).
      if (tracesPausedRef.current) return;
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
      // Errors live in the Logs & Errors tab — share its pause toggle.
      if (logsPausedRef.current) return;
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
    es.addEventListener('trace_counts_update', (evt: MessageEvent) => {
      // Rollup-count refresh for an existing trace row. Don't tie to a pause
      // state: counts always reflect what we've stored, regardless of which
      // tab the user is freezing.
      try {
        const data: { traceId: string; log_count?: number; error_count?: number; db_call_count?: number } = JSON.parse(evt.data);
        if (!data.traceId) return;
        setTraces(prev => prev.map(t => t.trace_id === data.traceId
          ? { ...t, log_count: data.log_count, error_count: data.error_count, db_call_count: data.db_call_count }
          : t));
      } catch { /* ignore */ }
    });
    es.addEventListener('log', (evt: MessageEvent) => {
      if (logsPausedRef.current) return;
      try {
        const raw: any = JSON.parse(evt.data);
        const record: LogRecord = {
          id: Date.now() + Math.random(),
          traceId: raw.traceId || '',
          spanId: raw.spanId || null,
          serviceName: raw.serviceName,
          severity: raw.severity || '',
          body: raw.body || '',
          attributes: raw.attributes || {},
          timeUnixNano: raw.timeUnixNano,
          receivedAt: raw.receivedAt,
        };
        setLogs(prev => [record, ...prev].slice(0, 500));
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
          <div className="h-8 w-px bg-helixDivider mx-5"></div>
          <nav className="flex items-center space-x-5 text-sm text-[#cfd3da]">
            <a href="/?view=onboarding" className="hover:text-white transition-colors">
              Onboarding
            </a>
            <a href="/" className="hover:text-white transition-colors">
              Gateway Dashboard
            </a>
            <span className="text-white font-semibold border-b-2 border-primary pb-0.5">
              View OTel Data
            </span>
          </nav>
        </div>
        <nav className="flex items-center space-x-5 text-sm text-[#cfd3da]">
          <LogoutLink />
        </nav>
      </header>

      <main className="flex-1 overflow-hidden flex flex-col max-w-[120rem] w-full mx-auto px-6 pt-6 pb-2">
        {/* Tabs */}
        <div className="flex items-end justify-between border-b border-gray-800 mb-4">
          <div className="flex">
            <TabButton
              active={activeTab === 'overview'}
              onClick={() => setActiveTab('overview')}
              icon={<LayoutDashboard className="w-4 h-4" />}
              label="Overview"
            />
            <TabButton
              active={activeTab === 'traces'}
              onClick={() => setActiveTab('traces')}
              icon={<Activity className="w-4 h-4" />}
              label="Traces"
              count={visibleTraces.length}
            />
            <TabButton
              active={activeTab === 'operations'}
              onClick={() => setActiveTab('operations')}
              icon={<Server className="w-4 h-4" />}
              label="Operations"
              count={operations.length}
            />
            <TabButton
              active={activeTab === 'errors'}
              onClick={() => setActiveTab('errors')}
              icon={<AlertTriangle className="w-4 h-4" />}
              label="Logs & Errors"
              count={visibleLogs.length}
              countTone="neutral"
              errorCount={visibleErrors.length}
            />
          </div>
          <div className="flex items-center gap-3 pb-2">
            <div ref={customRangePopoverRef} className="relative">
              <button
                onClick={() => setCustomRangePopoverOpen(o => !o)}
                title={customRange ? 'Edit custom time window' : 'Set an explicit start/end window'}
                className={`inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold transition-colors ${
                  customRange ? 'text-active hover:text-active-hover' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                {customRange ? 'Custom window' : 'Custom range…'}
              </button>
              {customRangePopoverOpen && (
                <CustomRangePopover
                  initial={customRange}
                  onClose={() => setCustomRangePopoverOpen(false)}
                  onApply={(s, u) => {
                    setCustomRange({ sinceMs: s, untilMs: u });
                    setCustomRangePopoverOpen(false);
                  }}
                  onClear={() => {
                    setCustomRange(null);
                    setCustomRangePopoverOpen(false);
                  }}
                />
              )}
            </div>
            <label className="inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold text-gray-400">
              <RefreshCw className="w-3.5 h-3.5" />
              Auto-refresh
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(e.target.value as RefreshInterval)}
                className="bg-gray-1000 border border-gray-800 rounded px-2 py-0.5 text-tiny text-gray-200 focus:outline-none focus:border-active normal-case tracking-normal font-normal"
              >
                <option value="off">Off</option>
                <option value="10s">10s</option>
                <option value="30s">30s</option>
                <option value="60s">60s</option>
                <option value="5m">5m</option>
              </select>
            </label>
            <div ref={diagRef} className="relative">
              <button
                onClick={() => setDiagOpen(o => !o)}
                title="Diagnostics — restart upstream OTel collectors when the stream stalls"
                className={`inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold transition-colors ${diagOpen ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
              >
                <Wrench className="w-3.5 h-3.5" />
                Diagnostics
              </button>
              {diagOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 z-50 bg-gray-1000 border border-gray-800 rounded shadow-4">
                  <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
                    <span className="text-tiny font-semibold text-gray-300 uppercase tracking-wider">Upstream collectors</span>
                    <span className="text-tiny text-gray-500">{detectedCollectors.length} detected</span>
                  </div>
                  {detectedCollectors.length === 0 ? (
                    <div className="px-3 py-3 text-tiny text-gray-500">
                      No upstream OTel collectors detected on this host.
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-800">
                      {detectedCollectors.map(c => (
                        <div key={c.name} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-gray-200 font-mono text-tiny truncate">{c.name}</div>
                            <div className="text-tiny text-gray-500 truncate" title={c.image}>{c.image}</div>
                          </div>
                          <button
                            onClick={() => restartCollector(c.name)}
                            disabled={restartingName === c.name}
                            className="inline-flex items-center gap-1 px-2 py-1 text-tiny rounded bg-warning/20 hover:bg-warning/30 text-warning font-semibold uppercase tracking-wider disabled:opacity-60"
                          >
                            {restartingName === c.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            {restartingName === c.name ? 'Restarting' : 'Restart'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {restartResult && (
                    <div className={`px-3 py-2 border-t border-gray-800 text-tiny ${restartResult.ok ? 'text-[#5eead4]' : 'text-danger'}`}>
                      {restartResult.ok ? '✓' : '×'} {restartResult.message}
                    </div>
                  )}
                  <div className="px-3 py-2 border-t border-gray-800 text-tiny text-gray-500 leading-relaxed">
                    Use when traces stop arriving despite the Stream pill showing Live — common when the OTel demo collector's <code className="font-mono text-gray-400">memory_limiter</code> trips after long runs.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {activeTab === 'overview' && (
          <OverviewTab
            data={ov.overview}
            heatmap={ov.heatmap}
            tracesHistogram={ov.tracesHistogram}
            priorTotals={ov.priorTotals}
            serviceMap={ov.serviceMap}
            loading={ov.loading}
            customRange={customRange}
            onClearCustomRange={() => setCustomRange(null)}
            onBucketClick={(s, u) => setCustomRange({ sinceMs: s, untilMs: u })}
            onDrilldownService={(name) => {
              setServiceFilter(name);
              setActiveTab('traces');
            }}
            onDrilldownError={(_exceptionType, serviceName) => {
              // Errors view filters by service in-page already via the existing
              // search box; we just jump the user to the right surface.
              if (serviceName) setServiceFilter(serviceName);
              setActiveTab('errors');
            }}
            onDrilldownHeatmapCell={(s, u, minDurationMs) => {
              setCustomRange({ sinceMs: s, untilMs: u });
              setMinMs(Math.max(0, Math.floor(minDurationMs)));
              setActiveTab('traces');
            }}
            helixEnv={helixEnv}
          />
        )}
        {activeTab === 'traces' && (
          <TracesTab
            traces={visibleTraces}
            services={visibleServices}
            serviceFilter={serviceFilter}
            setServiceFilter={setServiceFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            range={range}
            setRange={setRange}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            minMs={minMs}
            setMinMs={setMinMs}
            paused={tracesPaused}
            setPaused={setTracesPaused}
            streamConnected={streamConnected}
            helixEnv={helixEnv}
            operationP95={operationP95}
            tracesLoading={tracesLoading}
            onSelect={setSelectedTraceId}
            histogram={ov.tracesHistogram}
            customRange={customRange}
            onBucketClick={(s, u) => setCustomRange({ sinceMs: s, untilMs: u })}
            onClearCustomRange={() => setCustomRange(null)}
          />
        )}
        {activeTab === 'operations' && (
          <OperationsTab
            operations={operations}
            loading={operationsLoading}
            range={range}
            setRange={setRange}
            onJumpToOperation={(op) => {
              setSearchQuery(op);
              setActiveTab('traces');
            }}
          />
        )}
        {activeTab === 'errors' && (
          <LogsAndErrorsTab
            logs={visibleLogs}
            errors={visibleErrors}
            paused={logsPaused}
            setPaused={setLogsPaused}
            streamConnected={streamConnected}
            helixEnv={helixEnv}
            onJumpToTrace={(traceId) => {
              setActiveTab('traces');
              setSelectedTraceId(traceId);
            }}
            histogram={ov.logsHistogram}
            customRange={customRange}
            onBucketClick={(s, u) => setCustomRange({ sinceMs: s, untilMs: u })}
            onClearCustomRange={() => setCustomRange(null)}
          />
        )}
      </main>

      {selectedTraceId && (
        <TraceDetailDrawer
          traceId={selectedTraceId}
          detail={traceDetail}
          logs={traceLogs}
          loading={detailLoading}
          helixEnv={helixEnv}
          onClose={() => setSelectedTraceId(null)}
        />
      )}
    </div>
  );
};


const TraceDetailDrawer: React.FC<{
  traceId: string;
  detail: TraceDetail | null;
  logs: LogRecord[];
  loading: boolean;
  helixEnv: HelixEnv | null;
  onClose: () => void;
}> = ({ traceId, detail, logs, loading, helixEnv, onClose }) => {
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
          <div className="flex items-center gap-2">
            {(() => {
              const url = detail
                ? buildHelixTraceUrl(helixEnv, {
                    traceId,
                    serviceName: detail.summary.service_name,
                    timeNs: detail.summary.start_time_ns,
                  })
                : null;
              if (!url) return null;
              return (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-gray-800 hover:border-[#FF5A4D] text-tiny uppercase tracking-wider font-semibold text-gray-300 hover:text-white transition-colors"
                >
                  <BmcChevron className="h-4 w-auto" />
                  View in Helix
                  <ExternalLink className="w-4 h-4 opacity-70" />
                </a>
              );
            })()}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-200 p-1 rounded hover:bg-gray-800">
              <X className="w-5 h-5" />
            </button>
          </div>
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
  const [criticalPathOnly, setCriticalPathOnly] = useState(false);
  const [traceView, setTraceView] = useState<'waterfall' | 'flame'>('waterfall');
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
              tone={sqlRollup.some(b => b.maxMs > SLOW_THRESHOLD_MS) ? 'warning' : 'info'}
              columns={['Query', 'Count', 'Total', 'Slowest']}
              rows={sqlRollup.slice(0, 10).map(b => ({
                key: b.key,
                cells: [
                  <span className="font-mono text-tiny truncate inline-block max-w-[24rem]" title={b.display}>
                    <span className="text-gray-500">{b.system}: </span>{b.display}
                  </span>,
                  String(b.count),
                  formatDuration(b.totalMs),
                  <span className={b.maxMs > SLOW_THRESHOLD_MS ? 'text-warning font-semibold' : ''}>{formatDuration(b.maxMs)}</span>,
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
              tone={httpHasError ? 'danger' : httpRollup.some(b => b.maxMs > SLOW_THRESHOLD_MS) ? 'warning' : 'info'}
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
                        className={`text-tiny font-mono px-1 rounded ${code >= 500 ? 'bg-danger/20 text-[#ff8a8a]' : code >= 400 ? 'bg-warning/20 text-warning' : 'bg-gray-800 text-gray-300'}`}
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
            {traceView === 'waterfall' ? `${ordered.filter(o => !criticalPathOnly || criticalPath.has(o.span.spanId)).length} spans` : `${spans.length} spans • aggregated by depth`}
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
              {ordered.filter(o => !criticalPathOnly || criticalPath.has(o.span.spanId)).map(({ span, depth }) => (
                <SpanRow
                  key={`${span.spanId}-${span.traceId}`}
                  span={span}
                  depth={depth}
                  traceStartNs={traceStartNs}
                  traceDurationNs={traceDurationNs}
                  logs={logsBySpan.get(span.spanId) || []}
                  isOnCriticalPath={criticalPath.has(span.spanId)}
                  criticalInterval={criticalIntervals.get(span.spanId) || null}
                />
              ))}
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
                <td key={i} className={`px-3 py-1 ${i === 0 ? 'text-gray-200' : 'text-right text-gray-300 font-mono'}`}>{c}</td>
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

// Inline BMC chevron — kept alongside the Lucide icons so it inherits
// Tailwind sizing the same way (browser was rendering the standalone .svg
// file at its intrinsic 20×32 viewBox dimensions instead of honoring
// h-3.5 / h-4 from className, making it tower over the trailing link icon).

// Stable color for a service name across renders. Hash → palette index. Same
// service always gets the same swatch so the breakdown bar matches the
// inline service labels.
const SERVICE_PALETTE = [
  '#7c5cff', '#3759d8', '#11845b', '#0c8aa4', '#d99100',
  '#c42a3f', '#7a2db8', '#1a8a7e', '#a84300', '#5c5c8a',
];
const colorForService = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return SERVICE_PALETTE[Math.abs(h) % SERVICE_PALETTE.length];
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
              className="opacity-80 hover:opacity-100 transition-opacity"
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-tiny">
        {breakdown.map(b => (
          <div key={b.name} className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: colorForService(b.name) }} />
            <span className="text-gray-300 font-mono">{b.name}</span>
            <span className="text-gray-500 font-mono">{formatDuration(b.totalMs)}</span>
            <span className="text-gray-600">({(b.totalMs / denom * 100).toFixed(0)}%)</span>
          </div>
        ))}
      </div>
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
  isOnCriticalPath: boolean;
  criticalInterval: { startNs: number; endNs: number } | null;
}> = ({ span, depth, traceStartNs, traceDurationNs, logs, isOnCriticalPath, criticalInterval }) => {
  const [open, setOpen] = useState(false);
  const offsetNs = Math.max(0, span.startTimeNs - traceStartNs);
  const widthNs = Math.max(1, span.endTimeNs - span.startTimeNs);
  const leftPct = (offsetNs / traceDurationNs) * 100;
  const widthPct = Math.max(0.5, (widthNs / traceDurationNs) * 100);

  const isError = span.statusCode === 2 || span.events.some(e => e.name === 'exception');
  const isSlow = span.durationMs > SLOW_THRESHOLD_MS;
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
  const isSlowDb = !!dbSystem && span.durationMs > SLOW_THRESHOLD_MS;

  // Off-path spans dim so the critical-path chain reads as a band of more-
  // saturated bars connecting through the waterfall (the Elastic / Lightstep
  // pattern: emphasis by recession, not by overlay or border). Static class
  // names so Tailwind's content scanner generates them at build time.
  const barColor = isError
    ? (isOnCriticalPath ? 'bg-danger/80' : 'bg-danger/30')
    : isSlow
      ? (isOnCriticalPath ? 'bg-warning/80' : 'bg-warning/30')
      : dbSystem
        ? (isOnCriticalPath ? 'bg-active/80' : 'bg-active/30')
        : (isOnCriticalPath ? 'bg-primary/80' : 'bg-primary/30');

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
              {logs.length > 0 && (
                <span
                  className={`${logBadgeClass} flex-shrink-0 inline-flex items-center gap-1`}
                  title={`${logs.length} log record${logs.length === 1 ? '' : 's'} on this span — expand to view`}
                >
                  <FileText className="w-2.5 h-2.5" />{logs.length}
                </span>
              )}
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
            title={`${formatDuration(span.durationMs)} @ +${formatDuration(offsetNs / 1e6)}${isOnCriticalPath ? ' • on critical path' : ''}`}
          />
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

          {dbStatement ? (
            <div>
              <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold mb-1">Query</div>
              <pre className="bg-gray-1000 border border-gray-800 rounded p-2 text-tiny text-gray-200 font-mono whitespace-pre-wrap break-all" style={{ fontFamily: "'Source Code Pro', monospace" }}>{dbStatement}</pre>
              {isSlowDb && (
                <div className="mt-1 text-tiny text-warning">⚠ This DB span is slow (&gt; 1 s) — consider an index, batching, or caching.</div>
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

// Item 4: flame graph (icicle, top-down). Layered by tree depth, each rect's
// width proportional to span duration, x position to its offset from trace
// start. Color by service so you can see service handoffs at a glance.
// Off-path spans dim to match the waterfall convention.
const FlameView: React.FC<{
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
            <div className="text-gray-100 font-mono break-all">{hover.span.name}</div>
            <div className="text-gray-400 mt-0.5">
              <span className="font-mono">{hover.span.serviceName}</span>
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
