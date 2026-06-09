// Shared types for the /otel-data page and its sub-tabs.

export type Histogram = {
  bucketStartMs: number;
  bucketEndMs: number;
  bucketSizeMs: number;
  buckets: Array<{
    tsMs: number; total: number;
    ok?: number; slow?: number; error?: number;
    debug?: number; info?: number; warn?: number;
    p50?: number | null; p95?: number | null;
  }>;
};

export type TraceSummary = {
  trace_id: string;
  service_name: string;
  // Root span's service.namespace, denormalized onto the trace by the backend.
  // Drives var-OTelNamespace in the "View in Helix" deep-link. Null when the
  // root span carried no namespace (or for rows predating the column).
  service_namespace?: string | null;
  root_operation: string;
  start_time_ns: number;
  end_time_ns: number;
  duration_ms: number;
  span_count: number;
  has_error: number;
  received_at: number;
  // Rollup counts populated by the trace list query. Optional because SSE-
  // pushed new traces arrive before logs/db-spans have settled — those rows
  // show 0 until the next periodic refresh.
  log_count?: number;
  error_count?: number;
  db_call_count?: number;
  // The originating error span's operation + service (mirrors
  // deriveProbableCause) — the trace's "failing operation". Computed by the
  // trace list query; null for error-free traces. Drives the Service-cell
  // subline in the unfiltered Traces table.
  failing_operation?: string | null;
  failing_service?: string | null;
  // Populated only when the list is filtered by a service: the selected
  // service's entry span within the trace (its top-level operation). Lets the
  // Traces table render each row from that service's perspective, mirroring
  // Helix's per-service trace tables, instead of the trace root.
  svc_operation?: string | null;
  svc_duration_ms?: number | null;
  svc_status_code?: number | null;
  svc_start_ns?: number | null;
  participating_services?: string[];
  slowest_child_operation?: string | null;
  slowest_child_service?: string | null;
  slowest_child_duration_ms?: number | null;
};

export type SpanDetail = {
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
  // Full OTel resource attribute set for the span's service (service.version,
  // telemetry.sdk.*, process.*, host.*, k8s.*, cloud.* …). Optional because
  // rows predating the backend column return it absent; treat missing as {}.
  resourceAttributes?: Record<string, any>;
  events: { name: string; timeUnixNano: number; attributes: Record<string, any> }[];
};

export type TraceDetail = {
  summary: TraceSummary;
  spans: SpanDetail[];
};

export type ErrorRecord = {
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

export type OperationStat = {
  service_name: string;
  root_operation: string;
  trace_count: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  p50_ms: number;
  p95_ms: number;
  error_count: number;
  slow_count: number;
  apdex: number;
  // Per-bucket mean latency (ms) over the active window — a compact trend the
  // Operations tab renders as a sparkline beside the p95 column. Fixed length
  // (SPARK_BUCKETS on the backend); empty buckets are 0. Optional so rows from
  // an older backend that predates the field still render.
  sparkline?: number[];
};

// Per-(service, operation) span-latency percentiles from /api/operations/
// latencies. Unlike OperationStat (grouped by trace root for the Operations
// tab), this is keyed by any participating service's span operation, so it
// supplies the p95 baseline the Outlier filter/badge need when a Service
// filter is active — see buildOperationP95Map.
export type ServiceOperationLatency = {
  service_name: string;
  operation: string;
  p50_ms: number;
  p95_ms: number;
  count: number;
};

export type LogRecord = {
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

export type TimeRange = '5m' | '15m' | '1h' | '6h' | '24h' | 'all';

export type TraceStatus = 'error' | 'slow' | 'ok' | 'outlier';

export type HelixEnv = {
  endpoint: string;
  tenantId: string;
  source: string;
  /** AIOps business-service entity key (or full URL fragment containing one).
   *  Used to build the deep-link target for "Open in AIOps" CTAs. Optional —
   *  links degrade gracefully when not set. */
  businessServiceKey?: string;
};
