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
    ],
  };
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

function buildAnomalyEventPayload({ summary, p95Ms, businessServiceKey, xSource }) {
  const hasError = !!summary.has_error;
  const isOutlier = typeof p95Ms === 'number' && p95Ms > 0 && summary.duration_ms > p95Ms * 2;
  const severity = hasError ? 'CRITICAL' : isOutlier ? 'MAJOR' : 'MINOR';
  const flavor = hasError ? 'errored' : isOutlier ? `outlier (>2× p95 ${Math.round(p95Ms)}ms)` : 'manual send';
  const msg = `OTel trace ${flavor}: ${summary.service_name}/${summary.root_operation} took ${Math.round(summary.duration_ms)}ms`;
  const details = [
    `Trace ${summary.trace_id} on service ${summary.service_name}.`,
    `Root operation: ${summary.root_operation}. Duration: ${Math.round(summary.duration_ms)}ms across ${summary.span_count} span(s).`,
    hasError ? 'Trace contains at least one error span.' : '',
    isOutlier ? `Operation p95 in window: ${Math.round(p95Ms)}ms.` : '',
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
            msg: 'OTel trace anomaly cluster on %service_name% / %service_namespace% — %root_operation% errored repeatedly. Latest trace: %helix_trace_id% (%duration_ms%ms, %span_count% spans)',
          },
        }],
      },
    }],
    timeframes: ['-1'],
  };
}

module.exports = {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
};
