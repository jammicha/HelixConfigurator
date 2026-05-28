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
      { name: 'trace_url', dataType: 'STRING', enum: false },
      { name: 'root_operation', dataType: 'STRING', enum: false },
      { name: 'duration_ms', dataType: 'STRING', enum: false },
      { name: 'p95_ms', dataType: 'STRING', enum: false },
      { name: 'span_count', dataType: 'STRING', enum: false },
      { name: 'has_error', dataType: 'STRING', enum: false },
      { name: 'service_id', dataType: 'STRING', enum: false },
      { name: 'business_service_key', dataType: 'STRING', enum: false },
      { name: 'x_source', dataType: 'STRING', enum: false },
    ],
  };
}

const ADDED_SLOTS = ['service_name', 'service_namespace', 'trace_url'];

function buildAnomalyEventPayload({ summary, p95Ms, businessServiceKey, xSource, appUrl }) {
  const hasError = !!summary.has_error;
  const isOutlier = typeof p95Ms === 'number' && p95Ms > 0 && summary.duration_ms > p95Ms * 2;
  const severity = hasError ? 'CRITICAL' : isOutlier ? 'MAJOR' : 'MINOR';
  const base = (appUrl || '').trim().replace(/\/+$/, '');
  const traceUrl = base ? `${base}/otel-data?selected=${summary.trace_id}` : '';
  const flavor = hasError ? 'errored' : isOutlier ? `outlier (>2× p95 ${Math.round(p95Ms)}ms)` : 'manual send';
  const msg = `OTel trace ${flavor}: ${summary.service_name}/${summary.root_operation} took ${Math.round(summary.duration_ms)}ms`;
  const details = [
    `Trace ${summary.trace_id} on service ${summary.service_name}.`,
    `Root operation: ${summary.root_operation}. Duration: ${Math.round(summary.duration_ms)}ms across ${summary.span_count} span(s).`,
    hasError ? 'Trace contains at least one error span.' : '',
    isOutlier ? `Operation p95 in window: ${Math.round(p95Ms)}ms.` : '',
    traceUrl ? `Inspect in configurator: ${traceUrl}` : '',
  ].filter(Boolean).join('\n');

  return [{
    class: OTEL_TRACE_ANOMALY_CLASS,
    severity,
    status: 'OPEN',
    category: 'APPLICATION',
    msg,
    source_identifier: `helix-otel-trace:${summary.trace_id}`,
    source_attributes: { source_hostname: summary.service_name },
    details,
    class_slots: {
      helix_trace_id: summary.trace_id,
      service_name: summary.service_name || '',
      service_namespace: summary.service_namespace || '',
      trace_url: traceUrl,
      root_operation: summary.root_operation,
      duration_ms: String(Math.round(summary.duration_ms)),
      span_count: String(summary.span_count),
      has_error: hasError ? '1' : '0',
      ...(isOutlier ? { p95_ms: String(Math.round(p95Ms)) } : {}),
      ...(businessServiceKey ? { service_id: businessServiceKey, business_service_key: businessServiceKey } : {}),
      x_source: (xSource || '').trim(),
    },
  }];
}

function buildCorrelationPolicy() {
  return {
    name: CORRELATION_POLICY_NAME,
    description: 'Aggregates OTEL_TRACE_ANOMALY events per service into a Situation. Managed by Helix Configurator.',
    types: ['CORRELATION'],
    enabled: true,
    executionOrder: 100,
    selectorCriteriaList: ["( class equals 'OTEL_TRACE_ANOMALY' )"],
    configurations: [{
      type: 'CORRELATION',
      configOrder: 1,
      definition: {
        type: 'root',
        label: 'policy',
        children: [{
          type: 'aggregate',
          within: 15,
          minCount: 3,
          conditions: [
            { slotName: '$NEW.service_name', slotOperator: 'equals', slotValue: '$OLD.service_name' },
            { slotName: '$NEW.service_namespace', slotOperator: 'equals', slotValue: '$OLD.service_namespace' },
          ],
          newEvent: {
            newEventClass: 'ALARM',
            severity: 'MAJOR',
            priority: 'PRIORITY_3',
            status: 'OPEN',
            msg: 'OTel anomaly cluster on %service_name% (%service_namespace%) - %msg%',
          },
        }],
      },
    }],
  };
}

function selectPolicyUpsert(existingPolicies, name) {
  const list = Array.isArray(existingPolicies) ? existingPolicies : [];
  const match = list.find(p => p && p.name === name);
  return match ? { method: 'PUT', id: match.id } : { method: 'POST' };
}

module.exports = {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, selectPolicyUpsert,
};
