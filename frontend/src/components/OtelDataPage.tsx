import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  Clock,
  Download,
  ExternalLink,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  Server,
  Wrench,
  X,
} from 'lucide-react';
import { TimelineChart, TIMELINE_COLORS } from './TimelineChart';
import { OverviewTab } from './OverviewTab';
import { useOverview } from '../hooks/useOverview';
import { usePageRefresh, REFRESH_INTERVAL_MS } from '../hooks/usePageRefresh';
import type { StreamMode } from '../hooks/usePageRefresh';
import { isStreamLive } from '../hooks/usePageRefresh';
import { useLocalStorageState } from '../hooks/useLocalStorageState';

// Shared types/utilities + sub-tab components — moved out of this file to
// keep OtelDataPage focused on page-level wiring rather than per-tab UI.
import type { HelixEnv, OperationStat, TraceDetail, TraceStatus, TraceSummary, TimeRange, LogRecord, ErrorRecord } from './otel-data/types';
import { TIME_RANGES, SLOW_THRESHOLD_MS, INTERNAL_SERVICES } from './otel-data/constants';
import { SlowThresholdProvider } from './otel-data/SlowThresholdContext';
import { traceStatus } from './otel-data/utils';
import { CustomRangePopover } from './otel-data/CustomRangePopover';
import { TabButton } from './otel-data/TabButton';
import { TracesTab } from './otel-data/TracesTab';
import { OperationsTab } from './otel-data/OperationsTab';
import { LogsAndErrorsTab } from './otel-data/LogsAndErrorsTab';
import { TraceDetailDrawer } from './otel-data/trace-detail/TraceDetailDrawer';
import { NavAvatar } from './NavAvatar';


const HeaderUserMenu: React.FC = () => {
  const [authStatus, setAuthStatus] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => setAuthStatus({ required: !!d.required, authenticated: !!d.authenticated }))
      .catch(() => setAuthStatus({ required: false, authenticated: true }));
  }, []);
  return (
    <NavAvatar
      authStatus={authStatus}
      onLogout={async () => {
        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        window.location.href = '/';
      }}
    />
  );
};


const readUrlState = () => {
  if (typeof window === 'undefined') return { service: '', namespace: '', container: '', status: '' as '' | TraceStatus, range: '1h' as TimeRange, q: '', minMs: 0, selected: null as string | null };
  const p = new URLSearchParams(window.location.search);
  const range = (p.get('range') as TimeRange) || '1h';
  const validRange = TIME_RANGES.some(r => r.value === range) ? range : '1h';
  const status = p.get('status') as '' | TraceStatus;
  const validStatus = (['', 'error', 'slow', 'ok', 'outlier'].includes(status) ? status : '') as '' | TraceStatus;
  const minMsRaw = parseInt(p.get('minMs') || '0', 10);
  return {
    service: p.get('service') || '',
    // Resource-level filters added alongside service. Empty string means
    // "no filter applied" — same convention as service.
    namespace: p.get('namespace') || '',
    container: p.get('container') || '',
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
  // Sub-tab inside the Logs & Errors tab. Lifted up so the tab-strip error
  // pill can land directly on 'errors' instead of always defaulting to 'logs'.
  const [logsErrorsSubTab, setLogsErrorsSubTab] = useState<'logs' | 'errors'>('logs');
  const [operations, setOperations] = useState<OperationStat[]>([]);
  const [operationsLoading, setOperationsLoading] = useState<boolean>(false);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [services, setServices] = useState<{ name: string; traceCount: number }[]>([]);
  // Distinct namespace/container values for filter dropdowns. Fetched
  // alongside services from /api/traces/filter-values — see the populate
  // effect below.
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [containers, setContainers] = useState<string[]>([]);
  const [errors, setErrors] = useState<ErrorRecord[]>([]);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [serviceFilter, setServiceFilter] = useState<string>(initial.service);
  const [namespaceFilter, setNamespaceFilter] = useState<string>(initial.namespace);
  const [containerFilter, setContainerFilter] = useState<string>(initial.container);
  const [statusFilter, setStatusFilter] = useState<'' | TraceStatus>(initial.status);
  const [range, setRange] = useState<TimeRange>(initial.range);
  const [searchQuery, setSearchQuery] = useState<string>(initial.q);
  const [minMs, setMinMs] = useState<number>(initial.minMs);
  // Pause state now derives from the single streamMode below — see the
  // ALLOWED_MODES localStorage state. Both feeds are paused together;
  // splitting them out per-tab was a quirk no one used.
  const [helixEnv, setHelixEnv] = useState<HelixEnv | null>(null);
  // Detected upstream OTel collectors and the "stream stalled? restart it"
  // affordance. Populated on mount + every 60s so the menu always reflects
  // current host state.
  const [detectedCollectors, setDetectedCollectors] = useState<Array<{ name: string; image: string }>>([]);
  const [diagOpen, setDiagOpen] = useState(false);
  const [restartingName, setRestartingName] = useState<string | null>(null);
  const [restartResult, setRestartResult] = useState<{ name: string; ok: boolean; message: string } | null>(null);
  // Diagnostics → "Export to JSON". Bundles a sampled subset of the current
  // trace/log/error view into a downloadable file for sharing in a support
  // ticket / bug repro. Sample cap keeps file size sane.
  const [exporting, setExporting] = useState(false);
  const EXPORT_TRACE_CAP = 25;
  const diagRef = useRef<HTMLDivElement | null>(null);

  // Timeline state. customRange is set when the user clicks a bucket on the
  // chart — it zooms the trace/log list into that bucket's window while the
  // chart itself stays at the broader `range` and shades the selection.
  const [customRange, setCustomRange] = useState<{ sinceMs: number; untilMs: number } | null>(null);
  const ALLOWED_MODES: StreamMode[] = ['live', '30s', '1m', '5m', 'paused'];
  const [streamMode, setStreamMode] = useLocalStorageState<StreamMode>(
    'helix-otel.streamMode',
    'live',
    (v): v is StreamMode => typeof v === 'string' && ALLOWED_MODES.includes(v as StreamMode),
  );
  // Derived: are we paused for the purposes of SSE merge / poll skipping?
  // Anything other than 'live' freezes SSE; 'paused' also stops polling.
  const streamLive = isStreamLive(streamMode);
  const tracesPaused = !streamLive;
  const logsPaused = !streamLive;
  // User-configurable "slow" threshold. Default mirrors the historical
  // SLOW_THRESHOLD_MS constant. Validate as a positive finite number so a
  // corrupted localStorage value doesn't break rendering.
  const [slowThresholdMs, setSlowThresholdMs] = useLocalStorageState<number>(
    'helix-otel.slowThresholdMs',
    SLOW_THRESHOLD_MS,
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
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

  const exportDiagnostics = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      // Sample = first N of the currently-rendered list. The list is already
      // ordered by the user's active sort (typically received-desc), so this
      // captures "what's at the top of my Traces tab right now". A random
      // sample would be less reproducible across exports.
      const sampled = traces.slice(0, EXPORT_TRACE_CAP);
      const details = await Promise.all(sampled.map(t =>
        fetch(`/api/traces/${t.trace_id}`)
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      ));

      // Redact the endpoint host (keeps scheme + path so debugging path/auth
      // shapes still works). Leave tenantId / source / businessServiceKey —
      // those are tenant identifiers, not secrets, and they're often what a
      // support engineer needs to correlate. The full API key never makes it
      // here in the first place (only its tenant-prefix is exposed via
      // /api/env), so no extra redaction needed.
      const redactEndpoint = (ep: string): string => {
        if (!ep) return ep;
        try {
          const u = new URL(ep);
          return `${u.protocol}//<redacted-host>${u.pathname}${u.search}`;
        } catch {
          return '<redacted>';
        }
      };

      const bundle = {
        exportedAt: new Date().toISOString(),
        exportVersion: 1,
        view: {
          activeTab,
          filters: {
            service: serviceFilter || null,
            namespace: namespaceFilter || null,
            container: containerFilter || null,
            status: statusFilter || null,
            search: searchQuery || null,
            minMs,
          },
          range,
          customRange,
          slowThresholdMs,
        },
        helixEnv: helixEnv
          ? {
              endpoint: redactEndpoint(helixEnv.endpoint),
              tenantId: helixEnv.tenantId,
              source: helixEnv.source,
              businessServiceKey: helixEnv.businessServiceKey,
            }
          : null,
        sample: {
          tracesAvailable: traces.length,
          tracesIncluded: details.filter(Boolean).length,
          strategy: `first ${EXPORT_TRACE_CAP} of current sort order`,
        },
        traces: details.filter(Boolean),
        errors,
        logs,
      };

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `helix-otel-export-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

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
          businessServiceKey: env.BUSINESS_SERVICE_KEY || '',
        });
      })
      .catch(() => { /* env unset — links just won't render */ });
  }, []);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(initial.selected);
  const [traceDetail, setTraceDetail] = useState<TraceDetail | null>(null);
  const [traceLogs, setTraceLogs] = useState<LogRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tracesLoading, setTracesLoading] = useState(true);
  // SSE connection state — only meaningful in Live stream mode. Surfaces as
  // a small dot next to the Stream selector so users have an honest signal
  // when the live feed has silently dropped (the bug that lost this
  // indicator when the unifier shipped).
  const [sseConnected, setSseConnected] = useState(false);

  const visibleTraces = useMemo(() => {
    // Backend listTraces / tracesHistogram already filter out all-internal
    // traces via the "any non-internal participating span" rule. Filtering
    // here on t.service_name (root) would incorrectly hide app traces in
    // pipelines that re-root every forwarded trace at helix-gateway —
    // which is exactly what we saw in testing.
    let out = traces.slice();
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
      out = out.filter(t => traceStatus(t, slowThresholdMs) === statusFilter);
    }
    if (minMs > 0) out = out.filter(t => t.duration_ms >= minMs);
    // searchQuery is applied server-side in refreshTraces.
    return out;
  }, [traces, statusFilter, minMs, operations, slowThresholdMs]);
  const visibleServices = useMemo(
    () => services.filter(s => !INTERNAL_SERVICES.has(s.name)),
    [services],
  );
  // Helix shows traces per service and never has an empty selection. On first
  // load (when the URL didn't pin a service) auto-select the busiest service so
  // the Traces table is populated immediately. The ref makes this fire once —
  // afterwards an empty serviceFilter means the user explicitly chose "All
  // services", which the Traces tab renders as a "pick a service" prompt.
  const didAutoSelectService = useRef(false);
  useEffect(() => {
    if (didAutoSelectService.current) return;
    if (serviceFilter) { didAutoSelectService.current = true; return; }
    if (visibleServices.length === 0) return;
    const busiest = visibleServices.reduce((a, b) => (b.traceCount > a.traceCount ? b : a), visibleServices[0]);
    setServiceFilter(busiest.name);
    didAutoSelectService.current = true;
  }, [serviceFilter, visibleServices]);
  // serviceFilter is page-level state (Traces uses it server-side). For
  // Logs/Errors we apply it client-side here — the stores aren't huge (200
  // rows each) so a JS filter on every change is fine, and a server-side
  // query would lag SSE-pushed entries between polls.
  // SSE merges live records into state regardless of the active window. For
  // relative ranges that's fine — new records have received_at ≈ now and fall
  // inside "last X". A customRange in the past, though, would otherwise let
  // those fresh records leak into the list. Enforce the window client-side so
  // the next render drops them.
  const visibleErrors = useMemo(
    () => errors.filter(e => {
      if (INTERNAL_SERVICES.has(e.service_name)) return false;
      if (serviceFilter && e.service_name !== serviceFilter) return false;
      if (customRange && (e.received_at < customRange.sinceMs || e.received_at > customRange.untilMs)) return false;
      return true;
    }),
    [errors, serviceFilter, customRange],
  );
  const visibleLogs = useMemo(
    () => logs.filter(l => {
      if (INTERNAL_SERVICES.has(l.serviceName)) return false;
      if (serviceFilter && l.serviceName !== serviceFilter) return false;
      if (customRange && (l.receivedAt < customRange.sinceMs || l.receivedAt > customRange.untilMs)) return false;
      return true;
    }),
    [logs, serviceFilter, customRange],
  );

  const eventSourceRef = useRef<EventSource | null>(null);
  // Read inside the SSE handler so toggling pause doesn't tear down/rebuild
  // the EventSource — the closure captures the refs, not the booleans.
  const tracesPausedRef = useRef(tracesPaused);
  const logsPausedRef = useRef(logsPaused);
  // serviceFilter is also read inside the SSE handler so the live merge
  // skips traces that don't participate in the active filter (otherwise
  // long-lived traces from other services bypass the filter on the bulk
  // /api/traces query).
  const serviceFilterRef = useRef(serviceFilter);
  useEffect(() => { serviceFilterRef.current = serviceFilter; }, [serviceFilter]);
  // Same pattern for namespace/container — SSE handler reads via ref so
  // the live merge respects the active filters without re-subscribing
  // every time the filter changes.
  const namespaceFilterRef = useRef(namespaceFilter);
  useEffect(() => { namespaceFilterRef.current = namespaceFilter; }, [namespaceFilter]);
  const containerFilterRef = useRef(containerFilter);
  useEffect(() => { containerFilterRef.current = containerFilter; }, [containerFilter]);
  useEffect(() => { tracesPausedRef.current = tracesPaused; }, [tracesPaused]);
  useEffect(() => { logsPausedRef.current = logsPaused; }, [logsPaused]);

  // Push current filter + selection state into the URL. replaceState (not
  // push) so each keystroke in the search box doesn't pile up history.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams();
    if (serviceFilter) p.set('service', serviceFilter);
    if (namespaceFilter) p.set('namespace', namespaceFilter);
    if (containerFilter) p.set('container', containerFilter);
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
  }, [serviceFilter, namespaceFilter, containerFilter, statusFilter, range, searchQuery, minMs, selectedTraceId]);

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
    if (namespaceFilter) params.set('namespace', namespaceFilter);
    if (containerFilter) params.set('container', containerFilter);
    const w = resolveWindow();
    if (w.sinceMs != null) params.set('sinceMs', String(w.sinceMs));
    if (w.untilMs != null) params.set('untilMs', String(w.untilMs));
    if (searchQuery.trim()) params.set('q', searchQuery.trim());
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
  //
  // The window MUST be memoized — resolveChartWindow uses Date.now(), so
  // computing it inline produces new sinceMs/untilMs on every render. That
  // makes useOverview's deps unstable and causes a fetch-on-every-render
  // loop (observed at ~50 req/s, 22% CPU, 1.8 MB/s network). refreshNonce
  // is bumped on explicit refresh ticks so the window does advance when
  // we actually want fresh data.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const overviewWindow = useMemo<{ sinceMs?: number; untilMs?: number }>(() => {
    // customRange (set by click/drag on any histogram) takes precedence
    // so the bundle re-fetches with the zoomed window — histograms rebin
    // to finer buckets and the headline stats reflect the selection,
    // matching how resolveWindow() already drives refreshTraces/Logs/Errors.
    if (customRange) return { sinceMs: customRange.sinceMs, untilMs: customRange.untilMs };
    const r = TIME_RANGES.find(x => x.value === range);
    if (!r?.ms) return {};
    const now = Date.now();
    return { sinceMs: now - r.ms, untilMs: now };
    // refreshNonce intentionally drives the recompute alongside range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, customRange, refreshNonce]);
  const ov = useOverview({
    sinceMs: overviewWindow.sinceMs,
    untilMs: overviewWindow.untilMs,
    service: serviceFilter || undefined,
    namespace: namespaceFilter || undefined,
    container: containerFilter || undefined,
    slowThresholdMs,
  });

  const refreshServices = useCallback(async () => {
    // Two endpoints fetched in parallel: services for the existing dropdown
    // and filter-values for the namespace/container dropdowns. Both return
    // lifetime distinct values; neither is expensive enough to warrant a
    // single composite endpoint.
    //
    // Narrowing is one-way: the Service dropdown narrows by the active
    // namespace/container so picking a namespace shrinks the service list
    // to services that participate in it. Namespace and Container lists are
    // intentionally NOT narrowed by the active service — many services
    // (Jaeger HotROD-style demos in particular) don't carry a
    // service.namespace, and narrowing the Namespace picker by them would
    // shrink its options to empty and strand any active namespace filter.
    const svcParams = new URLSearchParams();
    if (namespaceFilter) svcParams.set('namespace', namespaceFilter);
    if (containerFilter) svcParams.set('container', containerFilter);
    const [svcRes, fvRes] = await Promise.all([
      fetch(`/api/traces/services${svcParams.toString() ? `?${svcParams}` : ''}`),
      fetch('/api/traces/filter-values'),
    ]);
    if (svcRes.ok) {
      const j = await svcRes.json();
      setServices(j.services || []);
    }
    if (fvRes.ok) {
      const j = await fvRes.json();
      setNamespaces(Array.isArray(j.namespaces) ? j.namespaces : []);
      setContainers(Array.isArray(j.containers) ? j.containers : []);
    }
  }, [namespaceFilter, containerFilter]);

  const refreshErrors = async () => {
    const params = new URLSearchParams();
    const w = resolveWindow();
    if (w.sinceMs != null) params.set('sinceMs', String(w.sinceMs));
    if (w.untilMs != null) params.set('untilMs', String(w.untilMs));
    const qs = params.toString();
    const res = await fetch(`/api/traces/errors${qs ? `?${qs}` : ''}`);
    if (res.ok) {
      const j = await res.json();
      setErrors(j.errors || []);
    }
  };

  const refreshLogs = async () => {
    const params = new URLSearchParams({ limit: '500' });
    const w = resolveWindow();
    if (w.sinceMs != null) params.set('sinceMs', String(w.sinceMs));
    if (w.untilMs != null) params.set('untilMs', String(w.untilMs));
    const res = await fetch(`/api/logs?${params}`);
    if (res.ok) {
      const j = await res.json();
      setLogs(j.logs || []);
    }
  };

  // useCallback so usePageRefresh below holds a stable poll reference until
  // an underlying input actually changes — otherwise the interval would tear
  // down and re-create on every render.
  const refreshOperations = useCallback(async () => {
    setOperationsLoading(true);
    try {
      const params = new URLSearchParams();
      const w = resolveWindow();
      if (w.sinceMs != null) params.set('sinceMs', String(w.sinceMs));
      if (w.untilMs != null) params.set('untilMs', String(w.untilMs));
      if (namespaceFilter) params.set('namespace', namespaceFilter);
      if (containerFilter) params.set('container', containerFilter);
      params.set('slowThresholdMs', String(slowThresholdMs));
      const res = await fetch(`/api/operations?${params}`);
      if (res.ok) {
        const j = await res.json();
        setOperations(j.operations || []);
      }
    } finally {
      setOperationsLoading(false);
    }
  }, [range, customRange, slowThresholdMs, namespaceFilter, containerFilter]);

  // Fetch on initial mount + whenever underlying inputs change. Operations
  // data also feeds the Traces tab's outlier flagging (rows whose duration
  // exceeds 2× p95 of their operation), so the refresh runs regardless of
  // which tab is active.
  useEffect(() => {
    refreshOperations();
  }, [refreshOperations]);
  // Switching to the Operations tab refreshes immediately so the user
  // doesn't see stale data while waiting for the periodic poll.
  useEffect(() => {
    if (activeTab === 'operations') refreshOperations();
  }, [activeTab, refreshOperations]);
  // Periodic refresh honors the page-wide stream mode (live / 30s / 1m / 5m /
  // paused) — previously this was hardcoded to 60s and ignored the user's
  // stream-mode selection.
  usePageRefresh(streamMode, refreshOperations);

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
  }, [serviceFilter, namespaceFilter, containerFilter, range, customRange]);

  // Search runs server-side now, so it has to trigger a refetch. Debounced
  // so typing doesn't hammer the backend on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setTracesLoading(true);
      refreshTraces();
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Reload logs whenever the active time window changes (including click-zoom).
  useEffect(() => {
    refreshLogs();
  }, [range, customRange]);

  useEffect(() => {
    refreshErrors();
  }, [range, customRange]);

  // Periodic re-fetch so the rollup counts (logs/errors/db calls) on
  // SSE-pushed traces catch up — those arrive with counts at 0 because
  // the trace summary is emitted before logs and the rest of the spans
  // settle. Skip while paused to respect the user's freeze. Also skip
  // when SSE is healthy in Live mode: the trace_counts_update event
  // already keeps rollup counts current, so this poll is pure redundant
  // work. The fallback path still runs whenever SSE drops.
  const sseConnectedRef = useRef(sseConnected);
  sseConnectedRef.current = sseConnected;
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  useEffect(() => {
    const id = setInterval(() => {
      if (tracesPausedRef.current) return;
      if (streamModeRef.current === 'live' && sseConnectedRef.current) return;
      refreshTraces();
    }, 30_000);
    return () => clearInterval(id);
  }, [serviceFilter, namespaceFilter, containerFilter, range, customRange]);

  // Page-wide refresh cadence. useOverview auto-fetches when its inputs
  // (serviceFilter, chart window) change; this hook drives the periodic
  // re-poll cadence. Auto-pauses when the tab is hidden, and now also
  // when the stream is manually paused — otherwise the chart kept
  // sliding even though the trace list was frozen, which felt buggy.
  const pausedAwareRefresh = useCallback(() => {
    if (tracesPausedRef.current) return;
    // Bump the nonce so overviewWindow advances; useOverview's effect will
    // pick up the new args and refetch. Avoids calling ov.refresh() directly
    // (which would fetch with the OLD window).
    setRefreshNonce(n => n + 1);
  }, []);
  usePageRefresh(streamMode, pausedAwareRefresh);

  // Clearing the customRange when the user switches the relative range keeps
  // the two pickers consistent — the new range implies "show everything in
  // this window, no sub-zoom".
  useEffect(() => {
    setCustomRange(null);
  }, [range]);

  useEffect(() => {
    refreshErrors();
    refreshLogs();
  }, []);

  // Service/Namespace/Container dropdowns are mutually narrowed by the
  // active filters, so refetch whenever any of them changes (refreshServices'
  // own deps capture the current values). 30s tick picks up new services
  // emitting their first span without a full page reload — recreating the
  // interval on filter change keeps it bound to the current closure.
  useEffect(() => {
    refreshServices();
    const id = setInterval(refreshServices, 30_000);
    return () => clearInterval(id);
  }, [refreshServices]);

  // Realtime SSE — push new traces and errors into the lists without polling.
  // The connection is shared across both tabs; tab switches don't tear it down.
  useEffect(() => {
    const es = new EventSource('/api/traces/stream');
    eventSourceRef.current = es;
    es.addEventListener('connected', () => setSseConnected(true));
    es.addEventListener('trace', (evt: MessageEvent) => {
      // Pause: stop merging incoming traces so the user's view stays stable
      // while they read. Unpausing resumes the live feed; a fresh /api/traces
      // call would be needed to backfill what was missed (we don't bother).
      if (tracesPausedRef.current) return;
      try {
        const summary: TraceSummary & {
          participating_services?: string[];
          participating_namespaces?: string[];
          participating_containers?: string[];
        } = JSON.parse(evt.data);
        // Honor the active service filter on the live merge. /api/traces
        // filters by participant; SSE must too, or long-lived traces from
        // other services (e.g. flagd EventStreams) bypass the filter and
        // dominate the list. Backend tags each summary with the
        // participating_services array exactly for this check.
        const activeFilter = serviceFilterRef.current;
        if (activeFilter) {
          const participants = summary.participating_services;
          if (!participants || !participants.includes(activeFilter)) return;
        }
        // Same participant-membership check for namespace/container.
        // participating_namespaces/_containers may be empty arrays when
        // the trace's spans carry no namespace/container — in that case
        // any active filter rejects the trace (matches server behavior:
        // a NULL row never matches `WHERE service_namespace = ?`).
        const activeNs = namespaceFilterRef.current;
        if (activeNs) {
          const ns = summary.participating_namespaces;
          if (!ns || !ns.includes(activeNs)) return;
        }
        const activeContainer = containerFilterRef.current;
        if (activeContainer) {
          const cs = summary.participating_containers;
          if (!cs || !cs.includes(activeContainer)) return;
        }
        setTraces(prev => {
          const filtered = prev.filter(t => t.trace_id !== summary.trace_id);
          // Keep newest first, cap at 200 to mirror server query.
          return [summary, ...filtered].slice(0, 200);
        });
        // New service? Refresh the dropdown.
        setServices(prev => prev.some(s => s.name === summary.service_name)
          ? prev
          : [...prev, { name: summary.service_name, traceCount: 1 }].sort((a, b) => a.name.localeCompare(b.name)));
        // New namespace/container? Add to the filter dropdowns so the user
        // can pick them without waiting for the 30s services-refresh tick.
        if (summary.participating_namespaces?.length) {
          setNamespaces(prev => {
            const merged = new Set(prev);
            for (const n of summary.participating_namespaces!) merged.add(n);
            return merged.size === prev.length ? prev : Array.from(merged).sort();
          });
        }
        if (summary.participating_containers?.length) {
          setContainers(prev => {
            const merged = new Set(prev);
            for (const c of summary.participating_containers!) merged.add(c);
            return merged.size === prev.length ? prev : Array.from(merged).sort();
          });
        }
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
    es.onerror = () => setSseConnected(false);
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
    <SlowThresholdProvider value={slowThresholdMs}>
    <div className="flex h-screen w-full overflow-hidden bg-gray-1000 font-sans text-gray-100 flex-col">
      <header className="bg-helixNav flex items-center px-5 h-14 font-helix w-full flex-shrink-0 sticky top-0 z-40 border-b border-[#3a3f4a]">
        <div className="flex items-center gap-4">
          <a href="/" className="flex items-center" aria-label="Helix OTel Configurator home">
            <img src="/bmc-logo.svg" alt="BMC" className="h-7 w-auto" />
          </a>
          <h1 className="text-white font-normal text-[1.1875rem] m-0 tracking-normal">
            Helix OTel Configurator
          </h1>
        </div>
        <nav className="flex items-center gap-7 text-sm text-[#cfd3da] ml-10">
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
        <div className="ml-auto">
          <HeaderUserMenu />
        </div>
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
              onErrorCountClick={() => {
                setLogsErrorsSubTab('errors');
                setActiveTab('errors');
              }}
            />
          </div>
          <div className="flex items-center gap-3 pb-2">
            <div ref={customRangePopoverRef} className="relative">
              <label className="inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold text-gray-400">
                <Clock className="w-3.5 h-3.5" />
                Range
                <select
                  value={customRange ? 'custom' : range}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'custom') {
                      setCustomRangePopoverOpen(true);
                    } else {
                      setRange(v as TimeRange);
                    }
                  }}
                  title={customRange ? 'Custom window active. Pick a preset to clear, or re-select Custom… to edit.' : 'Time range. Persists across tabs.'}
                  className={`bg-gray-1000 border border-gray-800 rounded px-2 py-0.5 text-tiny focus:outline-none focus:border-link normal-case tracking-normal font-normal ${customRange ? 'text-link' : 'text-gray-200'}`}
                >
                  {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  <option value="custom">{customRange ? 'Custom window' : 'Custom…'}</option>
                </select>
              </label>
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
            {customRange && (
              <button
                onClick={() => { setCustomRange(null); setRange('1h'); }}
                title="Clear custom window and reset to default (1h)"
                className="inline-flex items-center gap-1 text-tiny uppercase tracking-wider font-semibold text-gray-400 hover:text-gray-200 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
            <label className="inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold text-gray-400">
              <RefreshCw className="w-3.5 h-3.5" />
              Auto-refresh
              <select
                value={streamMode}
                onChange={(e) => setStreamMode(e.target.value as StreamMode)}
                title="Live = realtime SSE + 30s rollup poll. 30s/1m/5m = snapshot poll at that cadence (no realtime). Paused = freeze the view."
                className={`bg-gray-1000 border rounded px-2 py-0.5 text-tiny focus:outline-none focus:border-link normal-case tracking-normal font-normal ${
                  streamMode === 'paused'
                    ? 'border-warning/60 text-warning'
                    : streamMode === 'live'
                      ? 'border-gray-800 text-[#5eead4]'
                      : 'border-gray-800 text-gray-200'
                }`}
              >
                <option value="live">Live</option>
                <option value="30s">30s</option>
                <option value="1m">1m</option>
                <option value="5m">5m</option>
                <option value="paused">Paused</option>
              </select>
              {streamMode === 'live' && (
                sseConnected ? (
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-[#5eead4] animate-pulse"
                    title="SSE connected. Live updates flowing."
                    aria-label="Live stream connected"
                    role="status"
                  />
                ) : (
                  // Explicit amber "Reconnecting" pill so a silent SSE failure
                  // doesn't look like "no traces" to the operator. Pairs with
                  // the eventSource.onerror handler that flips sseConnected.
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-tiny font-semibold bg-warning/15 text-warning border border-warning/30 normal-case tracking-normal"
                    title="SSE disconnected. Reconnecting."
                    role="status"
                    aria-live="polite"
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                    Reconnecting…
                  </span>
                )
              )}
            </label>
            <label className="inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold text-gray-400">
              <Clock className="w-3.5 h-3.5" />
              Slow threshold
              <select
                value={String(slowThresholdMs)}
                onChange={(e) => setSlowThresholdMs(parseInt(e.target.value, 10) || SLOW_THRESHOLD_MS)}
                title="Duration above which traces and spans are flagged as slow. Affects the Slow status filter, duration coloring, and the histogram's ok/slow segmentation."
                className="bg-gray-1000 border border-gray-800 rounded px-2 py-0.5 text-tiny text-gray-200 focus:outline-none focus:border-link normal-case tracking-normal font-normal"
              >
                <option value="250">250ms</option>
                <option value="500">500ms</option>
                <option value="1000">1s</option>
                <option value="2000">2s</option>
                <option value="5000">5s</option>
                <option value="10000">10s</option>
                {/* Render any non-preset persisted value (e.g. set via URL or
                    older session) so users can see + clear it. */}
                {![250, 500, 1000, 2000, 5000, 10000].includes(slowThresholdMs) && (
                  <option value={slowThresholdMs}>{slowThresholdMs}ms (custom)</option>
                )}
              </select>
            </label>
            {/*
              Resource-level filters live in the top bar so Overview, Operations,
              and Logs/Errors all see the same picker. The filter state itself is
              page-level — applies to every tab — and was previously only visible
              from Traces, which was confusing (active filter, no UI to clear it).
              Conditionally rendered: only show a dropdown if we've actually seen
              spans carrying that resource attr, so collectors that don't set
              service.namespace / container.name don't get a useless picker. The
              || namespaceFilter clause is belt-and-suspenders for a deep-linked
              filter that arrives before the first /filter-values response —
              keeps the (stale) clear-out option reachable.
              Highlighted with the active color when a filter is engaged so the
              non-Traces tabs (which have no other filter UI) make the active
              filter visible at a glance.
            */}
            {(namespaces.length > 0 || namespaceFilter) && (
              <label className="inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold text-gray-400">
                <Server className="w-3.5 h-3.5" />
                Namespace
                <select
                  value={namespaceFilter}
                  onChange={(e) => setNamespaceFilter(e.target.value)}
                  title="Filter by OTel resource attribute service.namespace. Applies to every tab."
                  className={`bg-gray-1000 border rounded px-2 py-0.5 text-tiny focus:outline-none focus:border-link normal-case tracking-normal font-normal ${
                    namespaceFilter ? 'border-active text-link' : 'border-gray-800 text-gray-200'
                  }`}
                >
                  <option value="">All</option>
                  {namespaces.map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                  {namespaceFilter && !namespaces.includes(namespaceFilter) && (
                    <option value={namespaceFilter}>{namespaceFilter} (stale)</option>
                  )}
                </select>
              </label>
            )}
            {(containers.length > 0 || containerFilter) && (
              <label className="inline-flex items-center gap-1.5 text-tiny uppercase tracking-wider font-semibold text-gray-400">
                <Server className="w-3.5 h-3.5" />
                Container
                <select
                  value={containerFilter}
                  onChange={(e) => setContainerFilter(e.target.value)}
                  title="Filter by OTel resource attribute container.name (or k8s.container.name). Applies to every tab."
                  className={`bg-gray-1000 border rounded px-2 py-0.5 text-tiny focus:outline-none focus:border-link normal-case tracking-normal font-normal ${
                    containerFilter ? 'border-active text-link' : 'border-gray-800 text-gray-200'
                  }`}
                >
                  <option value="">All</option>
                  {containers.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                  {containerFilter && !containers.includes(containerFilter) && (
                    <option value={containerFilter}>{containerFilter} (stale)</option>
                  )}
                </select>
              </label>
            )}
            <div ref={diagRef} className="relative">
              <button
                onClick={() => setDiagOpen(o => !o)}
                title="Diagnostics: restart upstream OTel collectors when the stream stalls"
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
                            <div className="text-gray-200 text-tiny truncate">{c.name}</div>
                            <div className="text-tiny text-gray-500 truncate" title={c.image}>{c.image}</div>
                          </div>
                          <button
                            onClick={() => restartCollector(c.name)}
                            disabled={restartingName === c.name}
                            className="inline-flex items-center gap-1 px-2 py-1 text-tiny rounded bg-warning/20 hover:bg-warning/30 text-warning font-semibold disabled:opacity-60"
                          >
                            {restartingName === c.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            {restartingName === c.name ? 'Restarting' : 'Restart'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {restartResult && (
                    <div className={`px-3 py-2 border-t border-gray-800 text-tiny inline-flex items-center gap-1.5 ${restartResult.ok ? 'text-[#5eead4]' : 'text-danger-text'}`}>
                      {restartResult.ok
                        ? <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        : <X className="w-3.5 h-3.5" aria-hidden="true" />}
                      {restartResult.message}
                    </div>
                  )}
                  <div className="px-3 py-2 border-t border-gray-800 text-tiny text-gray-500 leading-relaxed">
                    Use when traces stop arriving despite the Stream pill showing Live. Common when the OTel demo collector's <code className="font-mono text-gray-400">memory_limiter</code> trips after long runs.
                  </div>
                  {/* Bundles the currently-rendered traces (capped sample) +
                      all visible logs/errors + active filters + a redacted
                      copy of helixEnv into a single JSON file. Aimed at
                      attaching to support tickets so the recipient can see
                      both the data and the view configuration. */}
                  <div className="px-3 py-2 border-t border-gray-800">
                    <button
                      type="button"
                      onClick={exportDiagnostics}
                      disabled={exporting || traces.length === 0}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-tiny rounded bg-gray-800 hover:bg-gray-700 text-gray-200 font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
                      title={traces.length === 0 ? 'No traces in current view to export' : `Download a JSON bundle of the first ${Math.min(EXPORT_TRACE_CAP, traces.length)} traces in view (with their spans + logs), plus visible logs/errors and active filters. Endpoint host is redacted.`}
                    >
                      {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                      {exporting ? 'Exporting…' : 'Export to JSON'}
                      {!exporting && traces.length > 0 && (
                        <span className="text-tiny text-gray-500 font-normal">
                          ({Math.min(EXPORT_TRACE_CAP, traces.length)} of {traces.length})
                        </span>
                      )}
                    </button>
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
            slowThresholdMs={slowThresholdMs}
          />
        )}
        {activeTab === 'traces' && (
          <TracesTab
            traces={visibleTraces}
            services={visibleServices}
            serviceFilter={serviceFilter}
            setServiceFilter={setServiceFilter}
            namespaceFilter={namespaceFilter}
            containerFilter={containerFilter}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            minMs={minMs}
            setMinMs={setMinMs}
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
            services={visibleServices}
            serviceFilter={serviceFilter}
            setServiceFilter={setServiceFilter}
            helixEnv={helixEnv}
            onJumpToTrace={(traceId) => {
              setActiveTab('traces');
              setSelectedTraceId(traceId);
            }}
            histogram={ov.logsHistogram}
            customRange={customRange}
            onBucketClick={(s, u) => setCustomRange({ sinceMs: s, untilMs: u })}
            onClearCustomRange={() => setCustomRange(null)}
            subTab={logsErrorsSubTab}
            setSubTab={setLogsErrorsSubTab}
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
          operationP95={operationP95}
          onClose={() => setSelectedTraceId(null)}
        />
      )}
    </div>
    </SlowThresholdProvider>
  );
};
