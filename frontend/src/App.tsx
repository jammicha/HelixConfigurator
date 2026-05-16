import React, { useState, useEffect, useRef } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { Check, Settings, Loader2, X, Activity, Container, ExternalLink, BarChart2, Unlink, Server, ChevronDown } from 'lucide-react';
import { useEscClose } from './hooks/useEscClose';
import { useLocalStorageState } from './hooks/useLocalStorageState';
import { useSmartAdd } from './hooks/useSmartAdd';
import { LoginScreen } from './components/LoginScreen';
import { ToastStack, Toast } from './components/ToastStack';
import { ConfirmDialog, ConfirmRequest } from './components/ConfirmDialog';
import { TemplatesModal, Template } from './components/TemplatesModal';
import { RawMetricsModal } from './components/RawMetricsModal';
import { Stepper } from './components/wizard/Stepper';
import { Step1 } from './components/wizard/Step1';
import { Step2 } from './components/wizard/Step2';
import { Step3 } from './components/wizard/Step3';
import type { DetectedCollector } from './components/wizard/Step3';
import { Step4 } from './components/wizard/Step4';
import { GatewayConfigModal, SmartAddPreviewModal } from './components/wizard/WizardModals';
import { parseHelixKeyBundle } from './utils/helixKey';
import { SystemHealthPanel } from './components/dashboard/SystemHealthPanel';

const App = () => {
  const monaco = useMonaco();
  const [config, setConfig] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  // Persist mid-wizard step so a browser refresh doesn't send the user back
  // to Step 1 with all their progress (env saved server-side, bridge state,
  // verify results) silently re-evaluated. Cleared on Launch Dashboard so
  // a return visit starts from Step 1 if onboarding is reopened.
  const [setupStep, setSetupStep] = useLocalStorageState<number>(
    'helix-configurator.setupStep',
    1,
    (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4,
  );
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

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isYamlOpen, setIsYamlOpen] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmRequest | null>(null);
  const [verifyingTrace, setVerifyingTrace] = useState(false);
  const [traceVerifyResult, setTraceVerifyResult] = useState<{ status: string; message: string; remediation?: string } | null>(null);
  // Result of Step 1's recreate call. Used only to surface a recreate
  // failure on Step 3/4 ("env changes may not have taken effect"). Network
  // wiring is Step 3's job now and no longer flows through this state.
  const [bridgeStatus, setBridgeStatus] = useState<
    | { kind: 'error'; reason: string }
    | null
  >(null);
  // Detected OTel collector containers running on this host. Populated when
  // Step 2 mounts; surfaced in the network callout so users with their own
  // collector can one-click attach helix-gateway to that collector's network.
  const [detectedCollectors, setDetectedCollectors] = useState<DetectedCollector[]>([]);
  const [attachingNetwork, setAttachingNetwork] = useState<string | null>(null);
  const [detachingNetwork, setDetachingNetwork] = useState<string | null>(null);
  const [attachResult, setAttachResult] = useState<{ network: string; ok: boolean; message: string } | null>(null);
  // Wizard redesign — Step 3 + Step 4 state.
  const [gatewayConfigOpen, setGatewayConfigOpen] = useState(false);
  const [gatewayConfigText, setGatewayConfigText] = useState<string>('');
  const [step3Tab, setStep3Tab] = useState<'detected' | 'manual'>('detected');
  const [k8sApplying, setK8sApplying] = useState<boolean>(false);
  const [k8sApplyResult, setK8sApplyResult] = useState<'applied' | 'failed' | null>(null);
  // App → Gateway verifier: poll the gateway's receiver counters and show
  // deltas since Step 2 was opened. Lets the user see real spans/metrics/logs
  // arriving from their app, not just the synthetic trace from the gateway.
  type ReceiverCounters = { acceptedSpans: number; acceptedMetricPoints: number; acceptedLogRecords: number };
  const [receiverBaseline, setReceiverBaseline] = useState<ReceiverCounters | null>(null);
  const [receiverNow, setReceiverNow] = useState<ReceiverCounters | null>(null);
  const [receiverError, setReceiverError] = useState('');
  const [appExportErrors, setAppExportErrors] = useState<{ container: string; lines: string[] }[]>([]);
  // gatewayStatus is the same shared state polled by the dashboard at the top
  // of the file. On Step 4 we add a faster 2s parallel poll (alongside the
  // receiver counters) so the wizard's "Gateway not running" affordance reacts
  // snappily without us having to chase the dashboard's 5s cadence.
  const [restartingGateway, setRestartingGateway] = useState(false);
  // Step 4 fallback: when the verify-trace check fails, the user can probe the
  // API key authoritatively (bypass the gateway, POST directly to Helix) to
  // disambiguate "key rejected" from "pipeline broken".
  const [apiKeyProbe, setApiKeyProbe] = useState<{
    status: string;
    message: string;
    remediation?: string;
    httpStatus?: number;
  } | null>(null);
  const [probingApiKey, setProbingApiKey] = useState(false);

  const [envVars, setEnvVars] = useState({
    HELIX_ENDPOINT: '',
    HELIX_API_KEY: '',
    X_SOURCE: '',
    APP_URL: '',
    BUSINESS_SERVICE_KEY: ''
  });

  const [testConnectionResult, setTestConnectionResult] = useState<{ status: string; message: string; remediation?: string; httpStatus?: number; latencyMs?: number } | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const handleTestConnection = async () => {
    if (testingConnection) return;
    setTestingConnection(true);
    setTestConnectionResult(null);
    try {
      const res = await fetch('/api/diagnostics/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: envVars.HELIX_ENDPOINT, apiKey: envVars.HELIX_API_KEY }),
      });
      const data = await res.json();
      setTestConnectionResult({
        status: data.status || (res.ok ? 'unknown' : 'error'),
        message: data.message || data.error || 'Test finished',
        remediation: data.remediation,
        httpStatus: data.httpStatus,
        latencyMs: data.latencyMs,
      });
    } catch (e: any) {
      setTestConnectionResult({ status: 'error', message: e?.message || 'Request failed' });
    } finally {
      setTestingConnection(false);
    }
  };

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
  const [systemHealth, setSystemHealth] = useState<any>(null);
  const handleUpdateConfigRef = useRef<() => void>(() => {});
  const telemetryTimerRef = useRef<any>(null);

  // Derived state: first connected app (excluding the gateway itself)
  const connectedApp = discoveredContainers.find(c => !c.name.includes('helix-gateway') && c.networks.includes('helix-bridge'))?.name || null;
  const isGatewayConnected = discoveredContainers.some(c => c.name.includes('helix-gateway') && c.networks.includes('helix-bridge'));
  const isDiagnosticEnabled = isGatewayConnected;
  // Install bundles ship HELIX_ENDPOINT=https://your-tenant.onbmc.com so the
  // wizard has something to validate against. Don't render Helix deep-links
  // until the user has replaced that placeholder with a real tenant URL —
  // otherwise clicking "View dashboard" opens the literal placeholder host.
  const hasRealHelixEndpoint = !!helixConfig.baseUrl && !/\/\/your-tenant\.onbmc\.com\b/i.test(helixConfig.baseUrl);

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

  // Clear stale test-connection result when the endpoint or key changes so
  // a previous verdict doesn't mislead after the user edits either field.
  useEffect(() => {
    setTestConnectionResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envVars.HELIX_ENDPOINT, envVars.HELIX_API_KEY]);

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
      // Don't reset gatewayStatus — the dashboard's always-on 5s poll owns
      // that state and we'd briefly clobber it on every Step 4 exit.
      return;
    }
    let cancelled = false;
    let baselineSet = false;
    const tick = async () => {
      if (cancelled) return;
      // Run the receiver-counter probe and the gateway-status probe in
      // parallel — both endpoints are cheap and we want them on the same
      // 2s cadence so the "Gateway not running" affordance updates in
      // step with the live counters.
      const [countersRes, statusRes] = await Promise.allSettled([
        fetch('/api/diagnostics/receiver-counters'),
        fetch('/api/lifecycle/status'),
      ]);
      if (cancelled) return;

      if (countersRes.status === 'fulfilled') {
        try {
          const res = countersRes.value;
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            if (!cancelled) setReceiverError(data.error || 'Gateway metrics unreachable');
          } else {
            const data = await res.json();
            if (!cancelled) {
              setReceiverError('');
              setReceiverNow(data);
              if (!baselineSet) { setReceiverBaseline(data); baselineSet = true; }
            }
          }
        } catch (e: any) {
          if (!cancelled) setReceiverError(e?.message || 'Network error');
        }
      } else {
        if (!cancelled) setReceiverError(countersRes.reason?.message || 'Network error');
      }

      if (statusRes.status === 'fulfilled') {
        try {
          const data = await statusRes.value.json();
          if (!cancelled) setGatewayStatus(typeof data?.status === 'string' ? data.status : 'unknown');
        } catch {
          if (!cancelled) setGatewayStatus('unknown');
        }
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

  useEffect(() => {
    if (!isSetupComplete) return;
    const fetchHealth = async () => {
      try {
        const r = await fetch('/api/diagnostics/system-health');
        if (r.ok) setSystemHealth(await r.json());
      } catch { /* keep last known good */ }
    };
    fetchHealth();
    const id = setInterval(fetchHealth, 30_000);
    return () => clearInterval(id);
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

      // Apply Step 1's env changes by recreating the gateway. Compose only
      // evaluates env_file at container create time, so a plain restart
      // wouldn't pick up the values we just persisted to .env. Network
      // wiring lives in Step 3 (it was previously bundled into this call
      // and driven off APP_URL — that conflated two unrelated concerns).
      setBridgeStatus(null);
      const bridgeRes = await fetch('/api/lifecycle/bridge', { method: 'POST' });

      // Poll until the gateway reports running. Slow hosts used to false-fail
      // the network diagnostic on a blind 3s sleep.
      const ready = await waitForGatewayRunning(15000);
      if (!ready) throw new Error('Gateway did not reach running state within 15s');
      if (!bridgeRes.ok) {
        const bridgeData = await bridgeRes.json().catch(() => ({}));
        const reason = bridgeData.error || bridgeData.details || 'Unknown error';
        console.warn('Gateway recreate failed:', reason);
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
      if (res.ok) {
        refreshDetectedCollectors();
        // If smart-add deferred a customer-collector restart (because the
        // gateway wasn't yet on a network this collector could reach), the
        // gateway is now on that network — finish the apply by restarting
        // the collector so it picks up the new helix_sidecar exporter with
        // a fresh DNS resolve.
        const pending = smartAdd.pendingRestart;
        if (pending) {
          try {
            await fetch('/api/lifecycle/restart-container', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: pending.containerName }),
            });
          } catch { /* non-fatal — the next bridge-network or manual restart will catch up */ }
          smartAdd.clearPendingRestart();
        }
      }
    } catch (e: any) {
      setAttachResult({ network, ok: false, message: e.message || 'Request failed' });
    } finally {
      setAttachingNetwork(null);
    }
  };

  // Reverse of attachSidecarToNetwork — disconnect helix-gateway from a
  // previously-bridged network and refresh the detected list so the row's
  // "reachable" badge clears. Also drops the entry from the persisted
  // bridged-networks.json on the backend, so a future configurator restart
  // doesn't re-attach to the network we just told it to leave.
  const detachSidecarFromNetwork = async (network: string) => {
    if (detachingNetwork) return;
    setDetachingNetwork(network);
    setAttachResult(null);
    try {
      const res = await fetch('/api/lifecycle/unbridge-network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network }),
      });
      const data = await res.json().catch(() => ({}));
      setAttachResult({ network, ok: res.ok, message: data.message || data.error || 'Detached' });
      if (res.ok) refreshDetectedCollectors();
    } catch (e: any) {
      setAttachResult({ network, ok: false, message: e.message || 'Request failed' });
    } finally {
      setDetachingNetwork(null);
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
        setGatewayConfigText(data.yaml || '');
      }
    } catch { /* non-fatal */ }
  };

  // Wipe wizard state and restart onboarding from Step 1. Asks for confirm
  // first — destructive. Calls the backend reset (clears .env, drops
  // bridged-networks persistence, recreates the gateway with clean env),
  // then resets every piece of React state the wizard relies on, drops
  // localStorage keys, and lands the user back on Step 1.
  const [resetting, setResetting] = useState(false);
  const requestResetOnboarding = () => {
    if (resetting) return;
    setConfirmDialog({
      title: 'Reset onboarding and start over?',
      message: 'This clears your Helix endpoint, API key, X-Source, App URL, and Business Service key from .env, drops any bridged networks the gateway is on, and recreates the gateway with empty values. The OTel trace store and your gateway YAML config are left alone. You\'ll land back on Step 1.',
      confirmLabel: 'Reset',
      onConfirm: async () => {
        setResetting(true);
        try {
          const res = await fetch('/api/lifecycle/reset-onboarding', { method: 'POST' });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            console.warn('reset-onboarding failed:', data);
          }
        } catch (e) {
          console.warn('reset-onboarding threw:', e);
        }
        // Clear UI state regardless of backend outcome — the user explicitly
        // asked to start over, so a backend partial failure shouldn't strand
        // them on a half-cleared page.
        setEnvVars({ HELIX_ENDPOINT: '', HELIX_API_KEY: '', X_SOURCE: '', APP_URL: '', BUSINESS_SERVICE_KEY: '' });
        setBridgeStatus(null);
        setAttachResult(null);
        setTraceVerifyResult(null);
        setApiKeyProbe(null);
        setSetupError('');
        setTelemetryStatus('idle');
        setIsSetupComplete(false);
        setSetupStep(1);
        localStorage.removeItem('helix-configurator.onboarded');
        localStorage.removeItem('helix-configurator.setupStep');
        setResetting(false);
      },
    });
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

  const smartAdd = useSmartAdd({ setupStep, isSetupComplete, detectedCollectors, refreshDetectedCollectors });

  // Step 4 fallback: probe the API key directly against Helix. Called from
  // the Verify result panel when verify-trace returned a non-success status.
  const handleProbeApiKey = async () => {
    if (probingApiKey) return;
    setProbingApiKey(true);
    setApiKeyProbe(null);
    try {
      const res = await fetch('/api/diagnostics/apikey-probe', { method: 'POST' });
      const data = await res.json();
      setApiKeyProbe({
        status: data.status || 'error',
        message: data.message || 'Probe finished without a status',
        remediation: data.remediation,
        httpStatus: data.httpStatus,
      });
    } catch (err: any) {
      setApiKeyProbe({ status: 'error', message: err?.message || 'Probe request failed' });
    } finally {
      setProbingApiKey(false);
    }
  };

  // Step 4 in-wizard remediation: restart the helix-gateway container when
  // the polled status shows it's not running. The 2s tick will pick up the
  // new state — we just flip the local 'restarting' flag for the button.
  const handleRestartGateway = async () => {
    if (restartingGateway) return;
    setRestartingGateway(true);
    setGatewayStatus('restarting');
    try {
      await fetch('/api/lifecycle/restart', { method: 'POST' });
    } catch { /* tick will surface the failure state */ }
    finally { setRestartingGateway(false); }
  };

  // Step 2 verification: inject a synthetic trace through the gateway and watch
  // for the sent counter to move. Proves gateway→Helix independent of whether
  // the user's app is instrumented yet.
  const handleVerifyTelemetry = async () => {
    if (verifyingTrace) return;
    setVerifyingTrace(true);
    setTraceVerifyResult(null);
    // Re-verifying invalidates the previous probe result; clear it so the
    // user isn't left looking at a stale "key was rejected" message.
    setApiKeyProbe(null);
    setTelemetryStatus('loading');
    try {
      // Pass the Step 3 customer collector (when there's exactly one detected
      // candidate sharing a network with the sidecar) so verify-trace can read
      // its helix-exporter counters too. Without this, "stuck at customer
      // side" and "stuck at gateway side" look identical from the verdict.
      const bridgedCollector = detectedCollectors.find(c => c.sharesNetworkWithSidecar);
      const verifyBody = bridgedCollector ? { collectorName: bridgedCollector.name } : undefined;
      const res = await fetch('/api/diagnostics/inject-trace-verify', {
        method: 'POST',
        headers: verifyBody ? { 'Content-Type': 'application/json' } : undefined,
        body: verifyBody ? JSON.stringify(verifyBody) : undefined,
      });
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

  // Tear down the diagnostic session: close SSE streams, stop metrics polling,
  // clear alert timer, flip state off, and tell the gateway to drop debug log
  // level. Called both from the user-facing toggle and automatically when the
  // user changes the connected app (attach/disconnect), so the user re-arms
  // diags intentionally for the new target rather than silently jumping.
  const stopDiagnosticsIfRunning = async () => {
    if (!showDiagnostics) return;
    if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; }
    if ((eventSourceRef as any).currentApp) {
      (eventSourceRef as any).currentApp.close();
      (eventSourceRef as any).currentApp = null;
    }
    if (metricsIntervalRef.current) { clearInterval(metricsIntervalRef.current); metricsIntervalRef.current = null; }
    if (diagAlertTimerRef.current) { clearTimeout(diagAlertTimerRef.current); diagAlertTimerRef.current = null; }
    setShowDiagnostics(false);
    setTraceInjectionStatus('');
    setDiagAlert(false);
    setDiagAlertCount(0);
    try {
      await fetch('/api/diagnostics/toggle-debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: false }),
      });
    } catch { /* non-fatal */ }
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
      await stopDiagnosticsIfRunning();
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
    // Tear down any active diagnostic session before changing the bridge —
    // the user re-arms diags for the new target intentionally, so we don't
    // silently swap the SSE source under them.
    await stopDiagnosticsIfRunning();
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
    // Same rationale as attach — close diags before changing the bridge.
    await stopDiagnosticsIfRunning();
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
          <span className="text-[10px] text-gray-500 truncate">{container.image}</span>
        </div>
        <div className="flex items-center gap-3">
          {container.networks.includes('helix-bridge') ? (
            <div className="flex items-center gap-2">
              <span className="adapt-badge-success gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#11845b] flex-shrink-0"></div>
                Connected
              </span>
              {hasRealHelixEndpoint && (
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
            <h1 className="text-white font-semibold text-[1.3125rem] m-0 ml-[15px] tracking-wide">Helix OTel Configurator</h1>
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
            <div className="max-w-4xl mx-auto mt-12 space-y-6">
              <h1 className="text-2xl font-semibold text-center text-gray-100">Welcome to Helix Configurator</h1>

              <Stepper current={setupStep} onJump={setSetupStep} />

              {/* Single discoverable escape hatch for "this got into a weird
                  state, let me start over." Lives on every wizard step so a
                  user mid-flow can wipe and restart without navigating away.
                  Confirmed before any destructive action. */}
              <div className="flex justify-end -mt-2">
                <button
                  onClick={requestResetOnboarding}
                  disabled={resetting}
                  className="text-tiny text-gray-500 hover:text-gray-300 underline disabled:opacity-60"
                  title="Clear .env (endpoint, API key, X-Source, App URL, business-service key), drop bridged networks, and restart from Step 1"
                >
                  {resetting ? 'Resetting…' : 'Reset onboarding and start over'}
                </button>
              </div>

              {setupStep === 1 && (
                <Step1
                  envVars={envVars}
                  setEnvVars={setEnvVars}
                  showApiKey={showApiKey}
                  setShowApiKey={setShowApiKey}
                  setupError={setupError}
                  isVerifying={isVerifying}
                  onInitialize={handleInitialize}
                  onTestConnection={handleTestConnection}
                  testConnectionResult={testConnectionResult}
                  testingConnection={testingConnection}
                />
              )}

              {setupStep === 2 && (
                <Step2
                  smartAddProposal={smartAdd.proposal}
                  smartAddResult={smartAdd.result}
                  smartAddLoading={smartAdd.loading}
                  onOpenSmartAddPreview={() => smartAdd.setPreviewOpen(true)}
                  onOpenGatewayConfig={openGatewayConfigModal}
                  onDismissResult={smartAdd.dismissResult}
                  onVerifyExporter={smartAdd.proposal ? () => smartAdd.refresh(smartAdd.proposal!.name) : null}
                  onBack={() => setSetupStep(1)}
                  onNext={() => setSetupStep(3)}
                />
              )}

              {setupStep === 3 && (
                <Step3
                  bridgeStatus={bridgeStatus}
                  tab={step3Tab}
                  setTab={setStep3Tab}
                  detectedCollectors={detectedCollectors}
                  attachingNetwork={attachingNetwork}
                  attachResult={attachResult}
                  onAttachNetwork={attachSidecarToNetwork}
                  onDetachNetwork={detachSidecarFromNetwork}
                  detachingNetwork={detachingNetwork}
                  k8sApplying={k8sApplying}
                  k8sApplyResult={k8sApplyResult}
                  onApplyK8sTemplate={requestApplyK8sTemplate}
                  onBack={() => setSetupStep(2)}
                  onNext={() => setSetupStep(4)}
                  onJumpToStep={setSetupStep}
                />
              )}

              {setupStep === 4 && (
                <Step4
                  bridgeStatus={bridgeStatus}
                  detectedCollectors={detectedCollectors}
                  receiverNow={receiverNow}
                  receiverBaseline={receiverBaseline}
                  receiverError={receiverError}
                  appExportErrors={appExportErrors}
                  gatewayStatus={gatewayStatus}
                  restartingGateway={restartingGateway}
                  onRestartGateway={handleRestartGateway}
                  apiKeyProbe={apiKeyProbe}
                  probingApiKey={probingApiKey}
                  onProbeApiKey={handleProbeApiKey}
                  traceVerifyResult={traceVerifyResult}
                  verifyingTrace={verifyingTrace}
                  envVars={envVars}
                  onJumpToStep={setSetupStep}
                  onVerifyTelemetry={handleVerifyTelemetry}
                  onLaunchDashboard={() => {
                    localStorage.setItem('helix-configurator.onboarded', '1');
                    // Drop the in-progress step so a future "Start onboarding
                    // again" from the nav lands on Step 1, not the last step
                    // the user happened to be on when they launched.
                    localStorage.removeItem('helix-configurator.setupStep');
                    setIsSetupComplete(true);
                    // Clean the URL — the user may have arrived from
                    // /onboarding (typed manually, or via the dev server's
                    // SPA fallback) or from /?view=onboarding (the nav link).
                    // Either way the dashboard's canonical URL is /, and
                    // leaving the wizard URL in the bar misleads on refresh.
                    if (window.location.pathname !== '/' || window.location.search) {
                      window.history.replaceState(null, '', '/');
                    }
                  }}
                />
              )}

              <GatewayConfigModal
                open={gatewayConfigOpen}
                text={gatewayConfigText}
                onClose={() => setGatewayConfigOpen(false)}
              />

              <SmartAddPreviewModal
                open={smartAdd.previewOpen}
                proposal={smartAdd.proposal}
                applying={smartAdd.applying}
                onClose={() => smartAdd.setPreviewOpen(false)}
                onApply={() => smartAdd.proposal && smartAdd.apply(smartAdd.proposal.name)}
                onCopyPath={copyToClipboard}
              />
            </div>
          ) : (
            <>
              <SystemHealthPanel health={systemHealth} />
              {/* Row 1 */}
              <div className="grid grid-cols-2 gap-6">
                {/* Helix Gateway Status */}
                <div className="adapt-card">
                  <div className="flex items-center gap-3 mb-4">
                    <div
                      className={`w-3 h-3 rounded-full ${getStatusColor()} ${gatewayStatus === 'running' ? 'animate-pulse' : ''}`}
                      aria-hidden="true"
                    ></div>
                    <h2 className="text-lg font-semibold text-gray-200">Helix Gateway Status</h2>
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
                  <h2 className="text-lg font-semibold mb-4 text-gray-200">Operation shortcuts</h2>
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
                    {hasRealHelixEndpoint && (
                      <a
                        href={`${helixConfig.baseUrl}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?orgId=${helixConfig.tenantId}&var-BusinessService=${helixConfig.source}&var-OTelNamespace=${helixConfig.source}&from=now-3h&to=now&timezone=browser`}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-center block w-full text-sm"
                      >
                        Helix OTel Dashboard
                      </a>
                    )}
                    {hasRealHelixEndpoint && helixConfig.businessServiceKey && (
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
                          onChange={(e) => setEnvVars({ ...envVars, X_SOURCE: e.target.value })}
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
                        <span className="text-success inline-flex items-center gap-1.5">Password required <Check className="w-3.5 h-3.5" aria-hidden="true" /></span>
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
                    <h2 className="text-lg font-semibold mb-4 text-gray-200">Helix troubleshooting & diagnostics</h2>
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
                        <h2 className="text-lg font-semibold text-gray-200">{connectedApp ? `${connectedApp} logs` : 'Helix gateway logs'}</h2>
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
                                <div className="text-xl font-semibold text-info leading-none tabular-nums">{liveMetrics.received}</div>
                                {renderSpark(ratesFor('received'), '#3759d8')}
                              </div>
                              <div className="bg-gray-800 border-l-2 border-success px-3 py-1.5 rounded-r min-w-[88px]">
                                <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Sent</div>
                                <div className="text-xl font-semibold text-success leading-none tabular-nums">{liveMetrics.sent}</div>
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
                                    <div className="text-xl font-semibold text-danger leading-none tabular-nums">{droppedHeadline}</div>
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
                          {/* Newest first (reverse-chronological). The state
                              array is append-only; we reverse here at render
                              so insertion stays O(1) and slice semantics
                              continue to evict oldest from the back. */}
                          {[...timeline].reverse().map((ev, idx) => {
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
                      className="bg-gray-1000 p-4 rounded border border-gray-800 h-64 overflow-y-auto font-mono text-sm text-success"
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
        currentConfigYaml={config}
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
          <h2 id="discovered-services-title" className="text-lg font-semibold flex items-center gap-2">
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
          {hasRealHelixEndpoint && (
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