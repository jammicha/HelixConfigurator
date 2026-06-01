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

export const traceStatus = (trace: TraceSummary, slowThresholdMs: number = SLOW_THRESHOLD_MS): TraceStatus => {
  if (trace.has_error) return 'error';
  if (trace.duration_ms > slowThresholdMs) return 'slow';
  return 'ok';
};

// A trace as seen from the currently-selected service's perspective. When a
// service filter is active the Traces table renders each row from that
// service's *entry span* — its operation/duration/status (the svc_* fields the
// backend attaches in listTraces) — instead of the trace root. The Status,
// Min-duration, and Outlier filters MUST classify by these same fields, or the
// filter and the row's pill/badge disagree: e.g. an Error filter would surface
// OK rows because a downstream span failed (has_error=1, trace-wide) while the
// selected service's own span succeeded (svc_status_code=0). This is the single
// source of truth both the page-level filter and the row renderer call.
// With no service filter it collapses to the trace-level (root) verdict, so
// the unfiltered view is byte-for-byte unchanged.
export const serviceTraceView = (
  trace: TraceSummary,
  serviceFilter: string,
  slowThresholdMs: number = SLOW_THRESHOLD_MS,
): { service: string; operation: string; durationMs: number; startNs: number; status: TraceStatus } => {
  const svcView = !!serviceFilter;
  const durationMs = svcView && trace.svc_duration_ms != null ? trace.svc_duration_ms : trace.duration_ms;
  const startNs = svcView && trace.svc_start_ns != null ? trace.svc_start_ns : trace.start_time_ns;
  const operation = (svcView ? (trace.svc_operation ?? trace.root_operation) : trace.root_operation) || '';
  const service = svcView ? serviceFilter : trace.service_name;
  const status: TraceStatus = svcView
    ? ((trace.svc_status_code ?? 0) >= 2 ? 'error' : durationMs > slowThresholdMs ? 'slow' : 'ok')
    : traceStatus(trace, slowThresholdMs);
  return { service, operation, durationMs, startNs, status };
};

// The failing operation to surface as a subline under the Service cell. Only in
// the unfiltered, trace-level view (under a service filter the row already
// renders that service's own entry span), only for error traces, and only when
// it adds information beyond the Root Operation column. Returns null otherwise,
// so the caller renders the subline iff this is non-null. `service` is the
// failing span's service (may differ from the row's root service) for a tooltip.
export const failingOperationView = (
  trace: TraceSummary,
  serviceFilter: string,
): { operation: string; service: string | null } | null => {
  if (serviceFilter) return null;
  if (!trace.has_error) return null;
  const op = trace.failing_operation;
  if (!op) return null;
  if (op === trace.root_operation) return null;
  return { operation: op, service: trace.failing_service ?? null };
};

// The slowest downstream bottleneck operation to surface as a subline under the
// Service cell for slow traces. Only in the unfiltered, trace-level view, only
// for non-failing slow traces, and only when the slowest child operation differs
// from the root operation. Returns null otherwise.
export const bottleneckOperationView = (
  trace: TraceSummary,
  serviceFilter: string,
  slowThresholdMs: number = SLOW_THRESHOLD_MS,
): { operation: string; service: string | null; durationMs: number | null } | null => {
  if (serviceFilter) return null;
  if (trace.has_error) return null;
  if (trace.duration_ms <= slowThresholdMs) return null;
  const op = trace.slowest_child_operation;
  if (!op) return null;
  if (op === trace.root_operation) return null;
  return {
    operation: op,
    service: trace.slowest_child_service ?? null,
    durationMs: trace.slowest_child_duration_ms ?? null
  };
};

// The `service|operation` → p95 map the Outlier filter and row badge look up.
// The source switches with the active view, mirroring serviceTraceView: with a
// service filter the row shows that service's entry-span operation, whose
// baseline lives in the per-service span-latency rollup (/api/operations/
// latencies) — the trace-root rollup has no entry for a participating service
// like cart-api. Unfiltered, the row shows the trace root, judged against the
// trace-root rollup (/api/operations). Keys match serviceTraceView's
// `${service}|${operation}` either way. The span rollup also carries root
// operations (root spans are spans), so the trace-detail drawer's root lookup
// still resolves under an active service filter.
export const buildOperationP95Map = (
  rootOperations: Array<{ service_name: string; root_operation: string; p95_ms: number }>,
  serviceOperations: Array<{ service_name: string; operation: string; p95_ms: number }>,
  serviceFilter: string,
): Map<string, number> => {
  const m = new Map<string, number>();
  if (serviceFilter) {
    for (const o of serviceOperations) m.set(`${o.service_name}|${o.operation}`, o.p95_ms);
  } else {
    for (const o of rootOperations) m.set(`${o.service_name}|${o.root_operation}`, o.p95_ms);
  }
  return m;
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
// TraceTimestamp variable: "YYYY-MM-DD HH:MM:SS.NNNNNNNNN" in UTC. Helix
// matches this string against the stored span time (UTC); formatting in
// browser-local time sent e.g. a US-Central trace 5h off, so the dashboard
// resolved no matching trace. JS numbers preserve millisecond accuracy at
// these magnitudes; the trailing nanoseconds are zero-padded since we don't
// have sub-ms data.
export const formatHelixTimestamp = (timeNs: number | null | undefined): string => {
  if (!timeNs) return '';
  const ms = Math.floor(timeNs / 1e6);
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date} ${time}.${pad(d.getUTCMilliseconds(), 3)}000000`;
};

// Install bundles ship HELIX_ENDPOINT=https://your-tenant.onbmc.com so the
// wizard has something to validate against. A "real" endpoint is anything
// the user has substituted in — anything that isn't the literal placeholder.
export const hasRealHelixEndpoint = (env: HelixEnv | null): boolean => {
  if (!env || !env.endpoint) return false;
  return !/\/\/your-tenant\.onbmc\.com\b/i.test(env.endpoint);
};

// Accept bare key, URL path fragment, or full AIOps URL — extract just the
// opaque business-service key. Mirrors the helper in App.tsx; centralized
// here so otel-data deep-links can reuse it.
export const extractServiceKey = (input: string | undefined | null): string => {
  if (!input) return '';
  const trimmed = input.trim();
  const match = trimmed.match(/\/entities\/service\/([^/?#\s]+)/);
  if (match) return match[1];
  return trimmed.split(/[?#\s]/)[0];
};

// AIOps Business Service entity page. This is the page that hosts the Helix
// Topology view, so it doubles as the "Open in AIOps Topology" target for
// /otel-data's Service Map. Returns null when either the endpoint is still
// the install-bundle placeholder or no business-service key is configured.
export const buildHelixBusinessServiceUrl = (env: HelixEnv | null): string | null => {
  if (!hasRealHelixEndpoint(env)) return null;
  const key = extractServiceKey(env!.businessServiceKey);
  if (!key) return null;
  const base = env!.endpoint.replace(/\/+$/, '');
  return `${base}/aiops/#/entities/service/${encodeURIComponent(key)}?type=key`;
};

export const buildHelixTraceUrl = (
  env: HelixEnv | null,
  { traceId, serviceName, timeNs, namespace }: { traceId: string; serviceName: string; timeNs: number; namespace?: string | null },
): string | null => {
  // hasRealHelixEndpoint check centralizes the placeholder guard: every
  // caller's `if (!url) return null;` becomes the guard automatically,
  // so trace-row chevrons stop rendering a link to `your-tenant.onbmc.com`
  // when the install bundle's default hasn't been replaced yet.
  if (!env || !env.tenantId || !traceId || !hasRealHelixEndpoint(env)) return null;
  // var-OTelNamespace filters on the OTel `service.namespace` resource attr,
  // which is distinct from X_SOURCE (the X-Source ingest header / business
  // service). The collector forwards spans to Helix carrying their original
  // service.namespace, so the dashboard only resolves the trace when this
  // matches the namespace the trace actually landed in. Fall back to
  // env.source only when the caller can't supply the trace's namespace.
  const params = new URLSearchParams({
    orgId: env.tenantId,
    'var-BusinessService': env.source || '',
    'var-OTelNamespace': namespace || env.source || '',
    'var-OTelService': serviceName || '',
    'var-TraceTimestamp': formatHelixTimestamp(timeNs),
    'var-TraceId': traceId.toUpperCase(),
  });
  // URLSearchParams encodes the space in var-TraceTimestamp as "+", which
  // Helix can read literally and then fail to match the stored
  // "YYYY-MM-DD HH:MM:SS" value. Emit %20 instead. A literal "+" in any value
  // is already percent-encoded as %2B, so this only rewrites encoded spaces.
  const qs = params.toString().replace(/\+/g, '%20');
  return `${env.endpoint.replace(/\/+$/, '')}/dashboards/d/OTelTraceDetails/otel-trace-details?${qs}`;
};

// Does a span match the waterfall's free-text "Find in spans" query? Matches
// the span name, its service, and any attribute value (case-insensitive).
// Extracted from the Waterfall component so the highlight pass and the
// match-count badge share one definition — they were silently drifting risks
// otherwise (a query that highlights rows but reports a different count reads
// as a bug). An empty query matches nothing (the search is inactive), mirroring
// the dim/highlight logic that only engages when a query is present.
export const spanMatchesQuery = (span: SpanDetail, query: string): boolean => {
  if (!query) return false;
  const q = query.toLowerCase();
  if (span.name.toLowerCase().includes(q)) return true;
  if (span.serviceName.toLowerCase().includes(q)) return true;
  for (const val of Object.values(span.attributes)) {
    if (val != null && String(val).toLowerCase().includes(q)) return true;
  }
  return false;
};

// How many spans match a "Find in spans" query. Drives the match-count badge
// next to the waterfall search box so an empty result is explicit ("0 matching")
// instead of a silently all-dimmed list.
export const countMatchingSpans = (spans: SpanDetail[], query: string): number => {
  if (!query) return 0;
  let n = 0;
  for (const s of spans) if (spanMatchesQuery(s, query)) n++;
  return n;
};

// Is any cross-tab OTel filter engaged? Backs the single "Clear filters" reset
// in the top bar — the page accumulates service / namespace / container /
// status / min-duration / search / custom-window filters that each had to be
// cleared individually, and several apply to tabs that have no UI of their own
// to clear them. A blank/whitespace search and a zero min-duration count as
// "not filtering", matching how the URL-state serializer omits them.
export const hasActiveOtelFilters = (f: {
  service?: string;
  namespace?: string;
  container?: string;
  status?: string;
  minMs?: number;
  search?: string;
  customRange?: boolean;
}): boolean =>
  !!f.service ||
  !!f.namespace ||
  !!f.container ||
  !!f.status ||
  (f.minMs ?? 0) > 0 ||
  !!(f.search && f.search.trim()) ||
  !!f.customRange;

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
