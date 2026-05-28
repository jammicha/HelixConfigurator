import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, selectPolicyUpsert,
} = require('../routes/situations-payloads');

const summary = {
  trace_id: '471e26391536a66fa17429e69bffd45f',
  service_name: 'traffic-generator',
  service_namespace: 'jaeger-hotrod',
  root_operation: 'scenario.iteration',
  duration_ms: 1864.4,
  span_count: 42,
  has_error: 1,
};

describe('buildClassDefinition', () => {
  it('declares the new first-class slots', () => {
    const def = buildClassDefinition();
    const names = def.attributes.map(a => a.name);
    expect(def.name).toBe(OTEL_TRACE_ANOMALY_CLASS);
    expect(def.parentClassName).toBe('EVENT');
    expect(names).toEqual(expect.arrayContaining(['helix_trace_id', 'service_name', 'service_namespace', 'trace_url']));
  });
  it('keeps helix_trace_id as the dedup slot', () => {
    const slot = buildClassDefinition().attributes.find(a => a.name === 'helix_trace_id');
    expect(slot.allFacet).toEqual(expect.arrayContaining([{ name: 'dup_detect', value: 'true' }]));
  });
  it('ADDED_SLOTS lists only the slots this feature adds (helix_trace_id pre-existed)', () => {
    // Task 5 patches an already-registered class with exactly these. helix_trace_id
    // is intentionally excluded — it shipped with the original class definition.
    expect(ADDED_SLOTS).toEqual(['service_name', 'service_namespace', 'trace_url']);
    const slotNames = buildClassDefinition().attributes.map(a => a.name);
    for (const s of ADDED_SLOTS) expect(slotNames).toContain(s);
  });
});

describe('buildAnomalyEventPayload', () => {
  it('populates service_name, service_namespace and trace_url slots', () => {
    const [evt] = buildAnomalyEventPayload({ summary, p95Ms: 200, businessServiceKey: 'BSKEY', xSource: 'JM_OTEL', appUrl: 'https://cfg.example.com/' });
    expect(evt.class).toBe(OTEL_TRACE_ANOMALY_CLASS);
    expect(evt.class_slots.service_name).toBe('traffic-generator');
    expect(evt.class_slots.service_namespace).toBe('jaeger-hotrod');
    expect(evt.class_slots.trace_url).toBe('https://cfg.example.com/otel-data?selected=471e26391536a66fa17429e69bffd45f');
    expect(evt.class_slots.helix_trace_id).toBe(summary.trace_id);
    expect(evt.source_attributes.source_hostname).toBe('traffic-generator');
  });
  it('maps severity: error->CRITICAL, outlier->MAJOR, else MINOR', () => {
    expect(buildAnomalyEventPayload({ summary, appUrl: '' })[0].severity).toBe('CRITICAL');
    const slow = { ...summary, has_error: 0, duration_ms: 500 };
    const major = buildAnomalyEventPayload({ summary: slow, p95Ms: 200, appUrl: '' })[0];
    expect(major.severity).toBe('MAJOR');
    // Outlier flavor must use the U+00D7 multiplication sign, matching the
    // event message convert-trace produced before it routed through this builder.
    expect(major.msg).toContain('>2× p95');
    expect(buildAnomalyEventPayload({ summary: slow, p95Ms: 0, appUrl: '' })[0].severity).toBe('MINOR');
    // The real caller omits p95Ms entirely when req.body.p95Ms is absent.
    expect(buildAnomalyEventPayload({ summary: slow, appUrl: '' })[0].severity).toBe('MINOR');
  });
  it('omits trace_url when appUrl is empty', () => {
    const [evt] = buildAnomalyEventPayload({ summary, appUrl: '' });
    expect(evt.class_slots.trace_url).toBe('');
  });
});

describe('buildCorrelationPolicy', () => {
  it('is a CORRELATION policy selecting on the custom class', () => {
    const p = buildCorrelationPolicy();
    expect(p.name).toBe(CORRELATION_POLICY_NAME);
    expect(p.types).toEqual(['CORRELATION']);
    expect(p.selectorCriteriaList.join(' ')).toContain("class equals 'OTEL_TRACE_ANOMALY'");
  });
  it('groups by service_name + service_namespace and outputs a non-restricted class', () => {
    const agg = buildCorrelationPolicy().configurations[0].definition.children[0];
    const slots = agg.conditions.map(c => `${c.slotName}=${c.slotValue}`);
    expect(slots).toEqual(expect.arrayContaining([
      '$NEW.service_name=$OLD.service_name',
      '$NEW.service_namespace=$OLD.service_namespace',
    ]));
    expect(agg.within).toBe(15);
    expect(agg.minCount).toBe(3);
    expect(['Anomaly', 'Prediction', 'Situation']).not.toContain(agg.newEvent.newEventClass);
  });
});

describe('selectPolicyUpsert', () => {
  it('returns POST when no policy matches the name', () => {
    expect(selectPolicyUpsert([{ id: '1', name: 'other' }], CORRELATION_POLICY_NAME)).toEqual({ method: 'POST' });
  });
  it('returns PUT with the matched id when a policy matches the name', () => {
    const existing = [{ id: '9', name: CORRELATION_POLICY_NAME }];
    expect(selectPolicyUpsert(existing, CORRELATION_POLICY_NAME)).toEqual({ method: 'PUT', id: '9' });
  });
  it('tolerates a non-array input', () => {
    expect(selectPolicyUpsert(null, CORRELATION_POLICY_NAME)).toEqual({ method: 'POST' });
  });
});
