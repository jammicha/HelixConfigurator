import React, { useState, useEffect, useRef } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { Settings, Loader2, X, Activity, Container, ExternalLink, BarChart2, Unlink, Server, ChevronDown, Hexagon, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useEscClose } from './hooks/useEscClose';
import { LoginScreen } from './components/LoginScreen';
import { ToastStack, Toast } from './components/ToastStack';
import { ConfirmDialog, ConfirmRequest } from './components/ConfirmDialog';
import { TemplatesModal, Template } from './components/TemplatesModal';
import { RawMetricsModal } from './components/RawMetricsModal';

// Helix's UI sometimes hands users the API key split across two fields:
//   Key details: <seg1>::<seg2>,Tenant ID: <digits>
// The actual X-API-Key header value is "<tenantId>::<seg1>::<seg2>". This
// pulls the pieces from a pasted blob (any order, any separator) and rebuilds
// the canonical key. Returns null if the blob doesn't look like that bundle.
const parseHelixKeyBundle = (raw: string): string | null => {
  if (!raw) return null;
  const keyMatch = raw.match(/Key\s*details\s*:\s*([A-Za-z0-9]+)::([A-Za-z0-9]+)/i);
  const tenantMatch = raw.match(/Tenant\s*ID\s*:\s*(\d+)/i);
  if (!keyMatch || !tenantMatch) return null;
  return `${tenantMatch[1]}::${keyMatch[1]}::${keyMatch[2]}`;
};

// Code/config snippet block with a corner Copy button. Text remains selectable
// (no whole-block click handler) so users can highlight just a section.
const SnippetBlock: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — user can still select+Cmd-C */ }
  };
  return (
    <div className="relative bg-gray-1000 rounded border border-gray-800 mb-6 overflow-hidden">
      <pre
        className="font-mono text-tiny text-gray-300 p-4 pr-20 overflow-x-auto select-text"
        style={{ fontFamily: "'Source Code Pro', monospace" }}
      >{text}</pre>
      <button
        type="button"
        onClick={onCopy}
        className={`absolute top-2 right-2 px-2 py-1 text-tiny rounded border transition-colors ${copied ? 'bg-success/20 text-[#5eead4] border-success/50' : 'bg-gray-900 hover:bg-gray-800 text-gray-300 border-gray-700'}`}
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
};

const App = () => {
  const monaco = useMonaco();
  const [config, setConfig] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [setupStep, setSetupStep] = useState(1);
  const [isVerifying, setIsVerifying] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [telemetryStatus, setTelemetryStatus] = useState('idle');
  const [collectorDiag, setCollectorDiag] = useState({ status: 'unknown', error: '', remediation: '' });
  const [apiKeyDiag, setApiKeyDiag] = useState({ status: 'unknown', error: '', remediation: '' });
  const [networkDiag, setNetworkDiag] = useState({ status: 'unknown', error: '', remediation: '' });
  const [expandedRemediations, setExpandedRemediations] = useState<Record<number, boolean>>({});
  const [gatewayStatus, setGatewayStatus] = useState('unknown'); // running, exited, restarting, error
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [isConfigSaving, setIsConfigSaving] = useState(false);
  // Stack of up to 3 toasts. Older toasts evict on overflow so a burst of
  // errors doesn't clobber earlier context.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef(new Map<number, any>());
  const TOAST_MAX = 3;
  const [logs, setLogs] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState<'helix' | 'all'>('helix');
  const [isRawMetricsOpen, setIsRawMetricsOpen] = useState(false);
  const [rawMetricsText, setRawMetricsText] = useState('');
  const [isLoadingRawMetrics, setIsLoadingRawMetrics] = useState(false);
  const [rawMetricsFilter, setRawMetricsFilter] = useState<'relevant' | 'all'>('relevant');
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplateId, setLoadingTemplateId] = useState<string | null>(null);
  const [liveMetrics, setLiveMetrics] = useState({ received: 0, sent: 0, failed: 0 });
  const [metricsHistory, setMetricsHistory] = useState<Array<{ received: number; sent: number; failed: number }>>([]);
  const METRICS_HISTORY_MAX = 60; // 3 minutes at 3s polling
  const [traceInjectionStatus, setTraceInjectionStatus] = useState(''); // success, error, ''
  const [diagAlert, setDiagAlert] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [sseAttempt, setSseAttempt] = useState(0);
  const [diagAlertCount, setDiagAlertCount] = useState(0);
  const diagAlertTimerRef = useRef<any>(null);

  // Lightweight in-memory event timeline shown above the log pane during a
  // diagnostic session. Helps answer "what changed?" without scraping logs.
  type TimelineKind = 'config-saved' | 'restart' | 'attach' | 'error-spike' | 'verify';
  type TimelineEvent = { ts: number; kind: TimelineKind; message: string };
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const TIMELINE_MAX = 30;
  const pushTimelineEvent = (kind: TimelineKind, message: string) => {
    setTimeline(prev => {
      const next = [...prev, { ts: Date.now(), kind, message }];
      return next.length > TIMELINE_MAX ? next.slice(-TIMELINE_MAX) : next;
    });
  };

  // Discovered Services State
  const [isServicesOpen, setIsServicesOpen] = useState(false);
  const [discoveredContainers, setDiscoveredContainers] = useState<any[]>([]);
  const [helixConfig, setHelixConfig] = useState({ baseUrl: '', tenantId: '', source: '', businessServiceKey: '' });
  const [loadingContainers, setLoadingContainers] = useState<Set<string>>(new Set());

  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const [isYamlOpen, setIsYamlOpen] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmRequest | null>(null);
  const [verifyingTrace, setVerifyingTrace] = useState(false);
  const [traceVerifyResult, setTraceVerifyResult] = useState<{ status: string; message: string; remediation?: string } | null>(null);
  // Bridge outcome from Step 1's /api/lifecycle/bridge call. Drives the
  // banner at the top of Step 2 so the user knows whether the auto-bridge
  // succeeded, was skipped, or failed — and what to do about it.
  const [bridgeStatus, setBridgeStatus] = useState<
    | { kind: 'success'; network: string; targetContainer: string }
    | { kind: 'skipped'; reason: string }
    | { kind: 'error'; reason: string }
    | null
  >(null);
  // Detected OTel collector containers running on this host. Populated when
  // Step 2 mounts; surfaced in the network callout so users with their own
  // collector can one-click attach helix-gateway to that collector's network.
  const [detectedCollectors, setDetectedCollectors] = useState<
    Array<{ name: string; image: string; networks: string[]; sharesNetworkWithSidecar: boolean; isKubernetes?: boolean }>
  >([]);
  const [attachingNetwork, setAttachingNetwork] = useState<string | null>(null);
  const [attachResult, setAttachResult] = useState<{ network: string; ok: boolean; message: string } | null>(null);
  // Wizard redesign — Step 3 + Step 4 state.
  const [gatewayConfigOpen, setGatewayConfigOpen] = useState(false);
  const [gatewayConfigText, setGatewayConfigText] = useState<string>('');
  const [step3Tab, setStep3Tab] = useState<'detected' | 'manual'>('detected');
  const [k8sApplying, setK8sApplying] = useState<boolean>(false);
  const [k8sApplyResult, setK8sApplyResult] = useState<'applied' | 'failed' | null>(null);
  const [recentServices, setRecentServices] = useState<string[]>([]);
  // Step 2 smart-add — read the customer collector's config and propose a
  // merge that wires helix-gateway in as an exporter on every existing
  // pipeline. Confirmation-guarded apply writes it back with a .helix-bak.
  const [smartAddProposal, setSmartAddProposal] = useState<{
    name: string;
    configPath: string;
    alreadyConfigured?: boolean;
    existingExporterName?: string;
    exporterName?: string;
    addedToPipelines?: string[];
    existingPipelines?: string[];
    proposedYaml?: string;
    error?: string;
  } | null>(null);
  const [smartAddLoading, setSmartAddLoading] = useState<boolean>(false);
  const [smartAddApplying, setSmartAddApplying] = useState<boolean>(false);
  const [smartAddResult, setSmartAddResult] = useState<{ ok: boolean; message: string } | null>(null);

  // App → Gateway verifier: poll the gateway's receiver counters and show
  // deltas since Step 2 was opened. Lets the user see real spans/metrics/logs
  // arriving from their app, not just the synthetic trace from the gateway.
  type ReceiverCounters = { acceptedSpans: number; acceptedMetricPoints: number; acceptedLogRecords: number };
  const [receiverBaseline, setReceiverBaseline] = useState<ReceiverCounters | null>(null);
  const [receiverNow, setReceiverNow] = useState<ReceiverCounters | null>(null);
  const [receiverError, setReceiverError] = useState('');
  const [appExportErrors, setAppExportErrors] = useState<{ container: string; lines: string[] }[]>([]);

  const [envVars, setEnvVars] = useState({
    HELIX_ENDPOINT: '',
    HELIX_API_KEY: '',
    X_SOURCE: '',
    APP_URL: '',
    BUSINESS_SERVICE_KEY: ''
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const metricsIntervalRef = useRef<any>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const editorRef = useRef<any>(null);
  const isTogglingDiagRef = useRef(false);

  const [envLoaded, setEnvLoaded] = useState(false);
  const [authStatus, setAuthStatus] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);
  const [isTogglingDiag, setIsTogglingDiag] = useState(false);
  const handleUpdateConfigRef = useRef<() => void>(() => {});
  const telemetryTimerRef = useRef<any>(null);

  // Derived state: first connected app (excluding the gateway itself)
  const connectedApp = discoveredContainers.find(c => !c.name.includes('helix-gateway') && c.networks.includes('helix-bridge'))?.name || null;
  const isGatewayConnected = discoveredContainers.some(c => c.name.includes('helix-gateway') && c.networks.includes('helix-bridge'));
  const isDiagnosticEnabled = isGatewayConnected;

  // Check auth status on mount; gate the rest of the app on it.
  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(data => setAuthStatus(data))
      .catch(() => setAuthStatus({ required: true, authenticated: false }));
  }, []);

  const performLogin = async (password: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthStatus({ required: true, authenticated: true });
        return { ok: true };
      }
      return { ok: false, error: 'Invalid password' };
    } catch {
      return { ok: false, error: 'Login request failed' };
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setAuthStatus({ required: true, authenticated: false });
  };

  useEffect(() => {
    // Tail-style follow: only auto-scroll if the user is already pinned to the
    // bottom. Setting scrollTop on the container directly — using
    // scrollIntoView() bubbles up and yanks the entire page when the log pane
    // isn't fully in the viewport, causing the layout to jitter on every log
    // line.
    if (shouldAutoScrollRef.current && logContainerRef.current) {
      const el = logContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleLogScroll = () => {
    const el = logContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 40;
  };

  // Final cleanup on unmount: close any open SSE streams, intervals, timers
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if ((eventSourceRef as any).currentApp) (eventSourceRef as any).currentApp.close();
      if (metricsIntervalRef.current) clearInterval(metricsIntervalRef.current);
      toastTimersRef.current.forEach(t => clearTimeout(t));
      toastTimersRef.current.clear();
      if (telemetryTimerRef.current) clearTimeout(telemetryTimerRef.current);
      if (diagAlertTimerRef.current) clearTimeout(diagAlertTimerRef.current);
    };
  }, []);

  // Fetch /api/config + /api/env once auth is resolved. Both endpoints are
  // gated by the requireAuth middleware, so calling them before login returns
  // {error: 'Unauthorized'} — which would clobber envVars and leave the
  // wizard's inputs blank even after the user logs in. Wait for an
  // authenticated state, then re-fetch on login changes.
  useEffect(() => {
    if (authStatus === null) return;
    if (authStatus.required && !authStatus.authenticated) return;

    fetch('/api/config')
      .then(res => res.json())
      .then(data => { if (data && typeof data.yaml === 'string') setConfig(data.yaml); })
      .catch(err => console.error('Failed to fetch config', err));

    fetch('/api/env')
      .then(res => res.json())
      .then(data => {
        // Defensive: only adopt the response if it has the expected shape.
        // (Could be an error envelope on permission edge cases.)
        if (!data || typeof data !== 'object' || 'error' in data) {
          setEnvLoaded(true);
          return;
        }
        setEnvVars(data);
        setEnvLoaded(true);
        // First-time visitors see the onboarding wizard even when .env is
        // pre-populated (e.g., by the AIOps install script). Only auto-jump
        // to the dashboard if the user has explicitly clicked through
        // onboarding before — tracked via localStorage.
        const onboardedBefore = localStorage.getItem('helix-configurator.onboarded') === '1';
        // ?view=onboarding lets the nav force the wizard view from any page
        // (e.g., clicking "Onboarding" while on /otel-data). Without this
        // signal, the user would land on the dashboard when previously onboarded.
        const params = new URLSearchParams(window.location.search);
        const forceOnboarding = params.get('view') === 'onboarding';
        if (onboardedBefore && data.HELIX_ENDPOINT && data.HELIX_API_KEY && !forceOnboarding) {
          setIsSetupComplete(true);
          fetchDiscoveredData(); // Get tokens if already setup
        }
      })
      .catch(err => {
        console.error('Failed to fetch env vars', err);
        setEnvLoaded(true);
      });
  }, [authStatus]);

  // Poll for Gateway Status
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const checkGateway = () => {
      // Skip while the tab is in the background. visibilitychange below
      // re-fires this immediately on return so the UI snaps current.
      if (document.visibilityState === 'hidden') return;
      fetch('/api/lifecycle/status', { signal: controller.signal })
        .then(res => res.json())
        .then(data => { if (!cancelled) setGatewayStatus(data.status); })
        .catch((err) => {
          if (cancelled || err.name === 'AbortError') return;
          setGatewayStatus('error');
        });
    };
    checkGateway();
    const interval = setInterval(checkGateway, 5000);
    const onVis = () => { if (document.visibilityState === 'visible') checkGateway(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Poll for Deep Collector Diagnostics
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const checkCollectorDiag = () => {
      if (document.visibilityState === 'hidden') return;
      fetch('/api/diagnostics/collector', { signal: controller.signal })
        .then(res => res.json())
        .then(data => { if (!cancelled) setCollectorDiag(data); })
        .catch((err) => {
          if (cancelled || err.name === 'AbortError') return;
          setCollectorDiag({ status: 'FAIL', error: 'API unreachable', remediation: '' });
        });
    };
    checkCollectorDiag();
    const interval = setInterval(checkCollectorDiag, 10000);
    const onVis = () => { if (document.visibilityState === 'visible') checkCollectorDiag(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Auto-close remediation if a check passes
  useEffect(() => {
    const statuses = [
      collectorDiag.status === 'PASS',
      apiKeyDiag.status === 'PASS',
      !!(envVars.X_SOURCE && envVars.X_SOURCE.length > 0),
      networkDiag.status === 'Success'
    ];

    setExpandedRemediations(prev => {
      let changed = false;
      const next = { ...prev };
      statuses.forEach((isPass, i) => {
        if (isPass && next[i]) {
          next[i] = false;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [collectorDiag.status, apiKeyDiag.status, envVars.X_SOURCE, networkDiag.status]);

  // Clear setup error once the user starts editing inputs again
  useEffect(() => {
    if (setupError) setSetupError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envVars]);

  // Poll for API Key Diagnostics
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const checkApiKeyDiag = () => {
      if (document.visibilityState === 'hidden') return;
      fetch('/api/diagnostics/apikey', { signal: controller.signal })
        .then(res => res.json())
        .then(data => { if (!cancelled) setApiKeyDiag(data); })
        .catch((err) => {
          if (cancelled || err.name === 'AbortError') return;
          setApiKeyDiag({ status: 'FAIL', error: 'API unreachable', remediation: '' });
        });
    };
    checkApiKeyDiag();
    const interval = setInterval(checkApiKeyDiag, 10000);
    const onVis = () => { if (document.visibilityState === 'visible') checkApiKeyDiag(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Poll the gateway's receiver counters while Step 4 is showing (the
  // verify step in the redesigned wizard). Sets a baseline on entry; the
  // UI shows current - baseline as the "since you opened Step 4" delta —
  // the most legible signal that the user's app is actually sending data
  // through the bridge.
  useEffect(() => {
    if (isSetupComplete || setupStep !== 4) {
      setReceiverBaseline(null);
      setReceiverNow(null);
      setReceiverError('');
      setAppExportErrors([]);
      return;
    }
    let cancelled = false;
    let baselineSet = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/diagnostics/receiver-counters');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (!cancelled) setReceiverError(data.error || 'Gateway metrics unreachable');
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setReceiverError('');
        setReceiverNow(data);
        if (!baselineSet) { setReceiverBaseline(data); baselineSet = true; }
      } catch (e: any) {
        if (!cancelled) setReceiverError(e?.message || 'Network error');
      }
    };
    tick();
    const interval = setInterval(tick, 2000);

    // Slower scan of app-side logs for OTel export errors. Every 8s is plenty
    // — these errors persist across log lines and we don't want to hammer the
    // docker daemon doing tail-200 reads on every other tick.
    const scanErrors = async () => {
      if (cancelled) return;
      try {
        const r = await fetch('/api/diagnostics/app-export-errors');
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setAppExportErrors(data.errors || []);
      } catch { /* non-fatal */ }
    };
    scanErrors();
    const errInterval = setInterval(scanErrors, 8000);
    return () => { cancelled = true; clearInterval(interval); clearInterval(errInterval); };
  }, [setupStep, isSetupComplete]);

  // Wizard Steps 2 + 3 — refresh detected collectors on entry and every 8s
  // while visible. Step 2 needs the list for the smart-add ("Apply
  // automatically") panel; Step 3 needs it for the network-attach widget.
  useEffect(() => {
    if (isSetupComplete || (setupStep !== 2 && setupStep !== 3)) return;
    refreshDetectedCollectors();
    const id = setInterval(refreshDetectedCollectors, 8000);
    return () => clearInterval(id);
  }, [setupStep, isSetupComplete]);

  // Wizard Step 4 — refresh recent service.name list on entry and every 5s.
  useEffect(() => {
    if (isSetupComplete || setupStep !== 4) return;
    refreshRecentServices();
    const id = setInterval(refreshRecentServices, 5000);
    return () => clearInterval(id);
  }, [setupStep, isSetupComplete]);

  useEffect(() => {
    if (!isSetupComplete) return;

    const controller = new AbortController();
    let cancelled = false;
    const checkStatus = () => {
      if (document.visibilityState === 'hidden') return;
      fetch('/api/diagnostics/network', { signal: controller.signal })
        .then(res => res.json())
        .then(data => { if (!cancelled) setNetworkDiag(data); })
        .catch((err) => {
          if (cancelled || err.name === 'AbortError') return;
          setNetworkDiag({ status: 'Failed', error: 'API unreachable', remediation: '' });
        });
    };

    checkStatus();
    const interval = setInterval(checkStatus, 15000); // Check every 15 seconds
    const onVis = () => { if (document.visibilityState === 'visible') checkStatus(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [isSetupComplete]);

  // Stream logs for whichever target is active: the attached app if any, else the gateway.
  // Keeps a single open EventSource at a time so we never interleave gateway + app logs.
  useEffect(() => {
    if (!showDiagnostics) return;

    // Close any open streams before opening a new one
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if ((eventSourceRef as any).currentApp) {
      (eventSourceRef as any).currentApp.close();
      (eventSourceRef as any).currentApp = null;
    }

    setSseConnected(false);

    const onOpen = () => setSseConnected(true);
    const onError = () => setSseConnected(false);

    const onMsg = (event: any) => {
      setSseConnected(true);
      setLogs(prev => [...prev.slice(-100), event.data]);
    };

    const onDiagAlert = () => {
      setDiagAlert(true);
      setDiagAlertCount(c => c + 1);
      pushTimelineEvent('error-spike', 'Telemetry drop detected');
      // Auto-dismiss after 30s of no recurrence.
      if (diagAlertTimerRef.current) clearTimeout(diagAlertTimerRef.current);
      diagAlertTimerRef.current = setTimeout(() => {
        setDiagAlert(false);
        setDiagAlertCount(0);
        diagAlertTimerRef.current = null;
      }, 30000);
    };

    if (connectedApp) {
      setLogs(prev => [...prev.slice(-100), `Streaming logs for [${connectedApp}]...`]);
      const source = new EventSource(`/api/diagnostics/logs/stream?container=${connectedApp}`);
      source.onmessage = onMsg;
      source.onopen = onOpen;
      source.onerror = onError;
      source.addEventListener('diag-alert', onDiagAlert);
      (eventSourceRef as any).currentApp = source;

      fetch('/api/diagnostics/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName: connectedApp })
      }).catch(console.error);
    } else {
      setLogs(prev => [...prev.slice(-100), 'No service attached — streaming gateway logs.']);
      const source = new EventSource('/api/diagnostics/logs/stream');
      source.onmessage = onMsg;
      source.onopen = onOpen;
      source.onerror = onError;
      source.addEventListener('diag-alert', onDiagAlert);
      eventSourceRef.current = source;
    }
  }, [connectedApp, showDiagnostics, sseAttempt]);

  const HELIX_LOG_KEYWORDS = [
    'bmchelix', 'otlphttp', 'exporter', 'sending queue',
    'unauthenticated', 'unauthorized', 'forbidden',
    'connection refused', 'deadline exceeded', 'exporting failed',
    'critical otel drop', 'permanent error', 'not retryable',
    'x-api-key', 'x-source', 'helix-gateway',
  ];
  const isHelixRelevant = (line: string): boolean => {
    const lower = line.toLowerCase();
    return HELIX_LOG_KEYWORDS.some(kw => lower.includes(kw));
  };
  const visibleLogs = logFilter === 'helix' ? logs.filter(isHelixRelevant) : logs;

  const handleOpenTemplates = async () => {
    setIsTemplatesOpen(true);
    if (templates.length === 0) {
      try {
        const res = await fetch('/api/templates');
        const data = await res.json();
        if (Array.isArray(data)) setTemplates(data);
      } catch {
        showToastMsg('Failed to load templates', 'error');
      }
    }
  };

  const handleApplyTemplate = async (id: string) => {
    setLoadingTemplateId(id);
    try {
      const res = await fetch(`/api/templates/${id}`);
      if (!res.ok) {
        showToastMsg('Failed to load template', 'error');
        return;
      }
      const data = await res.json();
      setConfig(data.content || '');
      clearEditorMarkers();
      setIsTemplatesOpen(false);
      showToastMsg('Template loaded — review and click Save Config to apply');
    } catch {
      showToastMsg('Failed to load template', 'error');
    } finally {
      setLoadingTemplateId(null);
    }
  };

  const handleOpenRawMetrics = async () => {
    setIsRawMetricsOpen(true);
    setIsLoadingRawMetrics(true);
    try {
      const res = await fetch('/api/diagnostics/metrics/raw');
      const text = await res.text();
      setRawMetricsText(text);
    } catch (err: any) {
      setRawMetricsText(`Failed to fetch metrics: ${err.message || err}`);
    } finally {
      setIsLoadingRawMetrics(false);
    }
  };

  // Per-field validation for the wizard. Returns null when valid, or a short
  // user-facing error message. Run on every keystroke for instant feedback.
  const validateEndpoint = (value: string): string | null => {
    if (!value) return 'Required';
    if (!/^https?:\/\//i.test(value)) return 'Must start with https://';
    if (/\/otlp(\/|$)/.test(value)) return 'Remove /otlp/... — the gateway adds the path itself';
    try { new URL(value); } catch { return 'Not a valid URL'; }
    return null;
  };
  const validateApiKey = (value: string): string | null => {
    if (!value) return 'Required';
    const parts = value.split('::');
    if (parts.length !== 3 || parts.some(p => !p.trim())) {
      return 'Must be three non-empty :: separated parts';
    }
    return null;
  };
  const validateXSource = (value: string): string | null => {
    if (!value) return 'Required';
    if (!/^[a-zA-Z0-9\-_]+$/.test(value)) return 'Letters, digits, dash, underscore only';
    return null;
  };
  const validateAppUrl = (value: string): string | null => {
    // Optional — empty is fine. If supplied, must parse as a URL so the bridge
    // step can extract a hostname.
    if (!value) return null;
    try { new URL(value); } catch { return 'Not a valid URL'; }
    return null;
  };

  const wizardFieldErrors = {
    HELIX_ENDPOINT: validateEndpoint(envVars.HELIX_ENDPOINT),
    HELIX_API_KEY: validateApiKey(envVars.HELIX_API_KEY),
    X_SOURCE: validateXSource(envVars.X_SOURCE),
    APP_URL: validateAppUrl(envVars.APP_URL),
  };
  const wizardCanSubmit = Object.values(wizardFieldErrors).every(e => e === null);

  useEscClose(isTemplatesOpen, () => setIsTemplatesOpen(false));
  useEscClose(isRawMetricsOpen, () => setIsRawMetricsOpen(false));
  useEscClose(isServicesOpen, () => setIsServicesOpen(false));
  useEscClose(!!confirmDialog, () => setConfirmDialog(null));

  // Poll /api/lifecycle/status until the gateway reports 'running', or give up
  // after timeoutMs. Replaces blind sleeps that broke on slow hosts.
  const waitForGatewayRunning = async (timeoutMs = 15000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch('/api/lifecycle/status');
        const data = await res.json();
        if (data.status === 'running') return true;
      } catch { /* network blip — keep trying */ }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  };

  // Accept bare key, URL path fragment, or full AIOps URL — extract just the opaque key.
  const extractServiceKey = (input: string): string => {
    if (!input) return '';
    const trimmed = input.trim();
    const match = trimmed.match(/\/entities\/service\/([^/?#\s]+)/);
    if (match) return match[1];
    return trimmed.split(/[?#\s]/)[0];
  };

  const showToastMsg = (message: string, type: 'success' | 'error' = 'success') => {
    const id = ++toastIdRef.current;
    setToasts(prev => {
      const next = [...prev, { id, message, type }];
      // FIFO eviction when full — drop oldest.
      if (next.length > TOAST_MAX) {
        const evicted = next[0];
        const t = toastTimersRef.current.get(evicted.id);
        if (t) { clearTimeout(t); toastTimersRef.current.delete(evicted.id); }
        return next.slice(-TOAST_MAX);
      }
      return next;
    });
    const timer = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      toastTimersRef.current.delete(id);
    }, 3000);
    toastTimersRef.current.set(id, timer);
  };

  const clearEditorMarkers = () => {
    if (monaco && editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) monaco.editor.setModelMarkers(model, 'yaml', []);
    }
  };

  const handleUpdateConfig = async () => {
    if (isConfigSaving) return;
    setIsConfigSaving(true);
    clearEditorMarkers();
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: config })
      });
      const data = await res.json();

      if (res.ok) {
        // Backend now handles save+restart+rollback atomically — no separate restart call.
        // Surface structural warnings as Monaco markers (non-blocking — config is saved).
        const warnings = Array.isArray(data.warnings) ? data.warnings : [];
        if (warnings.length > 0 && monaco && editorRef.current) {
          const model = editorRef.current.getModel();
          if (model) {
            monaco.editor.setModelMarkers(model, 'yaml', warnings.map((w: any) => ({
              severity: monaco.MarkerSeverity.Warning,
              startLineNumber: w.line || 1,
              startColumn: 1,
              endLineNumber: w.line || 1,
              endColumn: 1000,
              message: w.message,
            })));
          }
        }
        if (warnings.length > 0) {
          showToastMsg(`Config saved with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`, 'error');
        } else {
          showToastMsg('Config Saved');
        }
        pushTimelineEvent('config-saved', `Config updated${warnings.length ? ` (${warnings.length} warnings)` : ''}`);
        const collectorStatus = await fetch('/api/diagnostics/collector').then(r => r.json());
        setCollectorDiag(collectorStatus);
      } else if (data.rolledBack) {
        // Collector rejected the new YAML. Backend restored the previous version
        // and bounced the gateway back to a healthy state — surface the actual
        // error so the user can fix it without leaving a broken pipeline.
        showToastMsg(`Config rejected — rolled back. ${data.details || ''}`, 'error');
        pushTimelineEvent('error-spike', `Config rejected: ${data.details || data.error}`);
        // Reload the actual on-disk content (which is now the previous good version)
        // so the editor reflects what the gateway is running.
        try {
          const cfg = await fetch('/api/config').then(r => r.json());
          if (cfg.yaml) setConfig(cfg.yaml);
        } catch { /* ignore */ }
      } else if (data.mark && monaco && editorRef.current) {
        const model = editorRef.current.getModel();
        monaco.editor.setModelMarkers(model, 'yaml', [{
          severity: monaco.MarkerSeverity.Error,
          startLineNumber: data.mark.line + 1,
          startColumn: data.mark.column + 1,
          endLineNumber: data.mark.line + 1,
          endColumn: 1000,
          message: data.mark.message
        }]);
      } else {
        showToastMsg(data.error || 'Failed to save config', 'error');
      }
    } catch (err) {
      showToastMsg('Error connecting to API', 'error');
    } finally {
      setIsConfigSaving(false);
    }
  };
  handleUpdateConfigRef.current = handleUpdateConfig;

  const handleUpdateEnvSettings = async () => {
    if (isUpdatingSettings) return;
    setIsUpdatingSettings(true);
    try {
      const res = await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envVars)
      });
      if (!res.ok) {
        showToastMsg('Failed to update settings', 'error');
        return;
      }

      // Bounce gateway so the new endpoint/key/source actually take effect
      showToastMsg('Settings saved — restarting gateway...');
      const restartRes = await fetch('/api/lifecycle/restart', { method: 'POST' });
      if (!restartRes.ok) {
        showToastMsg('Settings saved, but gateway restart failed', 'error');
        return;
      }
      const ready = await waitForGatewayRunning(15000);
      if (!ready) {
        showToastMsg('Settings saved, but gateway did not reach running state', 'error');
        return;
      }

      // Refresh config and dynamic tokens after env change
      fetch('/api/config')
        .then(r => r.json())
        .then(d => setConfig(d.yaml || ''));
      fetchDiscoveredData();
      showToastMsg('Settings Applied');
    } catch (err) {
      console.error('Update failed', err);
      showToastMsg('Error updating settings', 'error');
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const handleStart = async () => {
    if (actionLoading) return;
    setActionLoading('start');
    try {
      const res = await fetch('/api/lifecycle/start', { method: 'POST' });
      if (res.ok) {
        showToastMsg('Gateway Started Successfully');
      } else {
        showToastMsg('Failed to start gateway', 'error');
      }
    } catch (e) {
      showToastMsg('Error starting gateway', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleStop = async () => {
    if (actionLoading) return;
    setActionLoading('stop');
    try {
      const res = await fetch('/api/lifecycle/stop', { method: 'POST' });
      if (res.ok) {
        showToastMsg('Gateway Stopped Successfully');
      } else {
        showToastMsg('Failed to stop gateway', 'error');
      }
    } catch (e) {
      showToastMsg('Error stopping gateway', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    if (actionLoading) return;
    setActionLoading('restart');
    setGatewayStatus('restarting');
    try {
      const res = await fetch('/api/lifecycle/restart', { method: 'POST' });
      if (res.ok) {
        showToastMsg('Gateway Restarted Successfully');
        pushTimelineEvent('restart', 'Gateway restarted');
        // Poll for the gateway to settle instead of a blind 3s sleep.
        await waitForGatewayRunning(15000);
        const collectorStatus = await fetch('/api/diagnostics/collector').then(r => r.json());
        setCollectorDiag(collectorStatus);
      } else {
        showToastMsg('Failed to restart gateway', 'error');
      }
    } catch (e) {
      showToastMsg('Error restarting gateway', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleInitialize = async () => {
    setIsVerifying(true);
    setSetupError('');
    setTraceVerifyResult(null);
    setTelemetryStatus('idle');
    // Clear tokens before re-initialization to prevent stale link generation
    setHelixConfig({ baseUrl: '', tenantId: '', source: '', businessServiceKey: '' });

    try {
      // Save keys
      const envRes = await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envVars)
      });
      if (!envRes.ok) throw new Error('Failed to save settings');

      // Bounce sidecar
      const restartRes = await fetch('/api/lifecycle/restart', { method: 'POST' });
      if (!restartRes.ok) throw new Error('Failed to restart sidecar');

      // Poll until the gateway reports running. Slow hosts used to false-fail
      // the network diagnostic on a blind 3s sleep.
      const ready = await waitForGatewayRunning(15000);
      if (!ready) throw new Error('Gateway did not reach running state within 15s');

      // Bridge network to target app
      const bridgeRes = await fetch('/api/lifecycle/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ APP_URL: envVars.APP_URL })
      });
      let bridgedTarget = '';
      const bridgeData = await bridgeRes.json().catch(() => ({}));
      if (bridgeRes.ok) {
        if (bridgeData.skipped) {
          setBridgeStatus({ kind: 'skipped', reason: bridgeData.reason || 'No Application URL provided.' });
        } else if (bridgeData.network) {
          bridgedTarget = bridgeData.targetContainer || '';
          setBridgeStatus({ kind: 'success', network: bridgeData.network, targetContainer: bridgedTarget });
        }
      } else {
        const reason = bridgeData.error || bridgeData.details || 'Unknown error';
        console.warn('Automated network bridging failed:', reason);
        setBridgeStatus({ kind: 'error', reason });
      }

      // Helix only supports the collector-routed path now, so the wizard
      // doesn't branch on instrumentation style — Step 2 just shows the
      // exporter/pipelines snippets unconditionally.

      // Verify auth
      const diagRes = await fetch('/api/diagnostics/network');
      const diagData = await diagRes.json();
      if (diagData.status !== 'Success') {
        throw new Error(diagData.error || 'Network diagnostics failed');
      }

      setSetupStep(2);
      fetchDiscoveredData(); // Refresh tokens after setup
      refreshDetectedCollectors();
    } catch (err: any) {
      setSetupError(err.message || 'Verification failed');
    } finally {
      setIsVerifying(false);
    }
  };

  // Scan the host for OTel collector containers. Used to drive the
  // "Detected collectors" widget in Step 2 — surfaces which network
  // helix-gateway needs to attach to so the user's chained collector
  // can reach helix-gateway:4317.
  const refreshDetectedCollectors = async () => {
    try {
      const res = await fetch('/api/discovery/collectors');
      if (!res.ok) return;
      const data = await res.json();
      setDetectedCollectors(Array.isArray(data.collectors) ? data.collectors : []);
    } catch { /* non-fatal */ }
  };

  const attachSidecarToNetwork = async (network: string) => {
    if (attachingNetwork) return;
    setAttachingNetwork(network);
    setAttachResult(null);
    try {
      const res = await fetch('/api/lifecycle/bridge-network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network }),
      });
      const data = await res.json().catch(() => ({}));
      setAttachResult({ network, ok: res.ok, message: data.message || data.error || 'Done' });
      if (res.ok) refreshDetectedCollectors();
    } catch (e: any) {
      setAttachResult({ network, ok: false, message: e.message || 'Request failed' });
    } finally {
      setAttachingNetwork(null);
    }
  };

  // Step 2 / Step 4 — fetch the live gateway config for the read-only modal.
  // Lazy-load: only hit the endpoint the first time the modal opens.
  const openGatewayConfigModal = async () => {
    setGatewayConfigOpen(true);
    if (gatewayConfigText) return;
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        setGatewayConfigText(data.config || '');
      }
    } catch { /* non-fatal */ }
  };

  // Step 3 — apply the K8s Attribute Enrichment template via the existing
  // /api/templates and /api/config endpoints. No new backend route needed.
  // Confirmation guarded: this overwrites the entire gateway YAML, including
  // anything the user may have already customized.
  const requestApplyK8sTemplate = () => {
    if (k8sApplying || k8sApplyResult === 'applied') return;
    setConfirmDialog({
      title: 'Apply K8s Attribute Enrichment template?',
      message: 'This replaces the entire helix-gateway YAML with the K8s Attribute Enrichment template. Any custom processors, exporters, or pipeline edits in the current config will be lost. The gateway will restart on save.',
      confirmLabel: 'Apply template',
      onConfirm: async () => {
        setK8sApplying(true);
        setK8sApplyResult(null);
        try {
          const tplRes = await fetch('/api/templates/k8s-attributes');
          if (!tplRes.ok) throw new Error('Could not load template');
          const { content } = await tplRes.json();
          const saveRes = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
          });
          if (!saveRes.ok) throw new Error('Could not save config');
          setK8sApplyResult('applied');
          setGatewayConfigText(content);
        } catch {
          setK8sApplyResult('failed');
        } finally {
          setK8sApplying(false);
        }
      },
    });
  };

  // Step 2 smart-add — fetch the proposed merge for a single detected
  // collector. Re-fetches when detectedCollectors changes; only fires when
  // exactly one collector is on the host. (Multi-collector apply could be
  // a follow-up; for now we keep the auto-flow conservative.)
  const refreshSmartAddProposal = async (collectorName: string) => {
    setSmartAddLoading(true);
    setSmartAddProposal(null);
    try {
      const res = await fetch(`/api/discovery/collector-config/${encodeURIComponent(collectorName)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSmartAddProposal({ name: collectorName, configPath: '', error: data.error || data.details || 'Could not read collector config' });
        return;
      }
      setSmartAddProposal({
        name: data.name,
        configPath: data.configPath,
        alreadyConfigured: data.alreadyConfigured,
        existingExporterName: data.existingExporterName,
        exporterName: data.exporterName,
        addedToPipelines: data.addedToPipelines,
        existingPipelines: data.existingPipelines,
        proposedYaml: data.proposedYaml,
      });
    } catch (e: any) {
      setSmartAddProposal({ name: collectorName, configPath: '', error: e?.message || 'Network error' });
    } finally {
      setSmartAddLoading(false);
    }
  };

  const requestSmartAddApply = (collectorName: string) => {
    if (smartAddApplying) return;
    setConfirmDialog({
      title: `Update ${collectorName} automatically?`,
      message: `The configurator will write a backup of the current collector config (as <path>.helix-bak inside the container), apply the merged config that adds helix_sidecar to your existing pipelines, and restart the container so the new exporter takes effect. The original is preserved as the .helix-bak file. Proceed?`,
      confirmLabel: 'Apply & restart',
      onConfirm: async () => {
        setSmartAddApplying(true);
        setSmartAddResult(null);
        try {
          const res = await fetch(`/api/discovery/collector-apply/${encodeURIComponent(collectorName)}`, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setSmartAddResult({ ok: false, message: data.error || data.details || 'Apply failed' });
            return;
          }
          if (data.alreadyConfigured) {
            setSmartAddResult({ ok: true, message: `Already configured — ${data.existingExporterName} already points at helix-gateway:4318. No changes needed.` });
          } else {
            setSmartAddResult({
              ok: true,
              message: `Applied. ${data.exporterName} added to ${(data.addedToPipelines || []).join(', ') || '(no pipelines)'} on ${collectorName}. Original saved as ${data.backupPath}. Container restarting.`,
            });
          }
          // Refresh detection so Step 3's reachability badges update.
          refreshDetectedCollectors();
        } catch (e: any) {
          setSmartAddResult({ ok: false, message: e?.message || 'Network error' });
        } finally {
          setSmartAddApplying(false);
        }
      },
    });
  };

  // Auto-fetch proposal when entering Step 2 with exactly one detected
  // collector. Re-fetch when detectedCollectors changes shape.
  useEffect(() => {
    if (isSetupComplete || setupStep !== 2) return;
    if (detectedCollectors.length === 1) {
      const name = detectedCollectors[0].name;
      if (!smartAddProposal || smartAddProposal.name !== name) {
        refreshSmartAddProposal(name);
      }
    } else {
      setSmartAddProposal(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupStep, isSetupComplete, detectedCollectors.length, detectedCollectors[0]?.name]);

  // Step 4 — service.name detection. Uses the existing /api/traces/services
  // (which now counts every span, not just root services) so even downstream
  // services in a chained-collector setup show up here.
  const refreshRecentServices = async () => {
    try {
      const res = await fetch('/api/traces/services');
      if (!res.ok) return;
      const data = await res.json();
      const internal = new Set(['helix-gateway', 'helix-configurator', 'helix-configurator-verify', 'otelcol-contrib']);
      const services = (data.services || [])
        .map((s: any) => s.name)
        .filter((n: string) => n && !internal.has(n));
      setRecentServices(services);
    } catch { /* non-fatal */ }
  };

  // Step 2 verification: inject a synthetic trace through the gateway and watch
  // for the sent counter to move. Proves gateway→Helix independent of whether
  // the user's app is instrumented yet.
  const handleVerifyTelemetry = async () => {
    if (verifyingTrace) return;
    setVerifyingTrace(true);
    setTraceVerifyResult(null);
    setTelemetryStatus('loading');
    try {
      const res = await fetch('/api/diagnostics/inject-trace-verify', { method: 'POST' });
      const data = await res.json();
      setTraceVerifyResult({
        status: data.status || (res.ok ? 'pending' : 'error'),
        message: data.message || data.error || 'Verification finished',
        remediation: data.remediation,
      });
      if (data.status === 'exported') {
        setTelemetryStatus('success');
        pushTimelineEvent('verify', 'Synthetic trace reached Helix');
      } else {
        setTelemetryStatus('error');
      }
    } catch (err) {
      setTraceVerifyResult({ status: 'error', message: 'Verification request failed' });
      setTelemetryStatus('error');
    } finally {
      setVerifyingTrace(false);
      // The synthetic trace ticked the receiver counters too. Re-baseline the
      // App→Gateway pane so its deltas reflect only the user's app traffic
      // going forward, not the verify ping we just injected.
      try {
        const r = await fetch('/api/diagnostics/receiver-counters');
        if (r.ok) setReceiverBaseline(await r.json());
      } catch { /* non-fatal */ }
    }
  };

  const handleQuickVerifyTelemetry = async () => {
    showToastMsg('Verifying telemetry flow...');
    try {
      const res = await fetch('/api/diagnostics/metrics/live');
      const data = await res.json();
      if (data.sent > 0) {
        showToastMsg(`Telemetry flowing — ${data.sent} sent, ${data.received} received`);
      } else {
        showToastMsg('No telemetry data flowing yet', 'error');
      }
    } catch (err) {
      showToastMsg('Failed to verify telemetry', 'error');
    }
  };

  const handleCopySupportBundle = async () => {
    showToastMsg('Gathering support info...');
    try {
      const [statusData, logsData] = await Promise.all([
        fetch('/api/lifecycle/status').then(r => r.json()).catch(() => ({ status: 'unknown' })),
        fetch('/api/diagnostics/logs/recent?tail=5').then(r => r.json()).catch(() => ({ logs: '(unavailable)' })),
      ]);

      const redactKey = (key: string) => {
        if (!key) return '(unset)';
        const parts = key.split('::');
        if (parts.length === 3) return `${parts[0]}::***::***`;
        return '***';
      };

      // Build a compact rate timeline from metricsHistory (cumulative counters
      // → per-sample deltas). Useful when an issue self-resolves before the
      // user copies the bundle — the snapshot alone would otherwise look fine.
      const renderRateHistory = () => {
        if (metricsHistory.length < 2) return '(no rate history available)';
        const lines: string[] = ['  sample  recv/Δ  sent/Δ  fail/Δ'];
        for (let i = 1; i < metricsHistory.length; i++) {
          const prev = metricsHistory[i - 1];
          const cur = metricsHistory[i];
          const dRecv = Math.max(0, cur.received - prev.received);
          const dSent = Math.max(0, cur.sent - prev.sent);
          const dFail = Math.max(0, cur.failed - prev.failed);
          lines.push(`  ${String(i).padStart(6)}  ${String(dRecv).padStart(6)}  ${String(dSent).padStart(6)}  ${String(dFail).padStart(6)}`);
        }
        return lines.join('\n');
      };

      const renderTimeline = () => {
        if (timeline.length === 0) return '(no events recorded this session)';
        return timeline.map(ev => {
          const t = new Date(ev.ts).toISOString();
          return `  ${t}  [${ev.kind}] ${ev.message}`;
        }).join('\n');
      };

      const bundle =
`=== Helix Configurator Support Bundle ===
Generated: ${new Date().toISOString()}

[Environment]
HELIX_ENDPOINT: ${envVars.HELIX_ENDPOINT || '(unset)'}
HELIX_API_KEY: ${redactKey(envVars.HELIX_API_KEY)}
X_SOURCE: ${envVars.X_SOURCE || '(unset)'}
APP_URL: ${envVars.APP_URL || '(unset)'}
BUSINESS_SERVICE_KEY: ${envVars.BUSINESS_SERVICE_KEY ? '(set)' : '(unset)'}

[Gateway Status]
Container: ${statusData.status || 'unknown'}

[Diagnostic Checks]
Collector Configuration: ${collectorDiag.status}${collectorDiag.error ? ' — ' + collectorDiag.error : ''}
X-API Key Format: ${apiKeyDiag.status}${apiKeyDiag.error ? ' — ' + apiKeyDiag.error : ''}
X-Source Format: ${envVars.X_SOURCE ? 'PASS' : 'FAIL'}
Tenant URL Endpoint: ${networkDiag.status}${networkDiag.error ? ' — ' + networkDiag.error : ''}

[Live Metrics — current]
Received: ${liveMetrics.received}, Sent: ${liveMetrics.sent}, Failed: ${liveMetrics.failed}

[Rate History — last ${metricsHistory.length} samples (~3s each)]
${renderRateHistory()}

[Session Timeline]
${renderTimeline()}

[Last Gateway Log Lines]
${logsData.logs || '(no logs available)'}
`;

      await navigator.clipboard.writeText(bundle);
      showToastMsg('Support bundle copied to clipboard');
    } catch (err) {
      showToastMsg('Failed to gather support bundle', 'error');
    }
  };

  const handleToggleDiagnostics = async () => {
    if (isTogglingDiagRef.current) return;
    isTogglingDiagRef.current = true;
    setIsTogglingDiag(true);
    try {
    if (!showDiagnostics) {
      // Enabling diagnostics
      try {
        if (!isGatewayConnected) throw new Error('Helix Gateway is not connected to the bridge');

        if (connectedApp) {
          await fetch('/api/diagnostics/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ containerName: connectedApp })
          });
        }

        const toggleRes = await fetch('/api/diagnostics/toggle-debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable: true })
        });
        if (!toggleRes.ok) throw new Error('Failed to enable debug telemetry');

        setShowDiagnostics(true);
        setDiagAlert(false);
        setDiagAlertCount(0);
        setTimeline([]);
        pushTimelineEvent('verify', `Diagnostic session started${connectedApp ? ` (${connectedApp})` : ''}`);
        setLogs([`Initializing diagnostic session${connectedApp ? ` for ${connectedApp}` : ''} (5-min session)...`]);
        setTraceInjectionStatus('injecting');
        // SSE setup happens in the [connectedApp, showDiagnostics] effect — single stream at a time.

        // Start metrics polling — skip while tab is hidden so a backgrounded
        // session doesn't keep hammering the gateway every 3s.
        setMetricsHistory([]);
        const fetchMetrics = () => {
          if (document.visibilityState === 'hidden') return;
          fetch('/api/diagnostics/metrics/live')
            .then(res => res.json())
            .then(data => {
              setLiveMetrics(data);
              setMetricsHistory(prev => {
                const next = [...prev, {
                  received: data.received || 0,
                  sent: data.sent || 0,
                  failed: data.failed || 0,
                }];
                return next.length > METRICS_HISTORY_MAX ? next.slice(-METRICS_HISTORY_MAX) : next;
              });
            })
            .catch(() => { });
        };
        fetchMetrics();
        metricsIntervalRef.current = setInterval(fetchMetrics, 3000);

        // Inject Synthetic Trace
        const injectRes = await fetch('/api/diagnostics/inject-trace', { method: 'POST' });
        if (injectRes.ok) {
          setTraceInjectionStatus('success');
          showToastMsg('Synthetic Trace Injected Successfully');
        } else {
          setTraceInjectionStatus('error');
        }

      } catch (err: any) {
        showToastMsg(err.message || 'Failed to start diagnostics', 'error');
      }
    } else {
      // Disabling diagnostics
      if (eventSourceRef.current) eventSourceRef.current.close();
      if ((eventSourceRef as any).currentApp) (eventSourceRef as any).currentApp.close();
      if (metricsIntervalRef.current) clearInterval(metricsIntervalRef.current);
      if (diagAlertTimerRef.current) {
        clearTimeout(diagAlertTimerRef.current);
        diagAlertTimerRef.current = null;
      }

      setShowDiagnostics(false);
      setTraceInjectionStatus('');
      setDiagAlert(false);
      setDiagAlertCount(0);
      try {
        await fetch('/api/diagnostics/toggle-debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable: false })
        });
      } catch (err) { }
    }
    } finally {
      isTogglingDiagRef.current = false;
      setIsTogglingDiag(false);
    }
  };

  const fetchDiscoveredData = () => {
    fetch('/api/services')
      .then(res => res.json())
      .then(data => { if (!data.error) setHelixConfig(data); })
      .catch(console.error);
    fetch('/api/containers/full')
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setDiscoveredContainers(data); })
      .catch(console.error);
  };

  const handleOpenServices = () => {
    if (!isServicesOpen) {
      fetchDiscoveredData();
    }
    setIsServicesOpen(!isServicesOpen);
  };

  const handleAttachContainer = async (name: string) => {
    setLoadingContainers(prev => new Set(prev).add(name));
    try {
      // Step 1: Disconnect ALL other apps currently on the bridge (excluding gateway)
      const existingApps = discoveredContainers.filter(c => 
        !c.name.includes('helix-gateway') && 
        c.networks.includes('helix-bridge') && 
        c.name !== name
      );

      for (const app of existingApps) {
        showToastMsg(`Switching bridge from ${app.name}...`);
        const disconnectRes = await fetch('/api/containers/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ containerName: app.name })
        });
        if (!disconnectRes.ok) {
          showToastMsg(`Failed to disconnect ${app.name}`, 'error');
          fetchDiscoveredData();
          return;
        }
      }
      // Step 2: Attach the new container
      const attachRes = await fetch('/api/containers/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName: name })
      });
      if (!attachRes.ok) {
        showToastMsg(`Failed to attach ${name}`, 'error');
        fetchDiscoveredData();
        return;
      }
      showToastMsg(`Attached ${name} to bridge`);
      pushTimelineEvent('attach', `Attached ${name} to helix-bridge`);
      fetchDiscoveredData();
    } catch (e) {
      showToastMsg('Failed to attach container', 'error');
    } finally {
      setLoadingContainers(prev => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const handleDisconnectContainer = async (name: string) => {
    setLoadingContainers(prev => new Set(prev).add(name));
    try {
      const res = await fetch('/api/containers/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName: name })
      });
      if (!res.ok) {
        showToastMsg(`Failed to disconnect ${name}`, 'error');
      } else {
        showToastMsg(`Disconnected ${name} from bridge`);
      }
      fetchDiscoveredData();
    } catch (e) {
      showToastMsg('Failed to disconnect container', 'error');
    } finally {
      setLoadingContainers(prev => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showToastMsg('Copied to clipboard');
  };

  const getStatusColor = () => {
    if (gatewayStatus === 'running') return 'bg-success';
    if (gatewayStatus === 'restarting') return 'bg-warning animate-spin rounded-sm';
    return 'bg-danger';
  };

  const renderContainerCard = (container: any, isCore: boolean = false) => {
    return (
      <div key={container.name} className={`border border-gray-800 p-4 rounded-lg flex items-center justify-between transition-colors ${isCore ? 'bg-blue-500/5' : 'bg-gray-900'}`}>
        <div className="flex flex-col min-w-0">
          <span className="font-bold text-gray-200 text-sm truncate">{container.name}</span>
          <span className="text-[10px] text-gray-500 font-mono truncate">{container.image}</span>
        </div>
        <div className="flex items-center gap-3">
          {container.networks.includes('helix-bridge') ? (
            <div className="flex items-center gap-2">
              <span className="adapt-badge-success gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#11845b] flex-shrink-0"></div>
                Connected
              </span>
              {helixConfig.baseUrl && (
                <a
                  href={`${helixConfig.baseUrl}/dashboards/d/OTelServiceOverview/otel-service-overview?orgId=${helixConfig.tenantId}&from=now-3h&to=now&timezone=browser&var-BusinessService=${helixConfig.source}&var-OTelNamespace=${helixConfig.source}&var-OTelService=${container.name}&var-status=STATUS_CODE_UNSET`}
                  target="_blank"
                  rel="noreferrer"
                  className="p-1.5 bg-gray-800 hover:bg-gray-700 rounded text-info transition-colors"
                  title="View Service Dashboard"
                  aria-label={`View Service Dashboard for ${container.name}`}
                >
                  <BarChart2 className="w-4 h-4" />
                </a>
              )}
              {!isCore && (
                <button
                  onClick={() => handleDisconnectContainer(container.name)}
                  disabled={loadingContainers.has(container.name)}
                  className="text-gray-400 hover:text-danger transition-colors p-1 disabled:opacity-60"
                  title="Disconnect from Bridge"
                  aria-label={`Disconnect ${container.name} from helix-bridge`}
                >
                  <Unlink className="w-4 h-4" />
                </button>
              )}
            </div>
          ) : (
            !isCore && (
              <button
                onClick={() => handleAttachContainer(container.name)}
                disabled={loadingContainers.has(container.name)}
                className="text-info text-xs font-bold hover:underline disabled:opacity-60 flex items-center gap-2"
              >
                {loadingContainers.has(container.name) && <Loader2 className="w-3 h-3 animate-spin" />}
                {loadingContainers.has(container.name) ? 'Attaching...' : 'Attach to Bridge'}
              </button>
            )
          )}
        </div>
      </div>
    );
  };

  // Loading state while we check auth status
  if (authStatus === null) {
    return (
      <div className="flex items-center justify-center h-screen w-full bg-gray-900 text-gray-300">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
      </div>
    );
  }

  // Login screen when auth is required and not yet authenticated
  if (authStatus.required && !authStatus.authenticated) {
    return <LoginScreen onLogin={performLogin} />;
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-gray-900 font-sans text-gray-100">
      <ToastStack toasts={toasts} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto transition-all duration-300">
        {/* Header */}
        <header className="bg-helixNav flex items-center px-4 py-3 font-helix w-full justify-between flex-shrink-0 sticky top-0 z-40 border-b border-[#0f1620]">
          <div className="flex items-center">
            <img src="/bmc-logo.svg" alt="BMC" className="h-8 w-auto" />
            <div className="h-8 w-px bg-helixDivider mx-4"></div>
            <h1 className="text-white font-light text-[1.3125rem] m-0 ml-[15px] tracking-wide">Helix OTel Configurator</h1>
            <div className="h-8 w-px bg-helixDivider mx-5"></div>
            <nav className="flex items-center space-x-5 text-sm text-[#cfd3da]">
              <button
                onClick={() => {
                  const goBack = () => {
                    // Tear down any active diagnostic session before returning to onboarding
                    if (showDiagnostics) {
                      if (eventSourceRef.current) eventSourceRef.current.close();
                      if ((eventSourceRef as any).currentApp) (eventSourceRef as any).currentApp.close();
                      if (metricsIntervalRef.current) clearInterval(metricsIntervalRef.current);
                      fetch('/api/diagnostics/toggle-debug', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enable: false })
                      }).catch(() => {});
                    }
                    setShowDiagnostics(false);
                    setTraceInjectionStatus('');
                    setLogs([]);
                    setLiveMetrics({ received: 0, sent: 0, failed: 0 });
                    setDiagAlert(false);
                    setTelemetryStatus('idle');
                    setIsSetupComplete(false);
                    setSetupStep(1);
                  };
                  if (isSetupComplete) {
                    setConfirmDialog({
                      title: 'Return to onboarding wizard?',
                      message: 'Your saved settings stay intact, but the dashboard will close. You can re-launch from Step 2 once you re-initialize.',
                      confirmLabel: 'Return to Onboarding',
                      onConfirm: goBack,
                    });
                  } else {
                    goBack();
                  }
                }}
                className={!isSetupComplete
                  ? 'text-white font-semibold border-b-2 border-primary pb-0.5 cursor-default'
                  : 'hover:text-white transition-colors'}
              >
                Onboarding
              </button>
              <a
                href="/"
                onClick={(e) => {
                  // Already on / — short-circuit the navigation. If we're on
                  // the wizard but already onboarded, just flip to dashboard
                  // view without a full reload.
                  e.preventDefault();
                  const onboardedBefore = localStorage.getItem('helix-configurator.onboarded') === '1';
                  if (onboardedBefore && envVars.HELIX_ENDPOINT && envVars.HELIX_API_KEY) {
                    setIsSetupComplete(true);
                  }
                }}
                className={isSetupComplete
                  ? 'text-white font-semibold border-b-2 border-primary pb-0.5 cursor-default'
                  : 'hover:text-white transition-colors'}
              >
                Gateway Dashboard
              </a>
              <a
                href="/otel-data"
                className="hover:text-white transition-colors"
              >
                View OTel Data
              </a>
            </nav>
          </div>
          <nav className="flex items-center space-x-5 text-sm text-[#cfd3da]">
            {authStatus.required && (
              <button
                onClick={handleLogout}
                className="hover:text-white transition-colors"
              >
                Logout
              </button>
            )}
          </nav>
        </header>

        <main className="p-6 space-y-6 max-w-7xl mx-auto w-full">
          {!isSetupComplete ? (
            <div className="max-w-3xl mx-auto mt-12 space-y-6">
              <h1 className="text-2xl font-bold text-center text-gray-100">Welcome to Helix Configurator</h1>

              {/* Stepper — clickable for completed steps. setupStep is 1-4. */}
              <div className="flex items-center justify-between gap-2 px-1">
                {[
                  { n: 1, label: 'Configure' },
                  { n: 2, label: 'Exporter' },
                  { n: 3, label: 'Connect' },
                  { n: 4, label: 'Verify' },
                ].map((s, idx, arr) => {
                  const isCurrent = setupStep === s.n;
                  const isCompleted = setupStep > s.n;
                  const clickable = s.n <= setupStep;
                  return (
                    <React.Fragment key={s.n}>
                      <button
                        onClick={() => clickable && setSetupStep(s.n)}
                        disabled={!clickable}
                        className={`flex items-center gap-2 ${clickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                        aria-current={isCurrent ? 'step' : undefined}
                      >
                        <span
                          className={`w-7 h-7 rounded-full inline-flex items-center justify-center text-tiny font-semibold border ${
                            isCurrent
                              ? 'bg-primary border-primary text-white'
                              : isCompleted
                                ? 'bg-success border-success text-white'
                                : 'bg-gray-1000 border-gray-700 text-gray-400'
                          }`}
                        >
                          {isCompleted ? '✓' : s.n}
                        </span>
                        <span className={`text-tiny font-semibold uppercase tracking-wider ${isCurrent ? 'text-gray-100' : isCompleted ? 'text-gray-300' : 'text-gray-500'}`}>
                          {s.label}
                        </span>
                      </button>
                      {idx < arr.length - 1 && (
                        <span className={`flex-1 h-px ${setupStep > s.n ? 'bg-success/60' : 'bg-gray-800'}`} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>

              {setupStep === 1 && (
                <div className="adapt-card">
                  <h2 className="text-lg font-bold mb-2 text-gray-200">Step 1: Configure helix-gateway</h2>
                  <p className="text-sm text-gray-400 mb-6">Tell the sidecar where Helix lives and what to call your service. The gateway restarts on save.</p>
                  <div className="space-y-4 mb-6">
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
                        Helix Endpoint
                        {!wizardFieldErrors.HELIX_ENDPOINT && envVars.HELIX_ENDPOINT && <span className="text-success normal-case tracking-normal">✓</span>}
                      </label>
                      <input
                        type="url"
                        name="helix-ingest-endpoint"
                        autoComplete="off"
                        spellCheck={false}
                        data-1p-ignore
                        data-lpignore="true"
                        value={envVars.HELIX_ENDPOINT}
                        onChange={(e) => setEnvVars({ ...envVars, HELIX_ENDPOINT: e.target.value })}
                        className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.HELIX_ENDPOINT && wizardFieldErrors.HELIX_ENDPOINT ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
                        placeholder="https://your-tenant.onbmc.com"
                      />
                      {envVars.HELIX_ENDPOINT && wizardFieldErrors.HELIX_ENDPOINT && (
                        <p className="text-tiny text-danger">{wizardFieldErrors.HELIX_ENDPOINT}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2 flex-wrap">
                        <span className="flex items-center gap-2">
                          X-Source
                          {!wizardFieldErrors.X_SOURCE && envVars.X_SOURCE && <span className="text-success normal-case tracking-normal">✓</span>}
                        </span>
                        <span className="normal-case tracking-normal text-gray-500 font-normal">— Business Service name in Helix topology &amp; AIOps</span>
                      </label>
                      <input
                        type="text"
                        name="helix-x-source"
                        autoComplete="off"
                        spellCheck={false}
                        data-1p-ignore
                        data-lpignore="true"
                        value={envVars.X_SOURCE}
                        onChange={(e) => setEnvVars({ ...envVars, X_SOURCE: e.target.value.replace(/[^a-zA-Z0-9\-_]/g, '') })}
                        className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.X_SOURCE && wizardFieldErrors.X_SOURCE ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
                        placeholder="e.g. payment-service"
                      />
                      <p className="text-tiny text-gray-500">Choose a name that maps to a real service your team owns.</p>
                      {envVars.X_SOURCE && wizardFieldErrors.X_SOURCE && (
                        <p className="text-tiny text-danger">{wizardFieldErrors.X_SOURCE}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
                        X-API Key
                        {!wizardFieldErrors.HELIX_API_KEY && envVars.HELIX_API_KEY && <span className="text-success normal-case tracking-normal">✓</span>}
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          name="helix-x-api-key"
                          autoComplete="off"
                          spellCheck={false}
                          data-1p-ignore
                          data-lpignore="true"
                          value={envVars.HELIX_API_KEY}
                          onChange={(e) => {
                            const parsed = parseHelixKeyBundle(e.target.value);
                            setEnvVars({ ...envVars, HELIX_API_KEY: parsed ?? e.target.value });
                          }}
                          style={!showApiKey ? { WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties : undefined}
                          className={`w-full bg-gray-1000 border rounded px-3 py-2 pr-16 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm ${envVars.HELIX_API_KEY && wizardFieldErrors.HELIX_API_KEY ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
                          placeholder="Paste your API key from the Helix portal"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(s => !s)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-tiny text-gray-400 hover:text-gray-200 uppercase tracking-wider font-semibold px-1"
                        >
                          {showApiKey ? 'Hide' : 'Show'}
                        </button>
                      </div>
                      <p className="text-tiny text-gray-500">Paste the full key — the format is parsed automatically.</p>
                      {envVars.HELIX_API_KEY && wizardFieldErrors.HELIX_API_KEY && (
                        <p className="text-tiny text-danger">{wizardFieldErrors.HELIX_API_KEY}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2">
                        <span>App URL</span>
                        <span className="normal-case tracking-normal text-gray-500 font-normal">— optional</span>
                      </label>
                      <input
                        type="url"
                        name="helix-app-url"
                        autoComplete="off"
                        spellCheck={false}
                        data-1p-ignore
                        data-lpignore="true"
                        value={envVars.APP_URL}
                        onChange={(e) => setEnvVars({ ...envVars, APP_URL: e.target.value })}
                        className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.APP_URL && wizardFieldErrors.APP_URL ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
                        placeholder="http://localhost:8080"
                      />
                      {envVars.APP_URL && wizardFieldErrors.APP_URL && (
                        <p className="text-tiny text-danger">{wizardFieldErrors.APP_URL}</p>
                      )}
                    </div>
                  </div>

                  {setupError && (
                    <div className="mb-4 flex gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm items-start">
                      <span className="text-danger font-bold flex-shrink-0 leading-tight">×</span>
                      <div><span className="text-danger font-semibold">Verification failed:</span> <span className="text-gray-300">{setupError}</span></div>
                    </div>
                  )}

                  <button
                    onClick={handleInitialize}
                    disabled={isVerifying || !wizardCanSubmit}
                    title={!wizardCanSubmit ? 'Fix the field errors above before continuing' : ''}
                    className="w-full bg-primary hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-3 rounded font-semibold transition-all"
                  >
                    {isVerifying ? 'Saving…' : 'Save & initialize →'}
                  </button>
                </div>
              )}

              {setupStep === 2 && (
                <div className="adapt-card">
                  <h2 className="text-lg font-bold mb-4 text-gray-200">Step 2: Add helix-gateway as an exporter</h2>

                  {/* Step 2 context banner — green check on a blue field. */}
                  <div className="mb-4 flex items-start gap-3 p-3 bg-active/10 border border-active/40 rounded text-sm">
                    <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                    <span className="text-gray-200"><span className="font-semibold">helix-gateway is already configured.</span> Just add it as an exporter in your collector config.</span>
                  </div>

                  {/* Smart-add — when exactly one OTel collector is detected
                      on this host, the configurator can read its config,
                      compute the merge, and apply it (with a backup +
                      restart) for the user. POC scope. */}
                  {smartAddResult && (
                    <div className={`mb-4 flex items-start gap-3 p-3 rounded text-sm ${smartAddResult.ok ? 'bg-success/10 border border-success/40' : 'bg-danger/10 border border-danger/40'}`}>
                      {smartAddResult.ok ? <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />}
                      <span className="text-gray-200">{smartAddResult.message}</span>
                    </div>
                  )}
                  {!smartAddResult && smartAddProposal && (
                    <div className="mb-5 p-4 bg-gray-1000 border border-active/40 rounded">
                      <div className="flex items-center gap-2 mb-2">
                        <Container className="w-4 h-4 text-active" />
                        <span className="text-sm font-semibold text-gray-100">Smart-add — apply automatically</span>
                        <span className="ml-auto text-tiny text-gray-500">POC</span>
                      </div>
                      {smartAddProposal.error ? (
                        <p className="text-tiny text-warning">⚠ {smartAddProposal.error} You can still apply the snippet below manually.</p>
                      ) : smartAddProposal.alreadyConfigured ? (
                        <p className="text-tiny text-gray-300">
                          Detected <code className="font-mono text-gray-100">{smartAddProposal.name}</code> at <code className="font-mono text-gray-200">{smartAddProposal.configPath}</code>.{' '}
                          <span className="text-success font-semibold">Already configured</span> — <code className="font-mono">{smartAddProposal.existingExporterName}</code> already points at <code className="font-mono">helix-gateway:4318</code>. No changes needed.
                        </p>
                      ) : (
                        <>
                          <p className="text-tiny text-gray-300 mb-3">
                            Detected <code className="font-mono text-gray-100">{smartAddProposal.name}</code> at <code className="font-mono text-gray-200">{smartAddProposal.configPath}</code>.{' '}
                            We'll add <code className="font-mono text-gray-100">{smartAddProposal.exporterName}</code> as an exporter and wire it into{' '}
                            <strong className="text-gray-200">{(smartAddProposal.addedToPipelines || []).join(', ')}</strong> pipelines.
                            The original is preserved as <code className="font-mono">.helix-bak</code> in the container.
                          </p>
                          <button
                            onClick={() => requestSmartAddApply(smartAddProposal.name)}
                            disabled={smartAddApplying}
                            className="inline-flex items-center gap-2 px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-primary hover:bg-primary-hover disabled:opacity-60 text-white"
                          >
                            {smartAddApplying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            {smartAddApplying ? 'Applying…' : 'Apply automatically'}
                          </button>
                          <span className="text-tiny text-gray-500 ml-3">Or copy the snippets below to apply manually.</span>
                        </>
                      )}
                    </div>
                  )}
                  {!smartAddResult && smartAddLoading && (
                    <div className="mb-4 flex items-center gap-2 text-tiny text-gray-500">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading detected collector config…
                    </div>
                  )}

                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Exporter</span>
                  </div>
                  <SnippetBlock text={`exporters:
  otlphttp/helix_sidecar:
    endpoint: "http://helix-gateway:4318"
    tls:
      insecure: true`} />
                  <p className="text-tiny text-gray-500 -mt-4 mb-6">
                    In your main collector config (e.g. <code className="font-mono">otelcol-config.yaml</code>). No API key needed here —{' '}
                    <button onClick={openGatewayConfigModal} className="text-active hover:underline font-semibold">view gateway config to see where it's set</button>.
                  </p>

                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Pipelines</span>
                  </div>
                  <SnippetBlock text={`service:
  pipelines:
    traces:
      exporters: [..., otlphttp/helix_sidecar]
    metrics:
      exporters: [..., otlphttp/helix_sidecar]
    logs:
      exporters: [..., otlphttp/helix_sidecar]`} />
                  <p className="text-tiny text-gray-500 -mt-4 mb-6">Wire into whichever pipelines your collector uses. Restart your collector after saving.</p>

                  <div className="border-t border-gray-800 pt-4 mb-4">
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                      Required resource attributes <span className="normal-case tracking-normal text-gray-500 font-normal">— validated automatically in Step 4</span>
                    </div>
                    <div className="flex items-start gap-3 p-3 bg-gray-1000 border border-gray-800 rounded">
                      <span className="text-tiny font-mono text-gray-200 flex-shrink-0 pt-0.5"><code>service.name</code></span>
                      <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/20 text-warning flex-shrink-0">required</span>
                      <span className="text-tiny text-gray-400 flex-1">Your service in Helix topology &amp; dashboards.</span>
                    </div>
                  </div>

                  <div className="mb-3 flex items-start gap-2.5 p-3 rounded border border-warning/40 bg-warning/10 text-tiny text-gray-300">
                    <span className="text-warning font-bold flex-shrink-0 leading-tight" aria-hidden="true">!</span>
                    <span>After saving, restart your collector container so the new exporter takes effect.</span>
                  </div>
                  <div className="mb-6 flex items-start gap-2.5 p-3 rounded border border-active/30 bg-active/10 text-tiny text-gray-300">
                    <Activity className="w-3.5 h-3.5 text-info flex-shrink-0 mt-0.5" />
                    <span>Traces will also appear locally in <a href="/otel-data" className="text-active hover:underline font-semibold">View OTel Data</a> — no extra config needed.</span>
                  </div>

                  <div className="flex gap-4">
                    <button
                      onClick={() => setSetupStep(1)}
                      className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
                    >Back</button>
                    <button
                      onClick={() => setSetupStep(3)}
                      className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm"
                    >Next: Connect →</button>
                  </div>
                </div>
              )}

              {setupStep === 3 && (
                <div className="adapt-card">
                  <h2 className="text-lg font-bold mb-2 text-gray-200">Step 3: Connect your collector to <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">helix-bridge</code></h2>
                  <p className="text-sm text-gray-400 mb-4">helix-gateway and your collector need to share a Docker network. We tried to wire it up automatically — finish the job here if needed.</p>

                  {/* Auto-bridge result from Step 1's /api/lifecycle/bridge call. */}
                  {bridgeStatus?.kind === 'success' && (
                    <div className="mb-4 flex items-start gap-3 p-3 bg-success/10 border border-success/40 rounded text-sm">
                      <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                      <span className="text-gray-200"><span className="font-semibold">helix-gateway was automatically attached to your app's network.</span> It joined <code className="font-mono">{bridgeStatus.network}</code> (matched container <code className="font-mono">{bridgeStatus.targetContainer}</code>).</span>
                    </div>
                  )}
                  {bridgeStatus?.kind === 'skipped' && (
                    <div className="mb-4 flex items-start gap-3 p-3 bg-active/10 border border-active/40 rounded text-sm">
                      <Activity className="w-4 h-4 text-active flex-shrink-0 mt-0.5" />
                      <span className="text-gray-200"><span className="font-semibold">APP_URL is a localhost or IP address — auto-attach skipped.</span> Use the controls below to connect manually.</span>
                    </div>
                  )}
                  {bridgeStatus?.kind === 'error' && (
                    <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
                      <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                      <span className="text-gray-200"><span className="font-semibold">Auto-attach failed: </span>{bridgeStatus.reason}. Use the controls below to connect manually.</span>
                    </div>
                  )}

                  {/* Step 3 tabs: Detected on this host | Manual */}
                  <div className="flex border-b border-gray-800 mb-4 -mb-px">
                    <button
                      onClick={() => setStep3Tab('detected')}
                      className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
                        step3Tab === 'detected' ? 'border-active text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'
                      }`}
                    >Detected on this host</button>
                    <button
                      onClick={() => setStep3Tab('manual')}
                      className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
                        step3Tab === 'manual' ? 'border-active text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'
                      }`}
                    >Manual</button>
                  </div>

                  {step3Tab === 'detected' && (
                    <div className="mt-2">
                      {(() => {
                        const k8sDetected = detectedCollectors.some(c => c.isKubernetes);
                        return k8sDetected && (
                          <div className="mb-4 flex items-start gap-3 p-3 bg-primary/10 border border-primary/40 rounded text-sm">
                            <Hexagon className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                            <div className="flex-1">
                              <div className="font-semibold text-gray-100 mb-1">Kubernetes detected</div>
                              <p className="text-tiny text-gray-300">
                                Apply the K8s Attribute Enrichment template to auto-enrich telemetry with pod, namespace &amp; node metadata.
                              </p>
                            </div>
                            <button
                              onClick={requestApplyK8sTemplate}
                              disabled={k8sApplying || k8sApplyResult === 'applied'}
                              className={`flex-shrink-0 px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${
                                k8sApplyResult === 'applied'
                                  ? 'bg-success/20 text-success border border-success/40 cursor-default'
                                  : 'bg-primary hover:bg-primary-hover text-white disabled:opacity-60'
                              }`}
                            >
                              {k8sApplying ? 'Applying…' : k8sApplyResult === 'applied' ? '✓ Applied' : 'Apply template'}
                            </button>
                          </div>
                        );
                      })()}
                      {k8sApplyResult === 'failed' && (
                        <div className="mb-3 text-tiny text-danger">× Could not apply template — retry or apply it from the YAML editor on the dashboard.</div>
                      )}

                      {detectedCollectors.length === 0 ? (
                        <div className="p-4 text-center text-tiny text-gray-500 border border-gray-800 rounded bg-gray-1000">
                          No OTel collector containers detected on this host yet. Switch to the <button onClick={() => setStep3Tab('manual')} className="text-active hover:underline font-semibold">Manual</button> tab to attach by network name.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {detectedCollectors.map(c => {
                            const attachable = c.networks.filter(n => n !== 'helix-bridge');
                            const reachable = c.sharesNetworkWithSidecar;
                            return (
                              <div key={c.name} className="flex items-start justify-between gap-3 p-3 bg-gray-1000 border border-gray-800 rounded">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                                    <span className="text-gray-200 font-mono text-sm truncate">{c.name}</span>
                                    {c.isKubernetes && (
                                      <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/20 text-primary inline-flex items-center gap-1">
                                        <Hexagon className="w-2.5 h-2.5" />k8s
                                      </span>
                                    )}
                                    {reachable ? (
                                      <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-success/20 text-success">reachable</span>
                                    ) : (
                                      <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/20 text-warning">not reachable</span>
                                    )}
                                  </div>
                                  <div className="text-tiny text-gray-500 truncate" title={c.image}>
                                    {c.image}{attachable.length ? ` • on ${attachable.join(', ')}` : ''}
                                  </div>
                                </div>
                                {reachable ? (
                                  <span className="px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-success/20 text-success border border-success/40">Attached</span>
                                ) : attachable.length === 0 ? (
                                  <span className="text-tiny text-gray-500 self-center">no user networks</span>
                                ) : attachable.length === 1 ? (
                                  <button
                                    onClick={() => attachSidecarToNetwork(attachable[0])}
                                    disabled={attachingNetwork === attachable[0]}
                                    className="px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-primary hover:bg-primary-hover disabled:opacity-60 text-white"
                                  >
                                    {attachingNetwork === attachable[0] ? 'Attaching…' : 'Attach'}
                                  </button>
                                ) : (
                                  <div className="flex flex-col gap-1">
                                    {attachable.map(n => (
                                      <button
                                        key={n}
                                        onClick={() => attachSidecarToNetwork(n)}
                                        disabled={attachingNetwork === n}
                                        className="px-2 py-1 text-tiny rounded bg-primary hover:bg-primary-hover disabled:opacity-60 text-white font-semibold"
                                      >
                                        {attachingNetwork === n ? '…' : `Attach to ${n}`}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {attachResult && (
                            <div className={`text-tiny ${attachResult.ok ? 'text-success' : 'text-danger'}`}>
                              {attachResult.ok ? '✓' : '×'} {attachResult.message}
                            </div>
                          )}
                        </div>
                      )}
                      <p className="text-tiny text-gray-500 mt-3">After attaching, restart your collector so helix-gateway resolves.</p>
                    </div>
                  )}

                  {step3Tab === 'manual' && (
                    <div className="mt-2 space-y-4">
                      <div>
                        <p className="text-tiny text-gray-400 mb-2 font-semibold uppercase tracking-wider">Option A — attach helix-gateway to your app's network</p>
                        <SnippetBlock text="docker network connect <your-network> helix-gateway" />
                        <p className="text-tiny text-gray-500 -mt-4">
                          Replace <code className="font-mono">&lt;your-network&gt;</code> with your compose network name.
                        </p>
                      </div>
                      <div>
                        <p className="text-tiny text-gray-400 mb-2 font-semibold uppercase tracking-wider">Option B — attach your container to helix-bridge</p>
                        <SnippetBlock text="docker network connect helix-bridge <your-container>" />
                      </div>
                      <p className="text-tiny text-gray-500">Then restart your container.</p>
                    </div>
                  )}

                  {/* When helix-gateway is already on a user network with a
                      detected collector, surface a "you're done — skip ahead"
                      hint so re-entering users don't have to re-read Step 3. */}
                  {detectedCollectors.some(c => c.sharesNetworkWithSidecar) && (
                    <div className="mt-4 flex items-start gap-3 p-2.5 bg-success/10 border border-success/40 rounded text-tiny text-gray-300">
                      <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
                      <span>
                        <span className="font-semibold text-gray-100">helix-gateway is already on a network with a detected collector.</span>{' '}
                        You can continue to Verify — no further attach needed.
                      </span>
                    </div>
                  )}
                  <div className="mt-6 flex gap-4">
                    <button
                      onClick={() => setSetupStep(2)}
                      className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
                    >Back</button>
                    <button
                      onClick={() => setSetupStep(4)}
                      className={`flex-1 px-6 py-3 rounded font-semibold transition-all text-sm text-white ${
                        detectedCollectors.some(c => c.sharesNetworkWithSidecar)
                          ? 'bg-success hover:bg-success-hover'
                          : 'bg-primary hover:bg-primary-hover'
                      }`}
                    >{detectedCollectors.some(c => c.sharesNetworkWithSidecar) ? 'Continue to Verify →' : 'Next: Verify →'}</button>
                  </div>
                </div>
              )}

              {setupStep === 4 && (
                <div className="adapt-card">
                  <h2 className="text-lg font-bold mb-2 text-gray-200">Step 4: Verify telemetry is flowing</h2>
                  <p className="text-sm text-gray-400 mb-5">Three quick checks. Restart your app or collector first if you just changed config.</p>

                  {/* Mirror the Step 3 bridge banner here too — users can land
                      on Step 4 directly via the stepper without seeing Step 3,
                      and a "skipped" or "failed" bridge is the most common
                      reason live counters stay at zero. */}
                  {bridgeStatus?.kind === 'skipped' && (() => {
                    const noUserNetwork = !detectedCollectors.some(c => c.sharesNetworkWithSidecar);
                    if (!noUserNetwork) return null;
                    return (
                      <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
                        <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                        <span className="text-gray-200">
                          <span className="font-semibold">Auto-attach was skipped and helix-gateway isn't sharing a network with any detected collector.</span>{' '}
                          Live counters will stay at zero until you{' '}
                          <button onClick={() => setSetupStep(3)} className="text-active hover:underline font-semibold">go back to Step 3</button>{' '}
                          and attach.
                        </span>
                      </div>
                    );
                  })()}
                  {bridgeStatus?.kind === 'error' && (
                    <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
                      <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                      <span className="text-gray-200">
                        <span className="font-semibold">Auto-attach failed in Step 1: </span>{bridgeStatus.reason}.{' '}
                        <button onClick={() => setSetupStep(3)} className="text-active hover:underline font-semibold">Go back to Step 3</button>{' '}
                        to connect manually if you haven't already.
                      </span>
                    </div>
                  )}

                  {/* Live counters — three cards. Reuse the existing
                      receiver-counters polling (re-keyed on step 4). */}
                  {(() => {
                    const delta = (now: number | undefined, base: number | undefined) =>
                      typeof now === 'number' && typeof base === 'number' ? Math.max(0, now - base) : 0;
                    const dSpans = delta(receiverNow?.acceptedSpans, receiverBaseline?.acceptedSpans);
                    const dMetrics = delta(receiverNow?.acceptedMetricPoints, receiverBaseline?.acceptedMetricPoints);
                    const dLogs = delta(receiverNow?.acceptedLogRecords, receiverBaseline?.acceptedLogRecords);
                    const Card = ({ label, value }: { label: string; value: number }) => (
                      <div className="bg-gray-1000 border border-gray-800 rounded px-3 py-2.5">
                        <div className="text-tiny text-gray-500 uppercase tracking-wider">{label}</div>
                        <div className={`font-mono text-xl mt-1 ${value > 0 ? 'text-success' : 'text-gray-300'}`}>{value > 0 ? '+' : ''}{value}</div>
                      </div>
                    );
                    return (
                      <div className="mb-5">
                        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Live counters <span className="normal-case tracking-normal text-gray-500 font-normal">— since you opened this step</span></div>
                        <div className="grid grid-cols-3 gap-3">
                          <Card label="Spans" value={dSpans} />
                          <Card label="Metric points" value={dMetrics} />
                          <Card label="Log records" value={dLogs} />
                        </div>
                        {receiverError && <div className="mt-2 text-tiny text-warning">⚠ {receiverError}</div>}
                        {appExportErrors.length > 0 && (
                          <div className="mt-3 p-2.5 rounded border border-warning/40 bg-warning/10">
                            <div className="text-tiny text-warning font-semibold uppercase tracking-wider mb-1">⚠ Errors detected on your side</div>
                            {appExportErrors.map(err => (
                              <div key={err.container} className="mb-2 last:mb-0">
                                <div className="text-tiny text-gray-300 font-mono mb-0.5">{err.container}</div>
                                <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-all bg-gray-1000 rounded p-2 max-h-32 overflow-auto select-text" style={{ fontFamily: "'Source Code Pro', monospace" }}>{err.lines.slice(-3).join('\n')}</pre>
                              </div>
                            ))}
                            <div className="text-tiny text-gray-400 mt-1">
                              Common fixes: confirm the container is on the <code className="font-mono text-gray-300">helix-bridge</code> network, the endpoint is <code className="font-mono text-gray-300">http://helix-gateway:4318</code> (not gRPC :4317), and the API key is correct.
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Resource attributes — service.name detection. */}
                  {(() => {
                    const detected = recentServices[0];
                    return (
                      <div className="mb-5">
                        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Resource attributes</div>
                        <div className={`flex items-start gap-3 p-3 rounded border ${detected ? 'bg-success/10 border-success/40' : 'bg-warning/10 border-warning/40'}`}>
                          {detected ? (
                            <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                          )}
                          <div className="flex-1">
                            <code className="font-mono text-sm text-gray-200">service.name</code>
                            {detected ? (
                              <span className="ml-2 text-sm text-gray-200">= <code className="font-mono">{detected}</code></span>
                            ) : (
                              <span className="ml-2 text-sm text-gray-300">— not detected — make sure your collector sets <code className="font-mono">service.name</code></span>
                            )}
                            {detected && recentServices.length > 1 && (
                              <div className="text-tiny text-gray-500 mt-1">Also seeing: {recentServices.slice(1, 4).map(s => <code key={s} className="font-mono text-gray-400 mr-2">{s}</code>)}</div>
                            )}
                          </div>
                        </div>
                        {detectedCollectors.some(c => c.isKubernetes) && (
                          <div className="mt-2 flex items-start gap-3 p-2.5 rounded border border-primary/40 bg-primary/10 text-tiny text-gray-300">
                            <Hexagon className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
                            <span>Kubernetes detected — <code className="font-mono">k8s.namespace.name</code> and <code className="font-mono">k8s.cluster.name</code> are being enriched automatically via the K8s Attribute Enrichment template.</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Gateway → Helix synthetic verify */}
                  <div className="mb-5">
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Gateway → Helix</div>
                    {traceVerifyResult && traceVerifyResult.status === 'exported' ? (
                      <div className="flex items-start gap-3 p-3 bg-success/10 border border-success/40 rounded text-sm">
                        <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <span className="text-gray-200 font-semibold">Synthetic trace reached Helix.</span>
                          <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
                          <div className="text-tiny text-gray-500 mt-1">Run <button onClick={handleVerifyTelemetry} disabled={verifyingTrace} className="text-active hover:underline font-semibold disabled:opacity-60">again</button> any time.</div>
                          {envVars.HELIX_API_KEY && envVars.HELIX_API_KEY.startsWith('FAKE-') && (
                            <div className="mt-2 text-tiny text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1.5">
                              <span className="font-semibold">Heads up:</span> your <code className="font-mono">HELIX_API_KEY</code> is a placeholder — Helix returns 200 for any request. Replace it with a real tenant key.
                            </div>
                          )}
                        </div>
                      </div>
                    ) : traceVerifyResult && traceVerifyResult.status === 'rejected' ? (
                      <div className="flex items-start gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm">
                        <span className="text-danger font-bold flex-shrink-0 leading-tight">×</span>
                        <div>
                          <span className="text-gray-200 font-semibold">Helix rejected the trace.</span>
                          <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
                          {traceVerifyResult.remediation && <p className="text-tiny text-gray-400 mt-1">{traceVerifyResult.remediation}</p>}
                        </div>
                      </div>
                    ) : traceVerifyResult && traceVerifyResult.status === 'pending' ? (
                      <div className="flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
                        <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                        <div>
                          <span className="text-gray-200 font-semibold">Trace queued but not yet exported.</span>
                          <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
                          {traceVerifyResult.remediation && <p className="text-tiny text-gray-400 mt-1">{traceVerifyResult.remediation}</p>}
                        </div>
                      </div>
                    ) : traceVerifyResult && traceVerifyResult.status === 'error' ? (
                      <div className="flex items-start gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm">
                        <span className="text-danger font-bold flex-shrink-0 leading-tight">×</span>
                        <div>
                          <span className="text-gray-200 font-semibold">Verification failed.</span>
                          <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
                          {traceVerifyResult.remediation && <p className="text-tiny text-gray-400 mt-1">{traceVerifyResult.remediation}</p>}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
                        <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                        <span className="text-gray-200">Not yet verified. Run the synthetic check below.</span>
                      </div>
                    )}
                  </div>

                  {/* Blueprint prerequisite banner */}
                  <div className="mb-5 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
                    <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="text-gray-200">Before topology appears in Helix, the <span className="font-semibold">Default Blueprint for OTel Service</span> must be enabled in AIOps.</span>{' '}
                      {envVars.HELIX_ENDPOINT && (
                        <a
                          href={`${envVars.HELIX_ENDPOINT.replace(/\/+$/, '')}/aiops/#/configurations/manageOpentelemetry`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-active hover:underline font-semibold inline-flex items-center gap-1"
                        >
                          Open Manage OpenTelemetry <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-4">
                    <button
                      onClick={() => setSetupStep(3)}
                      className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
                    >Back</button>
                    <button
                      onClick={handleVerifyTelemetry}
                      disabled={verifyingTrace}
                      className="flex-1 bg-warning hover:bg-warning-hover text-gray-900 px-6 py-3 rounded font-semibold transition-all disabled:opacity-60 disabled:cursor-not-allowed text-sm flex items-center justify-center gap-2"
                      title="Inject a synthetic trace and confirm it reaches Helix — independent of your app"
                    >
                      {verifyingTrace && <Loader2 className="w-4 h-4 animate-spin" />}
                      {verifyingTrace ? 'Verifying…' : 'Verify Gateway → Helix'}
                    </button>
                    <button
                      onClick={() => {
                        localStorage.setItem('helix-configurator.onboarded', '1');
                        setIsSetupComplete(true);
                      }}
                      className="flex-1 bg-success hover:bg-success-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm"
                    >Launch Dashboard</button>
                  </div>

                  <div className="mt-6 pt-4 border-t border-gray-800 text-tiny text-gray-500 leading-relaxed">
                    <span className="font-semibold text-gray-400 uppercase tracking-wider">After launch:</span>
                    <ul className="mt-2 space-y-1 list-disc list-inside">
                      <li>Run a <span className="text-gray-300">Diagnostic Health Check</span> to validate config, API key, and tenant reachability.</li>
                      <li>Use <span className="text-gray-300">Load Template</span> in the YAML editor to switch to a tail-sampling, Prometheus, or Kubernetes-attribute starter.</li>
                      <li>Add an <span className="text-gray-300">AIOps Business Service Key</span> from Settings to enable the deep-link button.</li>
                    </ul>
                  </div>
                </div>
              )}

              {/* Gateway config modal — opened from Step 2's "view gateway
                  config" link. Read-only — full editing happens on the
                  dashboard's YAML editor card. */}
              {gatewayConfigOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={() => setGatewayConfigOpen(false)}>
                  <div
                    className="adapt-card !p-0 max-w-3xl w-full max-h-[80vh] flex flex-col overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-800 bg-gray-900">
                      <div>
                        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Gateway config</div>
                        <div className="text-sm text-gray-200">Where the auth headers live</div>
                      </div>
                      <button onClick={() => setGatewayConfigOpen(false)} className="text-gray-400 hover:text-gray-200 p-1 rounded hover:bg-gray-800">
                        <X className="w-5 h-5" />
                      </button>
                    </header>
                    <div className="px-5 py-3 text-tiny text-gray-400 border-b border-gray-800 bg-gray-1000">
                      Written automatically in Step 1. Your collector routes to the gateway receiver; the gateway authenticates to Helix via the highlighted headers.
                    </div>
                    <div className="flex-1 overflow-auto p-4 bg-gray-1000">
                      <pre className="font-mono text-tiny text-gray-300 whitespace-pre" style={{ fontFamily: "'Source Code Pro', monospace" }}>
                        {gatewayConfigText
                          ? gatewayConfigText.split('\n').map((line, i) => {
                              const highlight = /(X-Api-Key|X-Source|endpoint:)/.test(line);
                              return (
                                <div key={i} className={highlight ? 'bg-warning/15 border-l-2 border-warning pl-2 -ml-2' : ''}>{line || ' '}</div>
                              );
                            })
                          : <span className="text-gray-500">Loading…</span>}
                      </pre>
                    </div>
                    <footer className="px-5 py-3 border-t border-gray-800 bg-gray-900 flex justify-between items-center">
                      <span className="text-tiny text-gray-500">Read-only here. Full editor available on the dashboard after launch.</span>
                      <button
                        onClick={() => setGatewayConfigOpen(false)}
                        className="text-tiny font-semibold text-gray-300 hover:text-gray-100"
                      >
                        Close
                      </button>
                    </footer>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Row 1 */}
              <div className="grid grid-cols-2 gap-6">
                {/* Helix Gateway Status */}
                <div className="adapt-card">
                  <div className="flex items-center gap-3 mb-4">
                    <div
                      className={`w-3 h-3 rounded-full ${getStatusColor()} ${gatewayStatus === 'running' ? 'animate-pulse' : ''}`}
                      aria-hidden="true"
                    ></div>
                    <h2 className="text-lg font-bold text-gray-200">Helix Gateway Status</h2>
                    <span
                      className="text-tiny text-gray-400 uppercase tracking-wider font-semibold ml-auto"
                      role="status"
                      aria-live="polite"
                    >
                      {gatewayStatus === 'unknown' ? 'Checking…' : gatewayStatus}
                    </span>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={handleStart}
                      disabled={gatewayStatus === 'running' || actionLoading !== null}
                      className="flex-1 bg-success text-white py-2 rounded font-semibold hover:bg-[#006640] transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
                    >
                      {actionLoading === 'start' && <Loader2 className="w-4 h-4 animate-spin" />}
                      Start
                    </button>
                    <button
                      onClick={handleStop}
                      disabled={gatewayStatus === 'exited' || actionLoading !== null}
                      className="flex-1 border border-danger text-danger bg-danger/5 hover:bg-danger/10 py-2 rounded font-semibold transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
                    >
                      {actionLoading === 'stop' && <Loader2 className="w-4 h-4 animate-spin" />}
                      Stop
                    </button>
                    <button
                      onClick={handleRestart}
                      disabled={actionLoading !== null}
                      className="flex-1 bg-warning text-gray-900 py-2 rounded font-semibold hover:bg-[#d9ae00] transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
                    >
                      {actionLoading === 'restart' && <Loader2 className="w-4 h-4 animate-spin" />}
                      Restart
                    </button>
                  </div>
                </div>
                {/* Operation Shortcuts */}
                <div className="adapt-card">
                  <h2 className="text-lg font-bold mb-4 text-gray-200">Operation Shortcuts</h2>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={handleToggleDiagnostics}
                      disabled={(!isDiagnosticEnabled && !showDiagnostics) || isTogglingDiag}
                      className={`border border-gray-700 py-2 rounded font-medium transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${showDiagnostics ? 'bg-danger text-white hover:bg-[#890008]' : isDiagnosticEnabled ? 'bg-primary text-white hover:bg-[#3006c2]' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}
                      title={!isDiagnosticEnabled && !showDiagnostics ? "Connect to the Helix Gateway to enable diagnostics" : ""}
                    >
                      {isTogglingDiag && <Loader2 className="w-4 h-4 animate-spin" />}
                      {isTogglingDiag
                        ? (showDiagnostics ? 'Closing...' : 'Starting...')
                        : (showDiagnostics ? 'Close Diagnostics' : 'Run Diagnostic Health Check')}
                    </button>
                    <button
                      onClick={handleOpenServices}
                      className={`bg-gray-800 hover:bg-gray-700 border border-gray-700 py-2 rounded font-medium transition-colors text-sm ${isServicesOpen ? 'text-slate-100 bg-gray-700' : 'text-gray-200'}`}
                    >
                      Discovered Services
                    </button>
                    <button
                      onClick={handleQuickVerifyTelemetry}
                      className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-sm"
                    >
                      Re-verify Telemetry Flow
                    </button>
                    <button
                      onClick={handleCopySupportBundle}
                      className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-sm"
                    >
                      Copy Support Bundle
                    </button>
                    {helixConfig.baseUrl && (
                      <a
                        href={`${helixConfig.baseUrl}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?orgId=${helixConfig.tenantId}&var-BusinessService=${helixConfig.source}&var-OTelNamespace=${helixConfig.source}&from=now-3h&to=now&timezone=browser`}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-center block w-full text-sm"
                      >
                        Helix OTel Dashboard
                      </a>
                    )}
                    {helixConfig.baseUrl && helixConfig.businessServiceKey && (
                      <a
                        href={`${helixConfig.baseUrl}/aiops/#/entities/service/${extractServiceKey(helixConfig.businessServiceKey)}?type=key`}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-center block w-full text-sm"
                      >
                        AIOps Business Service
                      </a>
                    )}
                    {envVars.APP_URL && (
                      <a
                        href={envVars.APP_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-center block w-full text-sm"
                      >
                        Application UI
                      </a>
                    )}
                  </div>
                  {traceInjectionStatus === 'injecting' && (
                    <div className="mt-3 text-xs text-gray-400 animate-pulse text-center">Injecting synthetic diagnostic trace...</div>
                  )}
                  {traceInjectionStatus === 'success' && (
                    <div className="mt-3 text-xs text-success text-center">Synthetic Trace Injected Successfully</div>
                  )}
                  {traceInjectionStatus === 'error' && (
                    <div className="mt-3 text-xs text-danger text-center">Trace Injection Failed</div>
                  )}
                </div>
              </div>

              {/* Helix Connection Settings */}
              <div className="adapt-card">
                <button
                  onClick={() => setIsSettingsOpen(o => !o)}
                  className="flex items-center gap-2 w-full text-left group"
                >
                  <Settings className="w-4 h-4 text-gray-500 flex-shrink-0" />
                  <h2 className="text-base font-semibold text-gray-200 flex-1">Helix Connection Settings</h2>
                  <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${isSettingsOpen ? 'rotate-180' : ''}`} />
                </button>
                {isSettingsOpen && (
                  <div className="mt-5">
                    <div className="grid grid-cols-2 gap-6 mb-6">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Ingest Endpoint</label>
                        <input
                          type="text"
                          value={envVars.HELIX_ENDPOINT}
                          onChange={(e) => setEnvVars({ ...envVars, HELIX_ENDPOINT: e.target.value })}
                          className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm"
                          placeholder="https://otel-itom.onbmc.com"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">X-Api-Key (TenantID::AccessKey::SecretKey)</label>
                        <div className="relative">
                          <input
                            type="text"
                            name="helix-x-api-key"
                            autoComplete="off"
                            spellCheck={false}
                            data-1p-ignore
                            data-lpignore="true"
                            style={!showApiKey ? { WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties : undefined}
                            value={envVars.HELIX_API_KEY}
                            onChange={(e) => {
                              const parsed = parseHelixKeyBundle(e.target.value);
                              setEnvVars({ ...envVars, HELIX_API_KEY: parsed ?? e.target.value });
                            }}
                            className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 pr-16 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm"
                            placeholder="123456789::ABCDE12345::FGHIJ67890..."
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey(s => !s)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-tiny text-gray-400 hover:text-gray-200 uppercase tracking-wider font-semibold px-1"
                          >
                            {showApiKey ? 'Hide' : 'Show'}
                          </button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">X-Source (Business Service)</label>
                        <input
                          type="text"
                          value={envVars.X_SOURCE}
                          onChange={(e) => setEnvVars({ ...envVars, X_SOURCE: e.target.value.replace(/[^a-zA-Z0-9\-_]/g, '') })}
                          className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm"
                          placeholder="Source Name"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">App URL (optional)</label>
                        <input
                          type="text"
                          value={envVars.APP_URL}
                          onChange={(e) => setEnvVars({ ...envVars, APP_URL: e.target.value })}
                          className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm"
                          placeholder="http://localhost:8080"
                        />
                      </div>
                      <div className="space-y-1 col-span-2">
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">AIOps Business Service Key (optional)</label>
                        <input
                          type="text"
                          value={envVars.BUSINESS_SERVICE_KEY}
                          onChange={(e) => setEnvVars({ ...envVars, BUSINESS_SERVICE_KEY: extractServiceKey(e.target.value) })}
                          className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm"
                          placeholder="e.g. LYVlMZN2grhnvxM4uik8s5PmVpJNidFS — or paste the full AIOps service URL"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button
                        onClick={handleUpdateEnvSettings}
                        disabled={isUpdatingSettings}
                        className="bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-8 py-2 rounded font-semibold transition-all shadow-1 text-sm flex items-center gap-2"
                      >
                        {isUpdatingSettings && <Loader2 className="w-4 h-4 animate-spin" />}
                        {isUpdatingSettings ? 'Updating...' : 'Update Settings'}
                      </button>
                    </div>
                    <div className="mt-5 pt-4 border-t border-gray-800 flex items-center gap-2 text-tiny">
                      <span className="font-semibold text-gray-400 uppercase tracking-wider">Access:</span>
                      {authStatus?.required ? (
                        <span className="text-success">Password required ✓</span>
                      ) : (
                        <>
                          <span className="text-warning">Open (no password)</span>
                          <span className="text-gray-500">— set <span className="font-mono text-gray-300">UI_AUTH_PASSWORD</span> in <span className="font-mono text-gray-300">.env</span> and restart to require sign-in.</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {showDiagnostics && (
                <>
                  {/* Row 2 */}
                  <div className="adapt-card">
                    <h2 className="text-lg font-bold mb-4 text-gray-200">Helix Troubleshooting & Diagnostics</h2>
                    <div className="grid grid-cols-4 gap-4">
                      {['Collector Configuration', 'X-API Key Format', 'X-Source Format', 'Tenant URL Endpoint'].map((title, i) => {
                        let isPass = false;
                        let isChecking = false;
                        let subDetail = '';
                        let remediation = '';

                        if (title === 'Collector Configuration') {
                          isPass = collectorDiag.status === 'PASS';
                          isChecking = collectorDiag.status === 'unknown';
                          subDetail = collectorDiag.error || '';
                          remediation = collectorDiag.remediation || '';
                        }
                        if (title === 'X-API Key Format') {
                          isPass = apiKeyDiag.status === 'PASS';
                          isChecking = apiKeyDiag.status === 'unknown';
                          subDetail = apiKeyDiag.error || '';
                          remediation = apiKeyDiag.remediation || '';
                        }
                        if (title === 'X-Source Format') {
                          isPass = !!(envVars.X_SOURCE && envVars.X_SOURCE.length > 0);
                          isChecking = !envLoaded;
                          remediation = isPass ? '' : 'X-Source is required to identify your telemetry data.';
                        }
                        if (title === 'Tenant URL Endpoint') {
                          isPass = networkDiag.status === 'Success';
                          isChecking = networkDiag.status === 'unknown';
                          subDetail = networkDiag.error || '';
                          remediation = networkDiag.remediation || '';
                        }

                        return (
                          <div key={i} className="flex flex-col gap-2">
                            <div className="bg-gray-800 border border-gray-700 p-4 rounded flex flex-col items-center justify-center gap-3 relative group min-h-[120px]">
                              <span className="text-sm font-semibold text-gray-300 text-center">{title}</span>
                              {isPass ? (
                                <span className="adapt-badge-success px-3 py-1 uppercase tracking-wider">
                                  Pass
                                </span>
                              ) : isChecking ? (
                                <span className="flex items-center gap-2 px-3 py-1 uppercase tracking-wider text-xs font-semibold text-gray-400 bg-gray-800 border border-gray-700 rounded">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  Checking
                                </span>
                              ) : (
                                <div className="flex flex-col items-center gap-2">
                                  <span className="adapt-badge-danger px-3 py-1 uppercase tracking-wider">
                                    Fail
                                  </span>
                                  {subDetail && (
                                    <span className="text-[10px] text-danger font-medium text-center leading-tight">
                                      {subDetail}
                                    </span>
                                  )}
                                  {remediation && (
                                    <button
                                      onClick={() => setExpandedRemediations(prev => ({ ...prev, [i]: !prev[i] }))}
                                      className="text-info text-[11px] font-bold hover:underline cursor-pointer bg-transparent border-none mt-1"
                                    >
                                      {expandedRemediations[i] ? 'Hide Fix' : 'View Fix'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                            {expandedRemediations[i] && remediation && (
                              <div className="bg-gray-1000 border-l-2 border-danger p-3 rounded-r text-xs text-gray-200 animate-in fade-in slide-in-from-top-2 duration-200">
                                <div className="flex items-center justify-between mb-1">
                                  <p className="font-bold text-danger uppercase tracking-tighter">Remediation Step:</p>
                                  <button
                                    onClick={() => {
                                      const text = `[${title}] ${subDetail ? subDetail + '\n' : ''}${remediation}`;
                                      copyToClipboard(text);
                                    }}
                                    className="text-tiny text-info hover:underline uppercase tracking-wider font-semibold"
                                    title="Copy remediation text for sharing"
                                  >
                                    Copy
                                  </button>
                                </div>
                                {remediation}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Row 3 */}
                  <div className="adapt-card flex flex-col relative overflow-hidden">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <h2 className="text-lg font-bold text-gray-200">{connectedApp ? `${connectedApp} Logs` : 'Helix Gateway Logs'}</h2>
                        <button
                          onClick={handleOpenRawMetrics}
                          className="text-info text-tiny font-semibold uppercase tracking-wider hover:underline"
                        >
                          Show Raw Metrics
                        </button>
                        {!sseConnected && (
                          <button
                            onClick={() => setSseAttempt(n => n + 1)}
                            className="flex items-center gap-1.5 bg-warning/15 border border-warning/40 text-warning px-2 py-0.5 rounded text-tiny font-semibold uppercase tracking-wider hover:bg-warning/25"
                            title="Log stream disconnected — click to reconnect"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-warning"></span>
                            Reconnect
                          </button>
                        )}
                        {diagAlert && (
                          <span
                            className="flex items-center gap-2 bg-[#f5bcc6]/20 border border-danger/40 text-danger px-3 py-1 rounded text-tiny font-semibold uppercase tracking-wide"
                            title="Counted from log lines containing 'sending queue is full', 'exporting failed', 'connection refused', or 'deadline exceeded' in the streamed container."
                          >
                            <span className="font-bold">!</span> Drop events in logs — check network or queue limits
                            {diagAlertCount > 1 && (
                              <span className="bg-danger text-white px-1.5 rounded-full text-[10px]">{diagAlertCount}</span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {(() => {
                          const ratesFor = (key: 'received' | 'sent' | 'failed') => {
                            if (metricsHistory.length < 2) return [] as number[];
                            const out: number[] = [];
                            for (let i = 1; i < metricsHistory.length; i++) {
                              out.push(Math.max(0, metricsHistory[i][key] - metricsHistory[i - 1][key]));
                            }
                            return out;
                          };
                          const renderSpark = (data: number[], stroke: string) => {
                            if (data.length < 2) return <div style={{ height: 14 }} />;
                            const max = Math.max(...data, 1);
                            const w = 72, h = 14;
                            const pts = data.map((v, i) => {
                              const x = (i / (data.length - 1)) * w;
                              const y = h - (v / max) * h;
                              return `${x.toFixed(1)},${y.toFixed(1)}`;
                            }).join(' ');
                            return (
                              <svg width={w} height={h} className="mt-1">
                                <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.2} />
                              </svg>
                            );
                          };
                          return (
                            <>
                              <div className="bg-gray-800 border-l-2 border-info px-3 py-1.5 rounded-r min-w-[88px]">
                                <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Received</div>
                                <div className="text-lg font-bold text-info leading-tight">{liveMetrics.received}</div>
                                {renderSpark(ratesFor('received'), '#3759d8')}
                              </div>
                              <div className="bg-gray-800 border-l-2 border-success px-3 py-1.5 rounded-r min-w-[88px]">
                                <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Sent</div>
                                <div className="text-lg font-bold text-success leading-tight">{liveMetrics.sent}</div>
                                {renderSpark(ratesFor('sent'), '#11845b')}
                              </div>
                              {(() => {
                                // The "DROPPED" card needs to reflect both
                                // gateway-side send failures (otelcol_exporter_
                                // send_failed_*) and log-pattern alerts
                                // captured from the streamed container. Show
                                // the larger of the two so users don't see "0"
                                // while a 196-event alert is screaming. Hover
                                // breaks down where it came from.
                                const droppedHeadline = Math.max(liveMetrics.failed, diagAlertCount);
                                const breakdown = `Gateway send-failures (otelcol_exporter_send_failed_*): ${liveMetrics.failed}\nDrop events in streamed logs: ${diagAlertCount}`;
                                return (
                                  <div
                                    className="bg-gray-800 border-l-2 border-danger px-3 py-1.5 rounded-r min-w-[88px]"
                                    title={breakdown}
                                  >
                                    <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Dropped</div>
                                    <div className="text-lg font-bold text-danger leading-tight">{droppedHeadline}</div>
                                    {liveMetrics.failed !== diagAlertCount && (
                                      <div className="text-[9px] text-gray-500 leading-tight">
                                        {diagAlertCount} log · {liveMetrics.failed} metric
                                      </div>
                                    )}
                                    {renderSpark(ratesFor('failed'), '#b2001e')}
                                  </div>
                                );
                              })()}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                    {timeline.length > 0 && (
                      <div className="mb-3 pt-3 pb-2 border-t border-gray-800">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Timeline</span>
                          <span className="text-tiny text-gray-600">{timeline.length} event{timeline.length === 1 ? '' : 's'}</span>
                        </div>
                        <div className="flex gap-1.5 overflow-x-auto pb-1">
                          {timeline.map((ev, idx) => {
                            const time = new Date(ev.ts).toLocaleTimeString([], { hour12: false });
                            const colorByKind: Record<TimelineKind, string> = {
                              'config-saved': 'bg-info/15 border-info/40 text-info',
                              'restart': 'bg-warning/15 border-warning/40 text-warning',
                              'attach': 'bg-success/15 border-success/40 text-success',
                              'error-spike': 'bg-danger/15 border-danger/40 text-danger',
                              'verify': 'bg-gray-800 border-gray-700 text-gray-300',
                            };
                            return (
                              <div
                                key={idx}
                                className={`flex-shrink-0 px-2.5 py-1 rounded border text-tiny font-medium ${colorByKind[ev.kind]}`}
                                title={ev.message}
                              >
                                <span className="font-mono opacity-70 mr-1.5">{time}</span>
                                <span>{ev.message}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Filter:</span>
                      <button
                        onClick={() => setLogFilter('helix')}
                        className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${logFilter === 'helix' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                      >
                        Helix Only
                      </button>
                      <button
                        onClick={() => setLogFilter('all')}
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
                      onScroll={handleLogScroll}
                      className="bg-gray-1000 p-4 rounded border border-gray-800 h-64 overflow-y-auto font-mono text-sm text-green-400"
                      style={{fontFamily: "'Source Code Pro', monospace"}}
                    >
                      {visibleLogs.map((log, idx) => (
                        <p key={idx} className="whitespace-pre-wrap mb-1">{log}</p>
                      ))}
                      <div ref={logEndRef} />
                      <p className="animate-pulse">_</p>
                    </div>
                  </div>
                </>
              )}

              {/* Row 4 — YAML Editor */}
              <div className={`adapt-card flex flex-col ${isYamlOpen ? 'h-[500px]' : ''}`}>
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setIsYamlOpen(o => !o)}
                    className="flex items-center gap-2 flex-1 text-left group"
                  >
                    <h2 className="text-base font-semibold text-gray-200 flex-1">Gateway Config (YAML)</h2>
                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${isYamlOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {isYamlOpen && (
                    <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                      <button
                        onClick={handleOpenTemplates}
                        className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-4 py-1.5 rounded text-sm font-semibold transition-colors"
                      >
                        Load Template
                      </button>
                      <button
                        onClick={handleUpdateConfig}
                        disabled={isConfigSaving}
                        className="bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-sm font-semibold transition-all flex items-center gap-2"
                      >
                        {isConfigSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                        {isConfigSaving ? 'Saving...' : 'Save Config'}
                      </button>
                    </div>
                  )}
                </div>
                {isYamlOpen && (
                  <div className="flex-1 border border-gray-800 rounded overflow-hidden mt-4">
                    <Editor
                      height="100%"
                      defaultLanguage="yaml"
                      theme="vs-dark"
                      value={config}
                      onMount={(editor, monacoInstance) => {
                        editorRef.current = editor;
                        editor.addCommand(
                          monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
                          () => { handleUpdateConfigRef.current(); }
                        );
                      }}
                      onChange={(v) => {
                        setConfig(v || '');
                        clearEditorMarkers();
                      }}
                      options={{
                        fontSize: 14,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        padding: { top: 16 }
                      }}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      <ConfirmDialog request={confirmDialog} onCancel={() => setConfirmDialog(null)} />

      <TemplatesModal
        isOpen={isTemplatesOpen}
        templates={templates}
        loadingTemplateId={loadingTemplateId}
        onApply={handleApplyTemplate}
        onClose={() => setIsTemplatesOpen(false)}
      />

      <RawMetricsModal
        isOpen={isRawMetricsOpen}
        text={rawMetricsText}
        isLoading={isLoadingRawMetrics}
        filter={rawMetricsFilter}
        onSetFilter={setRawMetricsFilter}
        onRefresh={handleOpenRawMetrics}
        onCopy={(filtered) => {
          navigator.clipboard.writeText(filtered);
          showToastMsg('Metrics copied to clipboard');
        }}
        onClose={() => setIsRawMetricsOpen(false)}
      />

      {/* Discovered Services Pinned Sidebar Panel */}
      <div
        className={`relative w-[450px] h-full flex-shrink-0 bg-gray-1000 border-l border-gray-700 shadow-4 flex flex-col transition-all duration-300 ease-in-out ${isServicesOpen ? 'translate-x-0' : 'hidden'}`}
        role={isServicesOpen ? 'dialog' : undefined}
        aria-modal={isServicesOpen ? true : undefined}
        aria-labelledby="discovered-services-title"
        aria-hidden={!isServicesOpen}
      >
        <div className="bg-gray-900 px-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0 h-[52px]">
          <h2 id="discovered-services-title" className="text-lg font-bold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Discovered Services
          </h2>
          <button
            onClick={() => setIsServicesOpen(false)}
            className="text-gray-400 hover:text-white p-1"
            aria-label="Close discovered services panel"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Namespace Dashboard Link */}
          {helixConfig.baseUrl && (
            <a
              href={`${helixConfig.baseUrl}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?orgId=${helixConfig.tenantId}&var-BusinessService=${helixConfig.source}&var-OTelNamespace=${helixConfig.source}&from=now-3h&to=now&timezone=browser`}
              target="_blank"
              rel="noreferrer"
              className="bg-info/10 border border-info/30 hover:bg-info/20 p-4 rounded-lg flex items-center justify-between group transition-all mb-6 block"
            >
              <div className="flex flex-col">
                <span className="text-info text-sm font-bold flex items-center gap-2">
                  View Namespace Dashboard
                  <ExternalLink className="w-4 h-4" />
                </span>
              </div>
            </a>
          )}

          {/* Section: Core Infrastructure */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-widest">
              <Server className="w-4 h-4" />
              Core Infrastructure
            </div>
            <div className="space-y-3">
              {discoveredContainers
                .filter(c => c.name.includes('helix-gateway'))
                .map(container => renderContainerCard(container, true))}
            </div>
          </section>

          {/* Section: Local Applications */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-widest">
              <Container className="w-4 h-4" />
              Local Applications
            </div>
            <div className="space-y-3">
              {(() => {
                const apps = discoveredContainers.filter(c => !c.name.includes('helix-gateway'));
                if (apps.length === 0) {
                  return (
                    <div className="border border-dashed border-gray-700 rounded-lg p-5 text-center text-sm text-gray-400 bg-gray-1000/50">
                      <p className="text-gray-300 font-semibold mb-1">No applications discovered</p>
                      <p className="text-tiny">Start your application on this Docker host, then click Discovered Services again to refresh.</p>
                    </div>
                  );
                }
                return apps.map(container => renderContainerCard(container, false));
              })()}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default App;