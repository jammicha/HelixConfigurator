import React, { useState, useEffect, useRef } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { Settings, Loader2, X, Activity, Container, ExternalLink, BarChart2, Unlink, Server, ChevronDown } from 'lucide-react';

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
  const [toast, setToast] = useState<{ show: boolean, message: string, type?: 'success' | 'error' }>({ show: false, message: '' });
  const [logs, setLogs] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState<'helix' | 'all'>('helix');
  const [isRawMetricsOpen, setIsRawMetricsOpen] = useState(false);
  const [rawMetricsText, setRawMetricsText] = useState('');
  const [isLoadingRawMetrics, setIsLoadingRawMetrics] = useState(false);
  const [rawMetricsFilter, setRawMetricsFilter] = useState<'relevant' | 'all'>('relevant');
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [templates, setTemplates] = useState<Array<{id: string, name: string, description: string}>>([]);
  const [loadingTemplateId, setLoadingTemplateId] = useState<string | null>(null);
  const [liveMetrics, setLiveMetrics] = useState({ received: 0, sent: 0, failed: 0 });
  const [metricsHistory, setMetricsHistory] = useState<Array<{ received: number; sent: number; failed: number }>>([]);
  const METRICS_HISTORY_MAX = 60; // 3 minutes at 3s polling
  const [traceInjectionStatus, setTraceInjectionStatus] = useState(''); // success, error, ''
  const [diagAlert, setDiagAlert] = useState(false);

  // Discovered Services State
  const [isServicesOpen, setIsServicesOpen] = useState(false);
  const [discoveredContainers, setDiscoveredContainers] = useState<any[]>([]);
  const [helixConfig, setHelixConfig] = useState({ baseUrl: '', tenantId: '', source: '', businessServiceKey: '' });
  const [loadingContainers, setLoadingContainers] = useState<Set<string>>(new Set());

  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const [isYamlOpen, setIsYamlOpen] = useState(true);

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
  const toastTimerRef = useRef<any>(null);
  const isTogglingDiagRef = useRef(false);

  const [envLoaded, setEnvLoaded] = useState(false);
  const [authStatus, setAuthStatus] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setIsLoggingIn(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword }),
      });
      if (res.ok) {
        setAuthStatus({ required: true, authenticated: true });
        setLoginPassword('');
      } else {
        setLoginError('Invalid password');
      }
    } catch {
      setLoginError('Login request failed');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setAuthStatus({ required: true, authenticated: false });
  };

  useEffect(() => {
    // Tail-style follow: only auto-scroll if the user is already pinned to the bottom.
    // Instant scroll (not smooth) so rapid log arrival doesn't queue up animations.
    if (shouldAutoScrollRef.current && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
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
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (telemetryTimerRef.current) clearTimeout(telemetryTimerRef.current);
    };
  }, []);

  useEffect(() => {
    // Fetch YAML config
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setConfig(data.yaml || ''))
      .catch(err => console.error('Failed to fetch config', err));

    // Fetch Env vars
    fetch('/api/env')
      .then(res => res.json())
      .then(data => {
        setEnvVars(data);
        setEnvLoaded(true);
        if (data.HELIX_ENDPOINT && data.HELIX_API_KEY) {
          setIsSetupComplete(true);
          fetchDiscoveredData(); // Get tokens if already setup
        }
      })
      .catch(err => {
        console.error('Failed to fetch env vars', err);
        setEnvLoaded(true);
      });
  }, []);

  // Poll for Gateway Status
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const checkGateway = () => {
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
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  // Poll for Deep Collector Diagnostics
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const checkCollectorDiag = () => {
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
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
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
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!isSetupComplete) return;

    const controller = new AbortController();
    let cancelled = false;
    const checkStatus = () => {
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
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
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

    const onMsg = (event: any) => {
      setLogs(prev => [...prev.slice(-100), event.data]);
    };

    if (connectedApp) {
      setLogs(prev => [...prev.slice(-100), `Streaming logs for [${connectedApp}]...`]);
      const source = new EventSource(`/api/diagnostics/logs/stream?container=${connectedApp}`);
      source.onmessage = onMsg;
      source.addEventListener('diag-alert', () => setDiagAlert(true));
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
      source.addEventListener('diag-alert', () => setDiagAlert(true));
      eventSourceRef.current = source;
    }
  }, [connectedApp, showDiagnostics]);

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

  const RAW_METRICS_RELEVANT_PREFIXES = [
    'otelcol_receiver_accepted_',
    'otelcol_receiver_refused_',
    'otelcol_processor_',
    'otelcol_exporter_sent_',
    'otelcol_exporter_send_failed_',
    'otelcol_exporter_queue_',
    'otelcol_exporter_enqueue_failed_',
  ];
  const filterRawMetrics = (text: string): string => {
    if (rawMetricsFilter === 'all') return text;
    return text
      .split('\n')
      .filter(line => RAW_METRICS_RELEVANT_PREFIXES.some(p => line.startsWith(p)))
      .join('\n') || '(no relevant metric lines found — try All Metrics)';
  };

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

  // Accept bare key, URL path fragment, or full AIOps URL — extract just the opaque key.
  const extractServiceKey = (input: string): string => {
    if (!input) return '';
    const trimmed = input.trim();
    const match = trimmed.match(/\/entities\/service\/([^/?#\s]+)/);
    if (match) return match[1];
    return trimmed.split(/[?#\s]/)[0];
  };

  const showToastMsg = (message: string, type: 'success' | 'error' = 'success') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ show: true, message, type });
    toastTimerRef.current = setTimeout(() => {
      setToast({ show: false, message: '' });
      toastTimerRef.current = null;
    }, 3000);
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
        // Surface structural warnings as Monaco markers (non-blocking — config is saved)
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
        // Restart after config change to apply
        const restartRes = await fetch('/api/lifecycle/restart', { method: 'POST' });
        if (!restartRes.ok) {
          showToastMsg('Config saved, but gateway restart failed', 'error');
        } else if (warnings.length > 0) {
          showToastMsg(`Config saved with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`, 'error');
        } else {
          showToastMsg('Config Saved');
        }
        await new Promise(r => setTimeout(r, 3000));
        // Refresh all status
        const collectorStatus = await fetch('/api/diagnostics/collector').then(r => r.json());
        setCollectorDiag(collectorStatus);
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
      await new Promise(r => setTimeout(r, 3000));

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
        // Health Buffer: wait 3s before allowing next poll to pick up real log states
        await new Promise(r => setTimeout(r, 3000));
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

      // Wait for sidecar to be reachable before bridging/verifying
      await new Promise(r => setTimeout(r, 3000));

      // Bridge network to target app
      const bridgeRes = await fetch('/api/lifecycle/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ APP_URL: envVars.APP_URL })
      });
      if (!bridgeRes.ok) console.warn('Automated network bridging failed');

      // Verify auth
      const diagRes = await fetch('/api/diagnostics/network');
      const diagData = await diagRes.json();
      if (diagData.status !== 'Success') {
        throw new Error(diagData.error || 'Network diagnostics failed');
      }

      setSetupStep(2);
      fetchDiscoveredData(); // Refresh tokens after setup
    } catch (err: any) {
      setSetupError(err.message || 'Verification failed');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyTelemetry = async () => {
    if (telemetryTimerRef.current) {
      clearTimeout(telemetryTimerRef.current);
      telemetryTimerRef.current = null;
    }
    setTelemetryStatus('loading');
    try {
      const res = await fetch('/api/diagnostics/metrics/live');
      const data = await res.json();
      setTelemetryStatus(data.sent > 0 ? 'success' : 'error');
    } catch (err) {
      setTelemetryStatus('error');
    }
    telemetryTimerRef.current = setTimeout(() => {
      setTelemetryStatus('idle');
      telemetryTimerRef.current = null;
    }, 5000);
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

[Live Metrics]
Received: ${liveMetrics.received}, Sent: ${liveMetrics.sent}, Failed: ${liveMetrics.failed}

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
        setLogs([`Initializing diagnostic session${connectedApp ? ` for ${connectedApp}` : ''} (5-min session)...`]);
        setTraceInjectionStatus('injecting');
        // SSE setup happens in the [connectedApp, showDiagnostics] effect — single stream at a time.

        // Start metrics polling
        setMetricsHistory([]);
        const fetchMetrics = () => {
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

      setShowDiagnostics(false);
      setTraceInjectionStatus('');
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
    return (
      <div className="flex items-center justify-center h-screen w-full bg-gray-900">
        <form
          onSubmit={handleLogin}
          className="bg-gray-1000 border border-gray-800 rounded-lg shadow-4 p-8 w-full max-w-md space-y-5"
        >
          <div className="flex items-center gap-3">
            <img src="/bmc-logo.svg" alt="BMC" className="h-7 w-auto" />
            <h1 className="text-white font-light text-xl">Helix OTel Configurator</h1>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Password</label>
            <input
              type="password"
              autoFocus
              value={loginPassword}
              onChange={(e) => { setLoginPassword(e.target.value); setLoginError(''); }}
              className="w-full bg-gray-900 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm"
              placeholder="Enter shared access password"
            />
          </div>
          {loginError && (
            <div className="flex gap-3 p-3 bg-[#f5bcc6]/20 border border-danger/40 rounded text-sm items-start">
              <span className="text-danger font-bold flex-shrink-0">×</span>
              <span className="text-gray-300">{loginError}</span>
            </div>
          )}
          <button
            type="submit"
            disabled={isLoggingIn || !loginPassword}
            className="w-full bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded font-semibold transition-all flex items-center justify-center gap-2"
          >
            {isLoggingIn && <Loader2 className="w-4 h-4 animate-spin" />}
            {isLoggingIn ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-gray-900 font-sans text-gray-100">
      {/* Toast Notification */}
      {toast.show && (
        <div className={`fixed bottom-6 right-6 z-[100] px-5 py-3 rounded shadow-3 font-semibold text-sm text-white transition-all ${toast.type === 'error' ? 'bg-danger' : 'bg-success'}`}>
          {toast.message}
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto transition-all duration-300">
        {/* Header */}
        <header className="bg-helixNav flex items-center px-4 py-3 font-helix w-full justify-between flex-shrink-0 sticky top-0 z-40 border-b border-[#0f1620]">
          <div className="flex items-center">
            <img src="/bmc-logo.svg" alt="BMC" className="h-8 w-auto" />
            <div className="h-8 w-px bg-helixDivider mx-4"></div>
            <h1 className="text-white font-light text-[1.3125rem] m-0 ml-[15px] tracking-wide">Helix OTel Configurator</h1>
          </div>
          <nav className="flex items-center space-x-5 text-sm text-[#cfd3da]">
            <button
              onClick={() => {
                if (isSetupComplete && !window.confirm('Return to the onboarding wizard? Your saved settings stay intact, but the dashboard will close.')) {
                  return;
                }
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
              }}
              className="hover:text-white transition-colors"
            >
              Onboarding
            </button>
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

              {setupStep === 1 && (
                <div className="adapt-card">
                  <h2 className="text-lg font-bold mb-6 text-gray-200">Step 1: Configure & Initialize Gateway</h2>
                  <div className="grid grid-cols-2 gap-4 mb-6">
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
                      <input
                        type="text"
                        value={envVars.HELIX_API_KEY}
                        onChange={(e) => setEnvVars({ ...envVars, HELIX_API_KEY: e.target.value })}
                        className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm"
                        placeholder="123456789::ABCDE12345::FGHIJ67890..."
                      />
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
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">App URL</label>
                      <input
                        type="text"
                        value={envVars.APP_URL}
                        onChange={(e) => setEnvVars({ ...envVars, APP_URL: e.target.value })}
                        className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm"
                        placeholder="http://localhost:8080"
                      />
                    </div>
                  </div>

                  <details className="mb-6 group">
                    <summary className="text-xs font-semibold text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-300 select-none">
                      Optional: AIOps Business Service Key
                    </summary>
                    <div className="mt-3 space-y-1">
                      <input
                        type="text"
                        value={envVars.BUSINESS_SERVICE_KEY}
                        onChange={(e) => setEnvVars({ ...envVars, BUSINESS_SERVICE_KEY: extractServiceKey(e.target.value) })}
                        className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm"
                        placeholder="e.g. LYVlMZN2grhnvxM4uik8s5PmVpJNidFS — or paste the full AIOps service URL"
                      />
                      <p className="text-tiny text-gray-500 mt-1">
                        Enables the AIOps Business Service deep-link button. You can also add this later from Settings.
                      </p>
                    </div>
                  </details>

                  {setupError && (
                    <div className="mb-4 flex gap-3 p-3 bg-[#f5bcc6]/20 border border-danger/40 rounded text-sm items-start">
                      <span className="text-danger font-bold flex-shrink-0 leading-tight">×</span>
                      <div><span className="text-danger font-semibold">Verification failed:</span> <span className="text-gray-300">{setupError}</span></div>
                    </div>
                  )}

                  <button
                    onClick={handleInitialize}
                    disabled={isVerifying}
                    className="w-full bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-3 rounded font-semibold transition-all"
                  >
                    {isVerifying ? 'Verifying...' : 'Initialize & Verify Connection'}
                  </button>
                </div>
              )}

              {setupStep === 2 && (
                <div className="adapt-card">
                  <h2 className="text-lg font-bold mb-4 text-gray-200">Step 2: Route Your Telemetry</h2>
                  <p className="text-gray-300 mb-4 font-semibold text-primary text-sm">The Configurator has automatically bridged the sidecar to your application's network.</p>
                  <p className="text-gray-300 mb-4 text-sm">Add this exporter to your application config (click to copy):</p>
                  <div
                    className="bg-gray-1000 p-4 rounded border border-gray-800 font-mono text-tiny text-gray-300 mb-6 overflow-x-auto cursor-pointer hover:border-active transition-all group relative" style={{fontFamily: "'Source Code Pro', monospace"}}
                    onClick={() => copyToClipboard(`exporters:
  otlp/helix_sidecar:
    endpoint: "helix-gateway:4317"
    headers:
      X-Api-Key: "${envVars.HELIX_API_KEY}"
      X-Source: "${envVars.X_SOURCE}"
    tls:
      insecure: true`)}
                  >
                    <pre>{`exporters:
  otlp/helix_sidecar:
    endpoint: "helix-gateway:4317"
    headers:
      X-Api-Key: "${envVars.HELIX_API_KEY}"
      X-Source: "${envVars.X_SOURCE}"
    tls:
      insecure: true`}</pre>
                  </div>
                  <p className="text-gray-300 mb-4 text-sm">Next, add the exporter to your service pipelines:</p>
                  <div
                    className="bg-gray-1000 p-4 rounded border border-gray-800 font-mono text-tiny text-gray-300 mb-6 overflow-x-auto cursor-pointer hover:border-active transition-all group relative" style={{fontFamily: "'Source Code Pro', monospace"}}
                    onClick={() => copyToClipboard(`service:
  pipelines:
    traces:
      exporters: [..., otlp/helix_sidecar]
    metrics:
      exporters: [..., otlp/helix_sidecar]
    logs:
      exporters: [..., otlp/helix_sidecar]`)}
                  >
                    <pre>{`service:
  pipelines:
    traces:
      exporters: [..., otlp/helix_sidecar]
    metrics:
      exporters: [..., otlp/helix_sidecar]
    logs:
      exporters: [..., otlp/helix_sidecar]`}</pre>
                  </div>
                  <div className="flex gap-4">
                    <button
                      onClick={() => setSetupStep(1)}
                      className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleVerifyTelemetry}
                      disabled={telemetryStatus === 'loading'}
                      className="flex-1 bg-warning hover:bg-[#d9ae00] text-gray-900 px-6 py-3 rounded font-semibold transition-all disabled:opacity-60 disabled:cursor-not-allowed text-sm"
                    >
                      {telemetryStatus === 'loading' ? 'Verifying Flow...' : 'Verify Telemetry Flow'}
                    </button>
                    <button
                      onClick={() => setIsSetupComplete(true)}
                      className="flex-1 bg-success hover:bg-[#006640] text-white px-6 py-3 rounded font-semibold transition-all text-sm"
                    >
                      Launch Dashboard
                    </button>
                  </div>
                  {telemetryStatus === 'success' && (
                    <div className="mt-4 flex gap-3 p-3 bg-[#bcf5e1]/20 border border-success/40 rounded text-sm items-start">
                      <span className="text-success font-bold flex-shrink-0">✓</span>
                      <div><span className="text-[#0e6d4b] font-semibold">Telemetry confirmed.</span> <span className="text-gray-300">Data is flowing to BMC Helix.</span></div>
                    </div>
                  )}
                  {telemetryStatus === 'error' && (
                    <div className="mt-4 flex gap-3 p-3 bg-[#f5ebbc]/20 border border-warning/40 rounded text-sm items-start">
                      <span className="text-warning font-bold flex-shrink-0">!</span>
                      <div><span className="text-[#826900] font-semibold">No data received yet.</span> <span className="text-gray-300">Ensure your app is running and the exporter is configured.</span></div>
                    </div>
                  )}
                  <div className="mt-6 pt-4 border-t border-gray-800 text-tiny text-gray-500 leading-relaxed">
                    <span className="font-semibold text-gray-400 uppercase tracking-wider">After launch:</span>
                    <ul className="mt-2 space-y-1 list-disc list-inside">
                      <li>Run a <span className="text-gray-300">Diagnostic Health Check</span> to validate config, API key, and tenant reachability.</li>
                      <li>Use <span className="text-gray-300">Load Template</span> in the YAML editor to switch to a tail-sampling, Prometheus, or Kubernetes-attribute starter.</li>
                      <li>Add an <span className="text-gray-300">AIOps Business Service Key</span> from Settings to enable the deep-link button (skip this step earlier? add it any time).</li>
                    </ul>
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
                    <div className={`w-3 h-3 rounded-full ${getStatusColor()} ${gatewayStatus === 'running' ? 'animate-pulse' : ''}`}></div>
                    <h2 className="text-lg font-bold text-gray-200">Helix Gateway Status</h2>
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
                    <a
                      href={(envVars as any).APP_URL || 'http://localhost:8080'}
                      target="_blank"
                      rel="noreferrer"
                      className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 py-2 rounded font-medium transition-colors text-center block w-full text-sm"
                    >
                      Application UI
                    </a>
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
                        <input
                          type="text"
                          value={envVars.HELIX_API_KEY}
                          onChange={(e) => setEnvVars({ ...envVars, HELIX_API_KEY: e.target.value })}
                          className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-active focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm"
                          placeholder="123456789::ABCDE12345::FGHIJ67890..."
                        />
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
                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">App URL</label>
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
                                <p className="font-bold text-danger mb-1 uppercase tracking-tighter">Remediation Step:</p>
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
                        {diagAlert && (
                          <span className="flex items-center gap-2 bg-[#f5bcc6]/20 border border-danger/40 text-danger px-3 py-1 rounded text-tiny font-semibold uppercase tracking-wide">
                            <span className="font-bold">!</span> Telemetry drop detected — check network or queue limits
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
                              <div className="bg-gray-800 border-l-2 border-danger px-3 py-1.5 rounded-r min-w-[88px]">
                                <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Dropped</div>
                                <div className="text-lg font-bold text-danger leading-tight">{liveMetrics.failed}</div>
                                {renderSpark(ratesFor('failed'), '#b2001e')}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </div>
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

      {/* Templates Modal */}
      {isTemplatesOpen && (
        <div
          className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
          onClick={() => setIsTemplatesOpen(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-2xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold text-gray-200">Configuration Templates</h2>
                <p className="text-tiny text-gray-500">Loading a template replaces the editor contents — click Save Config after to apply.</p>
              </div>
              <button onClick={() => setIsTemplatesOpen(false)} className="text-gray-400 hover:text-white p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {templates.length === 0 ? (
                <div className="flex items-center gap-2 text-gray-500 p-4">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading templates...
                </div>
              ) : templates.map(t => (
                <div key={t.id} className="bg-gray-1000 border border-gray-800 hover:border-active p-4 rounded transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-gray-200 text-sm">{t.name}</h3>
                      <p className="text-xs text-gray-400 mt-1">{t.description}</p>
                    </div>
                    <button
                      onClick={() => handleApplyTemplate(t.id)}
                      disabled={loadingTemplateId !== null}
                      className="bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-tiny font-semibold uppercase tracking-wider transition-colors flex items-center gap-2 flex-shrink-0"
                    >
                      {loadingTemplateId === t.id && <Loader2 className="w-3 h-3 animate-spin" />}
                      Use Template
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Raw Metrics Modal */}
      {isRawMetricsOpen && (
        <div
          className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
          onClick={() => setIsRawMetricsOpen(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-4xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold text-gray-200">Raw Collector Metrics</h2>
                <p className="text-tiny text-gray-500">Direct output from <span className="font-mono">helix-gateway:8888/metrics</span></p>
              </div>
              <button onClick={() => setIsRawMetricsOpen(false)} className="text-gray-400 hover:text-white p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-800 flex-shrink-0">
              <span className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Filter:</span>
              <button
                onClick={() => setRawMetricsFilter('relevant')}
                className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${rawMetricsFilter === 'relevant' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                Relevant Only
              </button>
              <button
                onClick={() => setRawMetricsFilter('all')}
                className={`px-2 py-0.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${rawMetricsFilter === 'all' ? 'bg-primary text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                All Metrics
              </button>
              <div className="ml-auto flex gap-2">
                <button
                  onClick={handleOpenRawMetrics}
                  disabled={isLoadingRawMetrics}
                  className="text-info text-tiny font-semibold uppercase tracking-wider hover:underline disabled:opacity-50"
                >
                  {isLoadingRawMetrics ? 'Refreshing...' : 'Refresh'}
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(filterRawMetrics(rawMetricsText));
                    showToastMsg('Metrics copied to clipboard');
                  }}
                  disabled={!rawMetricsText || isLoadingRawMetrics}
                  className="text-info text-tiny font-semibold uppercase tracking-wider hover:underline disabled:opacity-50"
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-gray-1000 font-mono text-tiny text-gray-300 whitespace-pre" style={{fontFamily: "'Source Code Pro', monospace"}}>
              {isLoadingRawMetrics ? (
                <div className="flex items-center gap-2 text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading metrics...
                </div>
              ) : (
                filterRawMetrics(rawMetricsText) || '(empty response)'
              )}
            </div>
          </div>
        </div>
      )}

      {/* Discovered Services Pinned Sidebar Panel */}
      <div className={`relative w-[450px] h-full flex-shrink-0 bg-gray-1000 border-l border-gray-700 shadow-4 flex flex-col transition-all duration-300 ease-in-out ${isServicesOpen ? 'translate-x-0' : 'hidden'}`}>
        <div className="bg-gray-900 px-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0 h-[52px]">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Discovered Services
          </h2>
          <button onClick={() => setIsServicesOpen(false)} className="text-gray-400 hover:text-white p-1">
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
              {discoveredContainers
                .filter(c => !c.name.includes('helix-gateway'))
                .map(container => renderContainerCard(container, false))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default App;