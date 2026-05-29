import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
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
    expect(names).toEqual(expect.arrayContaining(['helix_trace_id', 'service_name', 'service_namespace']));
  });
  it('keeps helix_trace_id as the dedup slot', () => {
    const slot = buildClassDefinition().attributes.find(a => a.name === 'helix_trace_id');
    expect(slot.allFacet).toEqual(expect.arrayContaining([{ name: 'dup_detect', value: 'true' }]));
  });
  it('ADDED_SLOTS lists only the slots this feature adds (helix_trace_id pre-existed)', () => {
    // Task 5 patches an already-registered class with exactly these. helix_trace_id
    // is intentionally excluded — it shipped with the original class definition.
    expect(ADDED_SLOTS).toEqual(['service_name', 'service_namespace']);
    const slotNames = buildClassDefinition().attributes.map(a => a.name);
    for (const s of ADDED_SLOTS) expect(slotNames).toContain(s);
  });
});

describe('buildAnomalyEventPayload', () => {
  it('populates service_name and service_namespace slots', () => {
    const [evt] = buildAnomalyEventPayload({ summary, p95Ms: 200, businessServiceKey: 'BSKEY', xSource: 'JM_OTEL' });
    expect(evt.class).toBe(OTEL_TRACE_ANOMALY_CLASS);
    expect(evt.class_slots.service_name).toBe('traffic-generator');
    expect(evt.class_slots.service_namespace).toBe('jaeger-hotrod');
    expect(evt.class_slots.helix_trace_id).toBe(summary.trace_id);
    expect(evt.source_attributes.source_hostname).toBe('traffic-generator');
    expect(evt.class_slots).not.toHaveProperty('trace_url');
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
});

describe('buildCorrelationPolicy', () => {
  // These assertions pin the exact schema quirks validated against a live
  // BMC tenant — each was a real 500 before being fixed.
  it('selects on the custom class with NO surrounding parens', () => {
    const p = buildCorrelationPolicy();
    expect(p.name).toBe(CORRELATION_POLICY_NAME);
    expect(p.types).toEqual(['CORRELATION']);
    expect(p.selectorCriteriaList[0]).toBe("class equals 'OTEL_TRACE_ANOMALY'");
    expect(p.selectorCriteriaList[0]).not.toContain('('); // parens → "Value should start with '"
  });
  it('groups by service_name + service_namespace with fully-specified condition nodes', () => {
    const agg = buildCorrelationPolicy().configurations[0].definition.children[0];
    expect(agg.within).toBe(30);
    expect(agg.minCount).toBe(3);
    expect(agg.conditions.map(c => `${c.slotName}=${c.slotValue}`)).toEqual([
      '$NEW.service_name=$OLD.service_name',
      '$NEW.service_namespace=$OLD.service_namespace',
    ]);
    // Brackets must be present as empty strings (null → NPE; "(" → wrong).
    for (const c of agg.conditions) {
      expect(c.conditionBracket).toBe('');
      expect(c.endBracket).toBe('');
      expect(typeof c.conditionOrder).toBe('number');
    }
    expect(agg.conditions[0].conditionOperator).toBe('');
    expect(agg.conditions[1].conditionOperator).toBe('AND');
  });
  it('aggregates to ALARM — not a restricted class, and not the class it selects on', () => {
    const agg = buildCorrelationPolicy().configurations[0].definition.children[0];
    expect(agg.newEvent.newEventClass).toBe('ALARM');
    expect(['Anomaly', 'Prediction', 'Situation', 'OTEL_TRACE_ANOMALY'])
      .not.toContain(agg.newEvent.newEventClass);
  });
});

describe('splitApiKey', () => {
  it('splits TenantID::AccessKey::SecretKey into IMS login parts', () => {
    expect(splitApiKey('TID123::AKxyz::SKsecret')).toEqual({
      tenantId: 'TID123', accessKey: 'AKxyz', accessSecretKey: 'SKsecret',
    });
  });
  it('returns null for malformed keys', () => {
    expect(splitApiKey('')).toBeNull();
    expect(splitApiKey(null)).toBeNull();
    expect(splitApiKey('only::two')).toBeNull();
    expect(splitApiKey('a::b::c::d')).toBeNull();
    expect(splitApiKey('a::::c')).toBeNull(); // empty middle segment
  });
});
