import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildClassUpdateBody, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
  deriveProbableCause, blastRadius, anomalyFactor, priorityForTrace, buildHotPath,
  buildHelixTraceUrlFromSummary,
} = require('../routes/situations-payloads');

// A span shaped exactly like otelStore.getTrace().spans[]: .attributes and
// .events are already-parsed objects/arrays (NOT JSON strings).
function span(o = {}) {
  return {
    spanId: o.spanId || 's1',
    traceId: o.traceId || 't1',
    parentSpanId: o.parentSpanId ?? null,
    serviceName: o.serviceName || 'svc',
    name: o.name || 'op',
    kind: o.kind || 0,
    startTimeNs: o.startTimeNs || 0,
    endTimeNs: o.endTimeNs || 0,
    durationMs: o.durationMs || 1,
    statusCode: o.statusCode || 0,
    statusMessage: o.statusMessage || '',
    attributes: o.attributes || {},
    events: o.events || [],
  };
}
function excEvent(type, message) {
  return { name: 'exception', timeUnixNano: 1, attributes: { 'exception.type': type, 'exception.message': message } };
}

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
    expect(buildAnomalyEventPayload({ summary })[0].severity).toBe('CRITICAL');
    const slow = { ...summary, has_error: 0, duration_ms: 500 };
    const major = buildAnomalyEventPayload({ summary: slow, p95Ms: 200 })[0];
    expect(major.severity).toBe('MAJOR');
    // Outlier flavor must use the U+00D7 multiplication sign, matching the
    // event message convert-trace produced before it routed through this builder.
    expect(major.msg).toContain('>2× p95');
    expect(buildAnomalyEventPayload({ summary: slow, p95Ms: 0 })[0].severity).toBe('MINOR');
    // The real caller omits p95Ms entirely when req.body.p95Ms is absent.
    expect(buildAnomalyEventPayload({ summary: slow })[0].severity).toBe('MINOR');
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

describe('deriveProbableCause', () => {
  it('extracts exception type/message, operation, service, and code location', () => {
    const spans = [
      span({ name: 'POST /checkout', serviceName: 'frontend', startTimeNs: 1 }),
      span({
        name: 'PaymentClient.charge', serviceName: 'payment', startTimeNs: 5, statusCode: 2,
        events: [excEvent('NullPointerException', 'amount was null')],
        attributes: { 'code.filepath': 'PaymentClient.java', 'code.function': 'charge', 'code.lineno': 42 },
      }),
    ];
    const c = deriveProbableCause(spans);
    expect(c.error_type).toBe('NullPointerException');
    expect(c.error_message).toBe('amount was null');
    expect(c.probable_cause_operation).toBe('PaymentClient.charge');
    expect(c.probable_cause_service).toBe('payment');
    expect(c.code_location).toBe('PaymentClient.java:charge:42');
  });

  it('falls back to statusMessage with empty error_type when no exception event', () => {
    const spans = [
      span({ name: 'GET /cart', startTimeNs: 1 }),
      span({ name: 'db.query', serviceName: 'cartdb', startTimeNs: 3, statusCode: 2, statusMessage: 'deadlock detected' }),
    ];
    const c = deriveProbableCause(spans);
    expect(c.error_message).toBe('deadlock detected');
    expect(c.error_type).toBe('');
    expect(c.probable_cause_operation).toBe('db.query');
  });

  it('picks the most downstream error span (latest start) and prefers one with an exception', () => {
    const spans = [
      span({ name: 'A', startTimeNs: 1, statusCode: 2, statusMessage: 'upstream' }),
      span({ name: 'B', startTimeNs: 9, statusCode: 2, events: [excEvent('IOError', 'socket closed')] }),
    ];
    const c = deriveProbableCause(spans);
    expect(c.probable_cause_operation).toBe('B');
    expect(c.error_type).toBe('IOError');
  });

  it('truncates very long error messages to 200 chars', () => {
    const long = 'x'.repeat(500);
    const c = deriveProbableCause([span({ statusCode: 2, events: [excEvent('E', long)] })]);
    expect(c.error_message.length).toBe(200);
  });

  it('returns all-empty for a clean (latency-only) trace', () => {
    const c = deriveProbableCause([span({ name: 'GET /ok' }), span({ name: 'GET /ok2' })]);
    expect(c).toEqual({
      probable_cause_span_id: '',
      probable_cause_service: '', probable_cause_operation: '',
      error_type: '', error_message: '', code_location: '',
    });
  });

  it('handles empty / non-array input without throwing', () => {
    expect(deriveProbableCause([]).error_type).toBe('');
    expect(deriveProbableCause(undefined).error_type).toBe('');
  });
});

describe('blastRadius', () => {
  it('counts distinct services and joins their names', () => {
    const r = blastRadius([
      span({ serviceName: 'frontend' }),
      span({ serviceName: 'checkout' }),
      span({ serviceName: 'frontend' }),
      span({ serviceName: 'payment' }),
    ]);
    expect(r.component_count).toBe(3);
    expect(r.affected_services).toBe('frontend,checkout,payment');
  });

  it('caps the name list at 5 and summarizes the remainder', () => {
    const r = blastRadius(['a','b','c','d','e','f','g'].map(n => span({ serviceName: n })));
    expect(r.component_count).toBe(7);
    expect(r.affected_services).toBe('a,b,c,d,e +2 more');
  });

  it('returns empty for no spans', () => {
    expect(blastRadius([])).toEqual({ affected_services: '', component_count: 0 });
    expect(blastRadius(undefined)).toEqual({ affected_services: '', component_count: 0 });
  });
});

describe('anomalyFactor', () => {
  it('rounds duration / p95 to one decimal', () => {
    expect(anomalyFactor(1864, 200)).toBe(9.3);
  });
  it('returns null when p95 is missing or zero', () => {
    expect(anomalyFactor(1864, 0)).toBeNull();
    expect(anomalyFactor(1864, undefined)).toBeNull();
  });
});

describe('priorityForTrace', () => {
  it('P1 when an error trace is also a big outlier or wide blast', () => {
    expect(priorityForTrace({ hasError: true, anomalyFactor: 5, blastCount: 1 })).toBe('PRIORITY_1');
    expect(priorityForTrace({ hasError: true, anomalyFactor: 1, blastCount: 3 })).toBe('PRIORITY_1');
  });
  it('P2 for a contained error trace', () => {
    expect(priorityForTrace({ hasError: true, anomalyFactor: 1, blastCount: 1 })).toBe('PRIORITY_2');
  });
  it('P3 / P4 / P5 scale with the latency outlier factor', () => {
    expect(priorityForTrace({ hasError: false, anomalyFactor: 5, blastCount: 1 })).toBe('PRIORITY_3');
    expect(priorityForTrace({ hasError: false, anomalyFactor: 2, blastCount: 1 })).toBe('PRIORITY_4');
    expect(priorityForTrace({ hasError: false, anomalyFactor: null, blastCount: 1 })).toBe('PRIORITY_5');
  });
});

describe('buildHotPath', () => {
  it('traces the ancestor chain root→…→error span, marking the failure', () => {
    const spans = [
      span({ spanId: 'a', parentSpanId: null, serviceName: 'frontend', name: 'POST /checkout' }),
      span({ spanId: 'b', parentSpanId: 'a', serviceName: 'driver', name: 'GetDriver' }),
      span({ spanId: 'c', parentSpanId: 'b', serviceName: 'redis-manual', name: 'Fetch Driver Profile' }),
    ];
    expect(buildHotPath(spans, 'c'))
      .toBe('frontend/POST /checkout → driver/GetDriver → redis-manual/Fetch Driver Profile ✗');
  });

  it('returns empty string for an unknown or missing span id', () => {
    expect(buildHotPath([span({ spanId: 'a' })], 'nope')).toBe('');
    expect(buildHotPath([span({ spanId: 'a' })], '')).toBe('');
  });
});

describe('buildHelixTraceUrlFromSummary', () => {
  const base = { baseUrl: 'https://tenant.example.com', tenantId: 'TID', source: 'JM_OTEL' };
  const summary = {
    trace_id: '86c9cd9ee99aa88fa04ba19ef5ee4f78',
    service_name: 'frontend',
    service_namespace: 'jaeger-hotrod',
    start_time_ns: 1748466199645000000,
  };

  it('builds the OTelTraceDetails dashboard URL', () => {
    const u = new URL(buildHelixTraceUrlFromSummary({ ...base, summary }));
    expect(u.pathname).toBe('/dashboards/d/OTelTraceDetails/otel-trace-details');
    expect(u.searchParams.get('orgId')).toBe('TID');
    expect(u.searchParams.get('var-OTelService')).toBe('frontend');
  });

  it('uppercases the trace id', () => {
    const u = new URL(buildHelixTraceUrlFromSummary({ ...base, summary }));
    expect(u.searchParams.get('var-TraceId')).toBe('86C9CD9EE99AA88FA04BA19EF5EE4F78');
  });

  it('uses the trace namespace, falling back to source', () => {
    const withNs = new URL(buildHelixTraceUrlFromSummary({ ...base, summary }));
    expect(withNs.searchParams.get('var-OTelNamespace')).toBe('jaeger-hotrod');
    const noNs = new URL(buildHelixTraceUrlFromSummary({ ...base, summary: { ...summary, service_namespace: '' } }));
    expect(noNs.searchParams.get('var-OTelNamespace')).toBe('JM_OTEL');
  });

  it('encodes the timestamp space as %20, never +', () => {
    const url = buildHelixTraceUrlFromSummary({ ...base, summary });
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
  });

  it('returns empty string for missing inputs or the install placeholder', () => {
    expect(buildHelixTraceUrlFromSummary({ ...base, baseUrl: '', summary })).toBe('');
    expect(buildHelixTraceUrlFromSummary({ ...base, tenantId: '', summary })).toBe('');
    expect(buildHelixTraceUrlFromSummary({ ...base, summary: { ...summary, trace_id: '' } })).toBe('');
    expect(buildHelixTraceUrlFromSummary({ ...base, baseUrl: 'https://your-tenant.onbmc.com', summary })).toBe('');
  });
});

describe('buildAnomalyEventPayload (enriched)', () => {
  const errSummary = {
    trace_id: 'abc123', service_name: 'frontend', service_namespace: 'shop',
    root_operation: 'POST /checkout', duration_ms: 1864, span_count: 12, has_error: 1,
    start_time_ns: 1748466199645000000,
  };
  const errSpans = [
    span({ name: 'POST /checkout', serviceName: 'frontend', startTimeNs: 1 }),
    span({
      name: 'PaymentClient.charge', serviceName: 'payment', startTimeNs: 5, statusCode: 2,
      events: [excEvent('NullPointerException', 'amount was null')],
      attributes: { 'code.filepath': 'Pay.java', 'code.function': 'charge', 'code.lineno': 42 },
    }),
  ];
  const linkArgs = { baseUrl: 'https://tenant.example.com', tenantId: 'TID' };

  it('names the probable cause in msg and fills cause/blast/priority slots', () => {
    const [e] = buildAnomalyEventPayload({ summary: errSummary, p95Ms: 200, xSource: 'JM_OTEL', spans: errSpans, ...linkArgs });
    expect(e.msg).toContain('NullPointerException');
    expect(e.msg).toContain('payment/PaymentClient.charge');
    expect(e.class_slots.error_type).toBe('NullPointerException');
    expect(e.class_slots.probable_cause_operation).toBe('PaymentClient.charge');
    expect(e.class_slots.code_location).toBe('Pay.java:charge:42');
    expect(e.class_slots.anomaly_factor).toBe('9.3');
    expect(e.class_slots.component_count).toBe('2');
    expect(e.class_slots.priority).toBe('PRIORITY_1');
    expect(e.priority).toBe('PRIORITY_1');
  });

  it('puts the trace deep-link in a slot and an "Open trace:" details line', () => {
    const [e] = buildAnomalyEventPayload({ summary: errSummary, p95Ms: 200, xSource: 'JM_OTEL', spans: errSpans, ...linkArgs });
    expect(e.class_slots.trace_url).toContain('/dashboards/d/OTelTraceDetails/');
    expect(e.details).toContain('Open trace: https://tenant.example.com/dashboards/d/OTelTraceDetails/');
  });

  it('a latency-only trace gets anomaly_factor + MAJOR but no error_type', () => {
    const slow = { ...errSummary, has_error: 0, duration_ms: 900 };
    const slowSpans = [span({ serviceName: 'frontend' }), span({ serviceName: 'cart' })];
    const [e] = buildAnomalyEventPayload({ summary: slow, p95Ms: 200, xSource: 'JM_OTEL', spans: slowSpans, ...linkArgs });
    expect(e.severity).toBe('MAJOR');
    expect(e.class_slots.anomaly_factor).toBe('4.5');
    expect(e.class_slots).not.toHaveProperty('error_type');
  });

  it('without spans, output is unchanged from the legacy shape', () => {
    const [legacy] = buildAnomalyEventPayload({ summary: errSummary, p95Ms: 200, xSource: 'JM_OTEL' });
    expect(legacy.msg).toBe('OTel trace errored: frontend/POST /checkout took 1864ms');
    expect(legacy.class_slots).not.toHaveProperty('trace_url');
    expect(legacy.class_slots).not.toHaveProperty('error_type');
    expect(legacy).not.toHaveProperty('priority');
    expect(legacy.details).not.toContain('Open trace:');
  });
});

describe('buildClassDefinition (enriched slots)', () => {
  it('declares the RCA-enrichment slots as STRING attributes', () => {
    const names = buildClassDefinition().attributes.map(a => a.name);
    for (const s of ['probable_cause_service','probable_cause_operation','error_type','error_message',
      'code_location','anomaly_factor','affected_services','component_count','trace_url','priority']) {
      expect(names).toContain(s);
    }
  });
});

describe('buildCorrelationPolicy (enriched title)', () => {
  it('leads the Situation message with slots populated for status-only errors', () => {
    // error_type and anomaly_factor are empty for the common status-only error
    // (ERROR status, no exception event) — leading with them rendered
    // "[Invalid Slot] in [Invalid Slot]" in BHOM. The title must lead with slots
    // that are reliably populated: the cause operation, the error message, and
    // the affected-component count.
    const m = buildCorrelationPolicy().configurations[0].definition.children[0].newEvent.msg;
    expect(m).toContain('%probable_cause_operation%');
    expect(m).toContain('%error_message%');
    expect(m).toContain('%component_count%');
    expect(m).not.toContain('%error_type%');
    expect(m).not.toContain('%anomaly_factor%');
  });
  it('still selects with NO parens and keeps empty-string brackets', () => {
    const p = buildCorrelationPolicy();
    expect(p.selectorCriteriaList[0]).toBe("class equals 'OTEL_TRACE_ANOMALY'");
    expect(p.selectorCriteriaList[0]).not.toContain('(');
    for (const c of p.configurations[0].definition.children[0].conditions) {
      expect(c.conditionBracket).toBe('');
      expect(c.endBracket).toBe('');
    }
  });
});

describe('buildAnomalyEventPayload (status-only error headline)', () => {
  const sum = { trace_id:'t', service_name:'checkout-web', service_namespace:'shop', root_operation:'POST /checkout', duration_ms:164, span_count:8, has_error:1, start_time_ns:1 };
  it('names the cause in msg even for a status-only error (no exception type)', () => {
    const spans = [
      span({ serviceName:'checkout-web', name:'POST /checkout', startTimeNs:1 }),
      span({ serviceName:'stripe-mock', name:'POST /v1/charges', startTimeNs:5, statusCode:2, statusMessage:'service_unavailable' }),
    ];
    const [e] = buildAnomalyEventPayload({ summary: sum, p95Ms: 400, xSource:'JM_OTEL', spans, baseUrl:'https://t.example.com', tenantId:'TID' });
    expect(e.msg).toContain('stripe-mock/POST /v1/charges');
    expect(e.msg).toContain('service_unavailable');
    expect(e.msg).not.toContain('took 164ms');
  });
  it('suppresses the anomaly factor in msg when the trace is faster than p95', () => {
    const spans = [ span({ serviceName:'stripe-mock', name:'POST /v1/charges', statusCode:2, statusMessage:'service_unavailable' }) ];
    const [e] = buildAnomalyEventPayload({ summary: sum, p95Ms: 400, spans });
    expect(e.msg).not.toContain('× p95');
  });
});

describe('buildClassUpdateBody', () => {
  it('omits name/parentClassName and the built-in priority attr, but keeps every custom slot', () => {
    const body = buildClassUpdateBody();
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('parentClassName');
    const names = body.attributes.map(a => a.name);
    // every custom RCA slot must be in the update body...
    for (const s of ['helix_trace_id','probable_cause_service','probable_cause_operation','error_type','error_message','code_location','anomaly_factor','affected_services','component_count','trace_url']) {
      expect(names).toContain(s);
    }
    // ...but `priority` is a built-in EVENT attribute (non-STRING). Re-declaring it
    // on update fails ATTR_EXIST_WITH_DIFF_TYPE and aborts the whole slot-add, so
    // built-ins are excluded from the update body.
    expect(names).not.toContain('priority');
  });
  it('preserves the helix_trace_id dedup facet', () => {
    const slot = buildClassUpdateBody().attributes.find(a => a.name === 'helix_trace_id');
    expect(slot.allFacet).toEqual(expect.arrayContaining([{ name: 'dup_detect', value: 'true' }]));
  });
});

// Non-destructive slot update addresses the class two different ways, both live-
// validated: GET resolves by name (?idType=name), but the slot-adding PUT must
// target the UUID — ?idType=name fixes GET yet PUT-by-name still 500s
// "Invalid UUID string", so we resolve the id first then PUT by id.
const { buildClassByNameUrl, buildClassByIdUrl } = require('../routes/situations-payloads');

describe('deriveProbableCause span id', () => {
  it('returns the originating error span id', () => {
    const spans = [
      span({ spanId: 'root', serviceName: 'frontend', name: 'POST /checkout', startTimeNs: 0 }),
      span({ spanId: 'bad', parentSpanId: 'root', serviceName: 'redis-manual', name: 'Fetch Driver Profile',
             statusCode: 2, statusMessage: 'errors.errorString', startTimeNs: 100 }),
    ];
    const cause = deriveProbableCause(spans);
    expect(cause.probable_cause_span_id).toBe('bad');
    expect(cause.probable_cause_service).toBe('redis-manual');
    expect(cause.probable_cause_operation).toBe('Fetch Driver Profile');
  });

  it('returns empty span id when there is no error span', () => {
    expect(deriveProbableCause([span({ statusCode: 0 })]).probable_cause_span_id).toBe('');
  });
});

describe('class URL builders (non-destructive slot update)', () => {
  const base = 'https://t.onbmc.com';
  it('resolves a class by name with idType=name (GET)', () => {
    expect(buildClassByNameUrl(base, 'OTEL_TRACE_ANOMALY'))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/events/classes/OTEL_TRACE_ANOMALY?idType=name');
  });
  it('addresses a class by UUID with no idType (PUT target)', () => {
    expect(buildClassByIdUrl(base, '0376ea69-5af8-11f1-a087-5b3c44d5e1b3'))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/events/classes/0376ea69-5af8-11f1-a087-5b3c44d5e1b3');
  });
  it('strips a trailing slash from the base', () => {
    expect(buildClassByIdUrl('https://t.onbmc.com/', 'abc'))
      .toBe('https://t.onbmc.com/events-service/api/v1.0/events/classes/abc');
  });
});
