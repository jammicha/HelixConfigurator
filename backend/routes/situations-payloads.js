// Pure builders for the OTel->AIOps event/policy payloads. No network, no
// process.env reads -- all inputs are passed in so this module is unit-tested
// in isolation. situations.js wires these to the Events API.

const OTEL_TRACE_ANOMALY_CLASS = 'OTEL_TRACE_ANOMALY';
const CORRELATION_POLICY_NAME = 'HelixConfigurator-OTel-Trace-Anomaly';

function buildClassDefinition() {
  return {
    name: OTEL_TRACE_ANOMALY_CLASS,
    parentClassName: 'EVENT',
    attributes: [
      { name: 'helix_trace_id', dataType: 'STRING', enum: false, allFacet: [
        { name: 'dup_detect', value: 'true' },
        { name: 'mandatory', value: 'true' },
      ] },
      { name: 'service_name', dataType: 'STRING', enum: false },
      { name: 'service_namespace', dataType: 'STRING', enum: false },
      { name: 'root_operation', dataType: 'STRING', enum: false },
      { name: 'duration_ms', dataType: 'STRING', enum: false },
      { name: 'p95_ms', dataType: 'STRING', enum: false },
      { name: 'span_count', dataType: 'STRING', enum: false },
      { name: 'has_error', dataType: 'STRING', enum: false },
      { name: 'service_id', dataType: 'STRING', enum: false },
      { name: 'business_service_key', dataType: 'STRING', enum: false },
      { name: 'x_source', dataType: 'STRING', enum: false },
      { name: 'probable_cause_service', dataType: 'STRING', enum: false },
      { name: 'probable_cause_operation', dataType: 'STRING', enum: false },
      { name: 'error_type', dataType: 'STRING', enum: false },
      { name: 'error_message', dataType: 'STRING', enum: false },
      { name: 'code_location', dataType: 'STRING', enum: false },
      { name: 'anomaly_factor', dataType: 'STRING', enum: false },
      { name: 'affected_services', dataType: 'STRING', enum: false },
      { name: 'component_count', dataType: 'STRING', enum: false },
      { name: 'trace_url', dataType: 'STRING', enum: false },
      { name: 'probable_cause_span_id', dataType: 'STRING', enum: false },
      { name: 'hot_path', dataType: 'STRING', enum: false },
      { name: 'span_dashboard_url', dataType: 'STRING', enum: false },
      // NOTE: do NOT declare `priority` here. It's a built-in PRIORITY_1..5 enum
      // slot inherited from the EVENT parent class; re-declaring it as a custom
      // STRING fails the create with ATTR_EXIST_WITH_DIFF_TYPE (500), which aborts
      // the whole class creation. Events/policies can still SET priority (it's
      // inherited). See BUILTIN_CLASS_ATTRS below — kept as defense-in-depth.
    ],
  };
}

// Body for the slot-adding PUT on an existing class. Two live-validated rules:
//   • Drop `name`/`parentClassName` — the update endpoint addresses the class by id
//     in the URL and rejects them via additionalProperties ("properties which are
//     not allowed: [name, parentClassName]").
//   • Drop built-in EVENT attributes. `priority` is the PRIORITY_1..5 enum inherited
//     from EVENT, not a custom STRING slot; re-declaring it fails
//     ATTR_EXIST_WITH_DIFF_TYPE, and that one bad attribute aborts the entire
//     slot-add. We only need our own custom slots registered.
const BUILTIN_CLASS_ATTRS = new Set(['priority']);
function buildClassUpdateBody() {
  const { name, parentClassName, attributes, ...rest } = buildClassDefinition();
  return { ...rest, attributes: attributes.filter((a) => !BUILTIN_CLASS_ATTRS.has(a.name)) };
}

const ADDED_SLOTS = ['service_name', 'service_namespace'];

// HELIX_API_KEY is `TenantID::AccessKey::SecretKey`. The events-service REST API
// rejects this key directly; its access/secret halves are exchanged for a JWT at
// the IMS login endpoint. Split into the parts that login needs; null if malformed.
function splitApiKey(apiKey) {
  const parts = String(apiKey || '').split('::');
  if (parts.length !== 3 || parts.some(p => !p.trim())) return null;
  return { tenantId: parts[0].trim(), accessKey: parts[1].trim(), accessSecretKey: parts[2].trim() };
}

// source_hostname is how BMC reconciles an event to a CI (topology enrichment looks
// it up in BMC Discovery, matching the CI's Name). DEFAULT = the bare service.name —
// the ONLY form that actually binds: on a single-app tenant it matches the OTel
// Service CI by Name and the Situation gets its Impacted Service.
//
// Namespace-qualifying via HELIX_EVENT_CI_FORMAT ({namespace}.{service}) is available
// for SHARED tenants where the bare name collides across apps (e.g. two "frontend"
// OTel Services) and would bind to the wrong one. CAVEAT (validated live, 2026-06-17):
// a qualified hostname does NOT bind to the right CI either — Discovery matches only
// the bare Name, so qualified forms and even the External Identifier
// (OTel_Service_<ns>.<svc>) reconcile to nothing (Impacted Service = N/A). So the
// override only trades "wrong service" for "no service". Genuinely tying OTel-trace
// events to OTel service CIs is BMC ML/topology + tenant CMDB modeling, not this
// payload. See memory: situations-event-service-binding.
function buildEventCiHostname(serviceName, serviceNamespace) {
  const name = (serviceName || '').trim();
  const ns = (serviceNamespace || '').trim();
  if (!ns) return name;
  const fmt = process.env.HELIX_EVENT_CI_FORMAT || '{service}';
  return fmt.replace('{service}', name).replace('{namespace}', ns).toLowerCase();
}

function buildAnomalyEventPayload({ summary, p95Ms, businessServiceKey, xSource, spans, baseUrl, tenantId, spanDashboardUid, multiEvent }) {
  const hasError = !!summary.has_error;
  const isOutlier = typeof p95Ms === 'number' && p95Ms > 0 && summary.duration_ms > p95Ms * 2;
  const severity = hasError ? 'CRITICAL' : isOutlier ? 'MAJOR' : 'MINOR';
  const flavor = hasError ? 'errored' : isOutlier ? `outlier (>2× p95 ${Math.round(p95Ms)}ms)` : 'manual send';

  // Enrichment is opt-in: only when the caller supplies the trace's spans. With
  // no spans, every value below is null/'' and the output collapses to exactly
  // the original event shape (the legacy tests pin this).
  const hasSpans = Array.isArray(spans) && spans.length > 0;
  const cause = hasSpans ? deriveProbableCause(spans) : null;
  const blast = hasSpans ? blastRadius(spans) : null;
  const factor = hasSpans ? anomalyFactor(summary.duration_ms, p95Ms) : null;
  const priority = hasSpans
    ? priorityForTrace({ hasError, anomalyFactor: factor, blastCount: blast.component_count })
    : null;
  const traceUrl = hasSpans
    ? buildHelixTraceUrlFromSummary({ baseUrl, tenantId, source: (xSource || '').trim(), summary })
    : '';
  const hotPath = (hasSpans && cause) ? buildHotPath(spans, cause.probable_cause_span_id) : '';
  const spanDashboardUrl = hasSpans
    ? buildSpanDashboardUrl({ baseUrl, tenantId, summary, spanId: cause.probable_cause_span_id, dashboardUid: (spanDashboardUid || '').trim() })
    : '';

  // Name the cause whenever an originating error span was found — including a
  // status-only error with no exception type (the common OTel-demo case: span
  // sets ERROR status but emits no `exception` event). Lead with error_type,
  // else the error message, else a bare "error". Show the p95 factor only when
  // the trace is actually slower than baseline; "0.4× p95" on an errored-but-
  // fast trace is noise.
  const causeName = (hasSpans && cause && cause.probable_cause_operation)
    ? `${cause.probable_cause_service}/${cause.probable_cause_operation}`
    : '';
  const causeLabel = cause ? (cause.error_type || cause.error_message || 'error') : 'error';
  const msg = causeName
    ? `OTel anomaly: ${causeName} — ${causeLabel}`
      + (factor && factor >= 1 ? ` (${factor}× p95)` : '')
      + (blast.component_count > 1 ? `, ${blast.component_count} services affected` : '')
    : `OTel trace ${flavor}: ${summary.service_name}/${summary.root_operation} took ${Math.round(summary.duration_ms)}ms`;

  const detailLines = [
    `Trace ${summary.trace_id} on service ${summary.service_name}.`,
    `Root operation: ${summary.root_operation}. Duration: ${Math.round(summary.duration_ms)}ms across ${summary.span_count} span(s).`,
    hasError ? 'Trace contains at least one error span.' : '',
    isOutlier ? `Operation p95 in window: ${Math.round(p95Ms)}ms.` : '',
  ];
  if (hasSpans && cause && (cause.error_type || cause.error_message)) {
    detailLines.push(
      `Probable cause: ${cause.error_type || 'error'} in ${cause.probable_cause_service}/${cause.probable_cause_operation}`
      + `${cause.error_message ? ` — ${cause.error_message}` : ''}.`);
    if (cause.code_location) detailLines.push(`Code: ${cause.code_location}.`);
  }
  if (hasSpans && blast && blast.affected_services) detailLines.push(`Affected services: ${blast.affected_services}.`);
  if (hasSpans && traceUrl) detailLines.push(`Open trace: ${traceUrl}`);
  if (hasSpans && hotPath) detailLines.push(`Path to failure: ${hotPath}.`);
  if (hasSpans && spanDashboardUrl) detailLines.push(`Open the failing span: ${spanDashboardUrl}`);
  const details = detailLines.filter(Boolean).join('\n');

  const enrichedSlots = {};
  if (hasSpans) {
    if (cause.probable_cause_service) enrichedSlots.probable_cause_service = cause.probable_cause_service;
    if (cause.probable_cause_operation) enrichedSlots.probable_cause_operation = cause.probable_cause_operation;
    if (cause.error_type) enrichedSlots.error_type = cause.error_type;
    if (cause.error_message) enrichedSlots.error_message = cause.error_message;
    if (cause.code_location) enrichedSlots.code_location = cause.code_location;
    if (factor != null) enrichedSlots.anomaly_factor = String(factor);
    if (blast.affected_services) enrichedSlots.affected_services = blast.affected_services;
    if (blast.component_count) enrichedSlots.component_count = String(blast.component_count);
    if (traceUrl) enrichedSlots.trace_url = traceUrl;
    if (priority) enrichedSlots.priority = priority;
    if (cause.probable_cause_span_id) enrichedSlots.probable_cause_span_id = cause.probable_cause_span_id;
    if (hotPath) enrichedSlots.hot_path = hotPath;
    if (spanDashboardUrl) enrichedSlots.span_dashboard_url = spanDashboardUrl;
  }

  // Slots common to every event for this trace (independent of which service the
  // event is pinned to). service_name/namespace + helix_trace_id are layered on per
  // event below.
  const baseSlots = {
    root_operation: summary.root_operation,
    duration_ms: String(Math.round(summary.duration_ms)),
    span_count: String(summary.span_count),
    has_error: hasError ? '1' : '0',
    ...(isOutlier ? { p95_ms: String(Math.round(p95Ms)) } : {}),
    ...(businessServiceKey ? { service_id: businessServiceKey, business_service_key: businessServiceKey } : {}),
    x_source: (xSource || '').trim(),
    ...enrichedSlots,
  };

  const primaryEvent = {
    class: OTEL_TRACE_ANOMALY_CLASS,
    severity,
    ...(priority ? { priority } : {}),
    status: 'OPEN',
    category: 'APPLICATION',
    msg,
    source_identifier: `helix-otel-trace:${summary.trace_id}`,
    source_attributes: { source_hostname: buildEventCiHostname(summary.service_name, summary.service_namespace) },
    details,
    class_slots: {
      helix_trace_id: summary.trace_id,
      service_name: summary.service_name || '',
      service_namespace: summary.service_namespace || '',
      ...baseSlots,
    },
  };

  // Default: ONE event per trace (correlated by our policy on service_name +
  // service_namespace). Opt-in multi-event mode emits one event per service on the
  // failure path — each pinned to its own service — so BMC's ML correlation has
  // >=2 topologically-related events and can build an ML Situation with a causal /
  // root-cause view (a single event never forms an ML Situation; it needs >=2).
  // NOTE: these events span multiple service_names, so our single-service
  // correlation policy will NOT group them — the point is to let BMC's ML correlate.
  // It also only helps where the per-service hosts bind to CIs (see memory:
  // situations-event-service-binding). Errored traces only (need a failure path).
  const pathServices = hasSpans && cause ? hotPathServices(spans, cause.probable_cause_span_id) : [];
  if (!multiEvent || pathServices.length < 2) return [primaryEvent];

  // Cause event first so callers that read payload[0] (e.g. the route's response
  // severity) get the primary event; consequence events follow in path order.
  const causeSvc = cause.probable_cause_service;
  const ordered = [causeSvc, ...pathServices.filter((s) => s !== causeSvc)];
  return ordered.map((svc) => {
    const isCause = svc === causeSvc;
    return {
      class: OTEL_TRACE_ANOMALY_CLASS,
      severity: isCause ? severity : downgradeSeverity(severity),
      ...(priority ? { priority } : {}),
      status: 'OPEN',
      category: 'APPLICATION',
      msg: isCause
        ? msg
        : `OTel trace ${summary.trace_id}: ${svc} on the failure path to ${causeName || causeSvc}${causeLabel ? ` — ${causeLabel}` : ''}`,
      // Distinct per (trace, service) so the events don't dedup into one.
      source_identifier: `helix-otel-trace:${summary.trace_id}:${svc}`,
      source_attributes: { source_hostname: buildEventCiHostname(svc, summary.service_namespace) },
      details,
      class_slots: {
        helix_trace_id: `${summary.trace_id}::${svc}`,
        service_name: svc,
        service_namespace: summary.service_namespace || '',
        ...baseSlots,
      },
    };
  });
}

// Identify the originating error span in a trace and extract a human-readable
// cause. Spans are the shape otelStore.getTrace() returns (.events/.attributes
// already parsed). Error span = ERROR status (code 2) OR carries an `exception`
// event. The originating span is the most downstream (latest start); a span with
// an actual exception event wins over one that only reports error status.
function deriveProbableCause(spans) {
  const empty = {
    probable_cause_span_id: '',
    probable_cause_service: '', probable_cause_operation: '',
    error_type: '', error_message: '', code_location: '',
  };
  if (!Array.isArray(spans) || spans.length === 0) return empty;

  const hasExc = (s) => Array.isArray(s.events) && s.events.some(e => e && e.name === 'exception');
  const errorSpans = spans.filter(s => s && (s.statusCode === 2 || hasExc(s)));
  if (errorSpans.length === 0) return empty;

  const pool = errorSpans.some(hasExc) ? errorSpans.filter(hasExc) : errorSpans;
  const origin = pool.reduce((a, b) => ((b.startTimeNs || 0) >= (a.startTimeNs || 0) ? b : a));

  const exc = (Array.isArray(origin.events) ? origin.events : []).find(e => e && e.name === 'exception');
  const excAttrs = (exc && exc.attributes) || {};
  const attrs = origin.attributes || {};

  const errorType = exc ? (excAttrs['exception.type'] || '') : '';
  const rawMsg = exc ? (excAttrs['exception.message'] || '') : (origin.statusMessage || '');
  const errorMessage = String(rawMsg).slice(0, 200);

  let codeLocation = '';
  if (attrs['code.filepath']) {
    codeLocation = [attrs['code.filepath'], attrs['code.function'], attrs['code.lineno']]
      .filter(v => v !== undefined && v !== null && v !== '')
      .join(':');
  }

  return {
    probable_cause_span_id: origin.spanId || '',
    probable_cause_service: origin.serviceName || '',
    probable_cause_operation: origin.name || '',
    error_type: errorType,
    error_message: errorMessage,
    code_location: codeLocation,
  };
}

// Distinct services participating in the trace — the Situation's blast radius.
// Names are capped so the slot/message stays readable; the full count is always
// reported separately.
function blastRadius(spans) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return { affected_services: '', component_count: 0 };
  }
  const distinct = [];
  for (const s of spans) {
    const n = s && s.serviceName;
    if (n && !distinct.includes(n)) distinct.push(n);
  }
  const CAP = 5;
  const shown = distinct.slice(0, CAP);
  const affected = distinct.length > CAP
    ? `${shown.join(',')} +${distinct.length - CAP} more`
    : shown.join(',');
  return { affected_services: affected, component_count: distinct.length };
}

// Ancestor chain from the originating error span up to the root, in call order
// (root → … → error span) as "service/operation" per hop, the failure marked
// with ✗. Deterministic; '' when the span isn't in the trace.
function buildHotPath(spans, originSpanId) {
  if (!Array.isArray(spans) || !originSpanId) return '';
  const byId = new Map(spans.map(s => [s.spanId, s]));
  const chain = [];
  const seen = new Set();
  let cur = byId.get(originSpanId);
  while (cur && !seen.has(cur.spanId)) {
    seen.add(cur.spanId);
    chain.push(cur);
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : null;
  }
  if (chain.length === 0) return '';
  chain.reverse();
  return chain
    .map((s, i) => `${s.serviceName || '?'}/${s.name || '?'}` + (i === chain.length - 1 ? ' ✗' : ''))
    .join(' → ');
}

// Ordered, distinct services along the failure path (root → … → originating error
// span) — same ancestor walk as buildHotPath, but returning the services. Used by
// multi-event mode to emit one event per service on the path. [] when not found.
function hotPathServices(spans, originSpanId) {
  if (!Array.isArray(spans) || !originSpanId) return [];
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const chain = [];
  const seen = new Set();
  let cur = byId.get(originSpanId);
  while (cur && !seen.has(cur.spanId)) {
    seen.add(cur.spanId);
    chain.push(cur);
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : null;
  }
  chain.reverse();
  const out = [];
  for (const s of chain) {
    if (s.serviceName && !out.includes(s.serviceName)) out.push(s.serviceName);
  }
  return out;
}

// Drop one BMC severity tier so consequence events rank below the cause event in
// multi-event mode. Unknown values pass through unchanged.
const SEVERITY_LADDER = ['CRITICAL', 'MAJOR', 'MINOR', 'INFO', 'OK'];
function downgradeSeverity(sev) {
  const i = SEVERITY_LADDER.indexOf(sev);
  return i >= 0 && i < SEVERITY_LADDER.length - 1 ? SEVERITY_LADDER[i + 1] : sev;
}

// Duration as a multiple of the operation's p95 baseline (1 decimal); null when
// no baseline is available (manual/baseline sends).
function anomalyFactor(durationMs, p95Ms) {
  if (typeof p95Ms !== 'number' || !(p95Ms > 0)) return null;
  return Math.round((durationMs / p95Ms) * 10) / 10;
}

// Map an anomaly onto a PRIORITY tier so Situations are triage-able instead of
// uniformly CRITICAL. Errors outrank latency; a big outlier or a wide blast
// radius escalates an error to the top tier.
function priorityForTrace({ hasError, anomalyFactor: factor, blastCount }) {
  const f = typeof factor === 'number' ? factor : 0;
  const b = typeof blastCount === 'number' ? blastCount : 0;
  if (hasError && (f >= 4 || b >= 3)) return 'PRIORITY_1';
  if (hasError) return 'PRIORITY_2';
  if (f >= 4) return 'PRIORITY_3';
  if (f >= 2) return 'PRIORITY_4';
  return 'PRIORITY_5';
}

// Port of frontend buildHelixTraceUrl/formatHelixTimestamp
// (frontend/src/components/otel-data/utils.ts) so a backend-emitted event links
// to the exact same OTel trace waterfall the UI's "Open in Helix" uses. Keep in
// sync with that file. Returns '' (not null — slots are strings) when the link
// can't be built or the endpoint is still the install-bundle placeholder.
function formatHelixTimestamp(timeNs) {
  if (!timeNs) return '';
  const d = new Date(Math.floor(timeNs / 1e6));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date} ${time}.${pad(d.getUTCMilliseconds(), 3)}000000`;
}

function buildHelixTraceUrlFromSummary({ baseUrl, tenantId, source, summary }) {
  if (!baseUrl || !tenantId || !summary || !summary.trace_id) return '';
  if (/\/\/your-tenant\.onbmc\.com\b/i.test(baseUrl)) return '';
  const params = new URLSearchParams({
    orgId: tenantId,
    'var-BusinessService': source || '',
    'var-OTelNamespace': summary.service_namespace || source || '',
    'var-OTelService': summary.service_name || '',
    'var-TraceTimestamp': formatHelixTimestamp(summary.start_time_ns),
    'var-TraceId': String(summary.trace_id).toUpperCase(),
  });
  const qs = params.toString().replace(/\+/g, '%20');
  return `${String(baseUrl).replace(/\/+$/, '')}/dashboards/d/OTelTraceDetails/otel-trace-details?${qs}`;
}

// Deep-link to the custom "OTel Problem Span" dashboard whose single Text panel
// iframes the configurator's waterfall scrolled to the failing span. Mirrors
// buildHelixTraceUrlFromSummary but targets a configured dashboard UID and adds
// var-SpanId. '' when uid/spanId missing or the endpoint is still the placeholder.
function buildSpanDashboardUrl({ baseUrl, tenantId, summary, spanId, dashboardUid }) {
  if (!baseUrl || !tenantId || !dashboardUid || !spanId || !summary || !summary.trace_id) return '';
  if (/\/\/your-tenant\.onbmc\.com\b/i.test(baseUrl)) return '';
  const params = new URLSearchParams({
    orgId: tenantId,
    'var-TraceId': String(summary.trace_id).toUpperCase(),
    'var-SpanId': String(spanId),
  });
  const qs = params.toString().replace(/\+/g, '%20');
  return `${String(baseUrl).replace(/\/+$/, '')}/dashboards/d/${encodeURIComponent(dashboardUid)}/otel-problem-span?${qs}`;
}

// Schema mirrors a policy exported from the BMC AIOps UI (the only reliable
// source — the REST docs were wrong/incomplete). Two non-obvious requirements:
//   • selectorCriteriaList items have NO surrounding parens — "( class equals
//     'X' )" fails with "Value in Condition:1 should start with '"; the bare
//     "class equals 'X'" form validates.
//   • every condition field must be present, with brackets as EMPTY STRINGS
//     (not null → NPE on ConditionNode.getConditionBracket(); not "(" / ")").
function buildCorrelationPolicy() {
  return {
    name: CORRELATION_POLICY_NAME,
    description: 'Groups OTEL_TRACE_ANOMALY events by service + namespace into a Situation. Managed by Helix Configurator.',
    types: ['CORRELATION'],
    enabled: true,
    executionOrder: 9999,
    selectorCriteriaList: ["class equals 'OTEL_TRACE_ANOMALY'"],
    configurations: [{
      type: 'CORRELATION',
      configOrder: 1,
      timeframeStatus: '',
      subType: '',
      definition: {
        type: 'root',
        label: '',
        id: null,
        children: [{
          type: 'aggregate',
          label: '',
          id: null,
          within: 30,
          minCount: 3,
          children: [],
          conditions: [
            { slotName: '$NEW.service_name', slotOperator: 'equals', slotValue: '$OLD.service_name', conditionOperator: '', conditionBracket: '', endBracket: '', conditionOrder: 0 },
            { slotName: '$NEW.service_namespace', slotOperator: 'equals', slotValue: '$OLD.service_namespace', conditionOperator: 'AND', conditionBracket: '', endBracket: '', conditionOrder: 1 },
          ],
          // ALARM, not the custom class, so the aggregated event doesn't
          // re-match this policy's own selector and self-correlate.
          newEvent: {
            newEventClass: 'ALARM',
            severity: 'CRITICAL',
            priority: 'PRIORITY_2',
            status: 'OPEN',
            location: '',
            // Lead with slots that are reliably populated. error_type and
            // anomaly_factor are empty for status-only errors (ERROR status, no
            // exception event — the common OTel-demo case), and leading with
            // them rendered "[Invalid Slot] in [Invalid Slot]" in BHOM.
            // probable_cause_operation, error_message and component_count are
            // always set when an error span is found.
            msg: 'OTel anomaly on %service_name% / %service_namespace%: %error_message% in %probable_cause_operation% (%component_count% services affected). Latest trace: %helix_trace_id% — investigate correlated traces.',
          },
        }],
      },
    }],
    timeframes: ['-1'],
  };
}

// Addressing for the non-destructive slot update on an existing class. The events
// path segment is parsed as a UUID by default, so `?idType=name` is required to
// resolve a class by name on GET. That flag does NOT carry over to PUT (PUT-by-name
// still 500s "Invalid UUID string"), so the slot-adding PUT must target the UUID —
// resolve the id with buildClassByNameUrl, then PUT to buildClassByIdUrl.
const classesBase = (base) => `${String(base).replace(/\/+$/, '')}/events-service/api/v1.0/events/classes`;
function buildClassByNameUrl(base, className) {
  return `${classesBase(base)}/${encodeURIComponent(className)}?idType=name`;
}
function buildClassByIdUrl(base, id) {
  return `${classesBase(base)}/${encodeURIComponent(id)}`;
}

module.exports = {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildClassUpdateBody, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey, buildEventCiHostname,
  hotPathServices,
  deriveProbableCause, blastRadius, buildHotPath, anomalyFactor, priorityForTrace,
  buildHelixTraceUrlFromSummary, buildSpanDashboardUrl,
  buildClassByNameUrl, buildClassByIdUrl,
};
