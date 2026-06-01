// Pure formatter for the diagnostic "support bundle" the user copies to share
// with support. Kept out of App.tsx so the redaction and rate-delta logic can
// be unit-tested directly. The caller is responsible for fetching gateway
// status + recent logs and for writing the result to the clipboard.

type DiagState = { status: string; error?: string };
type MetricsSample = { received: number; sent: number; failed: number };
type TimelineEntry = { ts: number; kind: string; message: string };

export type SupportBundleInput = {
  envVars: {
    HELIX_ENDPOINT: string;
    HELIX_API_KEY: string;
    X_SOURCE: string;
    BUSINESS_SERVICE_KEY: string;
  };
  gatewayStatus: string;
  collectorDiag: DiagState;
  apiKeyDiag: DiagState;
  networkDiag: DiagState;
  liveMetrics: MetricsSample;
  metricsHistory: MetricsSample[];
  timeline: TimelineEntry[];
  recentLogs: string;
};

// Redact the secret segments of a TenantID::AccessKey::SecretKey API key,
// keeping only the tenant id for correlation.
const redactKey = (key: string): string => {
  if (!key) return '(unset)';
  const parts = key.split('::');
  if (parts.length === 3) return `${parts[0]}::***::***`;
  return '***';
};

// Compact rate timeline from cumulative counters -> per-sample deltas. Useful
// when an issue self-resolves before the user copies the bundle — the current
// snapshot alone would otherwise look fine.
const renderRateHistory = (history: MetricsSample[]): string => {
  if (history.length < 2) return '(no rate history available)';
  const lines: string[] = ['  sample  recv/Δ  sent/Δ  fail/Δ'];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const cur = history[i];
    const dRecv = Math.max(0, cur.received - prev.received);
    const dSent = Math.max(0, cur.sent - prev.sent);
    const dFail = Math.max(0, cur.failed - prev.failed);
    lines.push(`  ${String(i).padStart(6)}  ${String(dRecv).padStart(6)}  ${String(dSent).padStart(6)}  ${String(dFail).padStart(6)}`);
  }
  return lines.join('\n');
};

const renderTimeline = (timeline: TimelineEntry[]): string => {
  if (timeline.length === 0) return '(no events recorded this session)';
  return timeline.map(ev => `  ${new Date(ev.ts).toISOString()}  [${ev.kind}] ${ev.message}`).join('\n');
};

export const buildSupportBundle = (d: SupportBundleInput): string =>
`=== Helix Configurator Support Bundle ===
Generated: ${new Date().toISOString()}

[Environment]
HELIX_ENDPOINT: ${d.envVars.HELIX_ENDPOINT || '(unset)'}
HELIX_API_KEY: ${redactKey(d.envVars.HELIX_API_KEY)}
X_SOURCE: ${d.envVars.X_SOURCE || '(unset)'}
BUSINESS_SERVICE_KEY: ${d.envVars.BUSINESS_SERVICE_KEY ? '(set)' : '(unset)'}

[Gateway Status]
Container: ${d.gatewayStatus || 'unknown'}

[Diagnostic Checks]
Collector Configuration: ${d.collectorDiag.status}${d.collectorDiag.error ? ' - ' + d.collectorDiag.error : ''}
X-API Key Format: ${d.apiKeyDiag.status}${d.apiKeyDiag.error ? ' - ' + d.apiKeyDiag.error : ''}
X-Source Format: ${d.envVars.X_SOURCE ? 'PASS' : 'FAIL'}
Tenant URL Endpoint: ${d.networkDiag.status}${d.networkDiag.error ? ' - ' + d.networkDiag.error : ''}

[Live Metrics - current]
Received: ${d.liveMetrics.received}, Sent: ${d.liveMetrics.sent}, Failed: ${d.liveMetrics.failed}

[Rate History - last ${d.metricsHistory.length} samples (~3s each)]
${renderRateHistory(d.metricsHistory)}

[Session Timeline]
${renderTimeline(d.timeline)}

[Last Gateway Log Lines]
${d.recentLogs || '(no logs available)'}
`;
