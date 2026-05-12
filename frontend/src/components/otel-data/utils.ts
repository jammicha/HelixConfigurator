import type { HelixEnv, SpanDetail, TraceStatus, TraceSummary } from './types';
import { SLOW_THRESHOLD_MS } from './constants';

export const formatDuration = (ms: number) => {
  if (!isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export const formatRelative = (epochMs: number) => {
  const diff = Date.now() - epochMs;
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(epochMs).toLocaleString();
};

export const formatTime = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const traceStatus = (trace: TraceSummary): TraceStatus => {
  if (trace.has_error) return 'error';
  if (trace.duration_ms > SLOW_THRESHOLD_MS) return 'slow';
  return 'ok';
};

// Group equivalent severity strings (Info/INFO/info_2/SeverityNumber=9 etc.)
// into the canonical bucket the dropdown filters on.
export const normalizeSeverity = (s: string): string => {
  const u = (s || '').toUpperCase();
  if (u.includes('FATAL') || u.includes('CRITICAL')) return 'FATAL';
  if (u.includes('ERROR')) return 'ERROR';
  if (u.includes('WARN')) return 'WARN';
  if (u.includes('INFO')) return 'INFO';
  if (u.includes('DEBUG')) return 'DEBUG';
  if (u.includes('TRACE')) return 'TRACE';
  return u || '—';
};

export const severityBadgeClass = (s: string): string => {
  const n = normalizeSeverity(s);
  if (n === 'FATAL' || n === 'ERROR') return 'bg-danger/15 text-[#ff8a8a] border-danger/30';
  if (n === 'WARN') return 'bg-warning/15 text-warning border-warning/30';
  if (n === 'INFO') return 'bg-active/15 text-info border-active/30';
  return 'bg-gray-800 text-gray-300 border-gray-700';
};

// Format a nanosecond Unix timestamp as Helix expects in the dashboard's
// TraceTimestamp variable: "YYYY-MM-DD HH:MM:SS.NNNNNNNNN" in browser-local
// time. JS numbers preserve millisecond accuracy at these magnitudes; the
// trailing nanoseconds are zero-padded since we don't have sub-ms data.
export const formatHelixTimestamp = (timeNs: number | null | undefined): string => {
  if (!timeNs) return '';
  const ms = Math.floor(timeNs / 1e6);
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} ${time}.${pad(d.getMilliseconds(), 3)}000000`;
};

// Install bundles ship HELIX_ENDPOINT=https://your-tenant.onbmc.com so the
// wizard has something to validate against. A "real" endpoint is anything
// the user has substituted in — anything that isn't the literal placeholder.
export const hasRealHelixEndpoint = (env: HelixEnv | null): boolean => {
  if (!env || !env.endpoint) return false;
  return !/\/\/your-tenant\.onbmc\.com\b/i.test(env.endpoint);
};

export const buildHelixLandingUrl = (env: HelixEnv | null): string | null => {
  if (!hasRealHelixEndpoint(env)) return null;
  const base = env!.endpoint.replace(/\/+$/, '');
  return env!.tenantId ? `${base}/?orgId=${encodeURIComponent(env!.tenantId)}` : base;
};

export const buildHelixTraceUrl = (
  env: HelixEnv | null,
  { traceId, serviceName, timeNs }: { traceId: string; serviceName: string; timeNs: number },
): string | null => {
  if (!env || !env.endpoint || !env.tenantId || !traceId) return null;
  const params = new URLSearchParams({
    orgId: env.tenantId,
    'var-BusinessService': env.source || '',
    'var-OTelNamespace': env.source || '',
    'var-OTelService': serviceName || '',
    'var-TraceTimestamp': formatHelixTimestamp(timeNs),
    'var-TraceId': traceId.toUpperCase(),
  });
  return `${env.endpoint.replace(/\/+$/, '')}/dashboards/d/OTelTraceDetails/otel-trace-details?${params.toString()}`;
};

// Detect N+1 pattern: 5+ spans with the same db.operation + db.name.
export const detectNPlusOne = (spans: SpanDetail[]): { operation: string; dbName: string; count: number } | null => {
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
