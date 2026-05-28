// Convert OTel traces into BMC Helix AIOps Events via the Events API.
// The customer's correlation policy in AIOps is what aggregates events into
// Situations — we don't (and shouldn't) create Situations directly. Endpoint
// reference: docs.bmc.com/docs/helixoperationsmanagement/241/en/event-management-...
// Auth: same API key as the OTel collector, but in the Authorization header
// with the `apiKey` scheme instead of `X-Api-Key`.
const axios = require('axios');
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildAnomalyEventPayload, buildCorrelationPolicy, selectPolicyUpsert,
} = require('./situations-payloads');

// Custom event class for OTel-derived events. Created via the Provision
// button on the Settings page (POST /api/situations/provision-class). The
// class inherits from EVENT and adds `helix_trace_id` as a dedup slot so
// BMC's auto-dedup matches re-sends of the same trace.

// Derive the events-service base URL. Prefer an explicit HELIX_EVENTS_ENDPOINT
// (Settings page) since `HELIX_ENDPOINT` typically points at the OTLP ingest
// host, not the portal root. Fall back to the origin of HELIX_ENDPOINT, which
// is correct on tenants where ingest and portal share a hostname.
const resolveEventsBaseUrl = () => {
  const explicit = (process.env.HELIX_EVENTS_ENDPOINT || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const helixEndpoint = (process.env.HELIX_ENDPOINT || '').trim();
  if (!helixEndpoint) return '';
  try {
    return new URL(helixEndpoint).origin;
  } catch {
    return '';
  }
};

function register(app, { otelStore }) {
  app.post('/api/situations/convert-trace', async (req, res) => {
    const { traceId, p95Ms } = req.body || {};
    if (typeof traceId !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(traceId)) {
      return res.status(400).json({ error: 'Invalid trace id' });
    }
    const trace = otelStore.getTrace(traceId.toLowerCase());
    if (!trace) return res.status(404).json({ error: 'Trace not found' });

    const apiKey = (process.env.HELIX_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(412).json({ error: 'HELIX_API_KEY not configured — set it on the Settings page first.' });
    }
    const baseUrl = resolveEventsBaseUrl();
    if (!baseUrl) {
      return res.status(412).json({ error: 'No events endpoint configured — set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });
    }

    // Severity follows the anomaly criterion we validated against industry
    // practice: errors → CRITICAL, latency outlier → MAJOR, neither → MINOR.
    // Frontend supplies the operation's p95 so we don't recompute here; the
    // outlier rule (duration > 2× p95) matches the trace-list flagging logic.
    const summary = trace.summary;
    const hasError = !!summary.has_error;
    const isOutlier = typeof p95Ms === 'number' && p95Ms > 0 && summary.duration_ms > p95Ms * 2;
    const severity = hasError ? 'CRITICAL' : isOutlier ? 'MAJOR' : 'MINOR';

    const appUrl = (process.env.APP_URL || '').trim();
    const traceLink = appUrl ? `${appUrl.replace(/\/+$/, '')}/otel-data?selected=${summary.trace_id}` : '';
    const flavor = hasError ? 'errored' : isOutlier ? `outlier (>2× p95 ${Math.round(p95Ms)}ms)` : 'manual send';
    const msg = `OTel trace ${flavor}: ${summary.service_name}/${summary.root_operation} took ${Math.round(summary.duration_ms)}ms`;
    const details = [
      `Trace ${summary.trace_id} on service ${summary.service_name}.`,
      `Root operation: ${summary.root_operation}. Duration: ${Math.round(summary.duration_ms)}ms across ${summary.span_count} span(s).`,
      hasError ? 'Trace contains at least one error span.' : '',
      isOutlier ? `Operation p95 in window: ${Math.round(p95Ms)}ms.` : '',
      traceLink ? `Inspect in configurator: ${traceLink}` : '',
    ].filter(Boolean).join('\n');

    // BUSINESS_SERVICE_KEY is the AIOps Business Service entity this trace's
    // service belongs to. Without it, BMC's topology_lookup facet matches the
    // event against every service that shares the OTel service.name, which
    // is how events ended up duplicated across services in early testing.
    // Putting the key into `service_id` (BMC's canonical topology-lookup slot)
    // pins the event to exactly one business service.
    const businessServiceKey = (process.env.BUSINESS_SERVICE_KEY || '').trim();
    // Class is OTEL_TRACE_ANOMALY (custom child of EVENT) — requires that the
    // user has run "Provision AIOps event class" on the Settings page once.
    // The class adds `helix_trace_id` as a dedup slot so re-sends of the same
    // trace update the existing event instead of creating duplicates.
    const payload = [{
      class: OTEL_TRACE_ANOMALY_CLASS,
      severity,
      status: 'OPEN',
      category: 'APPLICATION',
      msg,
      source_identifier: `helix-otel-trace:${summary.trace_id}`,
      source_attributes: {
        // service.name → source_hostname is the convention we recommend for
        // host-style correlation policies on the customer side.
        source_hostname: summary.service_name,
      },
      details,
      class_slots: {
        // helix_trace_id is the dedup slot (flagged dup_detect=true at class
        // creation). Stable per trace → re-sends update rather than duplicate.
        helix_trace_id: summary.trace_id,
        root_operation: summary.root_operation,
        duration_ms: String(Math.round(summary.duration_ms)),
        span_count: String(summary.span_count),
        has_error: hasError ? '1' : '0',
        ...(isOutlier ? { p95_ms: String(Math.round(p95Ms)) } : {}),
        ...(businessServiceKey ? {
          // `service_id` is BMC's canonical topology_lookup slot for tying an
          // event to a service model component. Mirror into business_service_key
          // for tenants whose tag rules look there instead.
          service_id: businessServiceKey,
          business_service_key: businessServiceKey,
        } : {}),
        x_source: (process.env.X_SOURCE || '').trim(),
      },
    }];

    const url = `${baseUrl}/events-service/api/v1.0/events`;
    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `apiKey ${apiKey}`,
        },
        timeout: 10_000,
        // Resolve on any status so we can surface the upstream error verbatim.
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return res.json({ ok: true, severity, upstream: response.data });
      }
      return res.status(502).json({
        error: `Helix events API returned ${response.status}`,
        upstream: response.data,
      });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Helix events API', details: e.message });
    }
  });

  // Provision the OTEL_TRACE_ANOMALY event class on the customer's tenant. This
  // is what makes the convert-trace flow's dedup actually work: without the
  // class (and its `helix_trace_id` dedup slot), every re-send creates a fresh
  // event. Idempotent — calling on an existing class returns ok with a hint.
  app.post('/api/situations/provision-class', async (req, res) => {
    const apiKey = (process.env.HELIX_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(412).json({ error: 'HELIX_API_KEY not configured — set it on the Settings page first.' });
    }
    const baseUrl = resolveEventsBaseUrl();
    if (!baseUrl) {
      return res.status(412).json({ error: 'No events endpoint configured — set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });
    }

    // Class definition: helix_trace_id carries the dedup facet, plus a few
    // OTel-flavored slots that surface usefully in the AIOps console.
    const classDef = {
      name: OTEL_TRACE_ANOMALY_CLASS,
      parentClassName: 'EVENT',
      attributes: [
        {
          name: 'helix_trace_id',
          dataType: 'STRING',
          enum: false,
          allFacet: [
            { name: 'dup_detect', value: 'true' },
            { name: 'mandatory', value: 'true' },
          ],
        },
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

    const url = `${baseUrl}/events-service/api/v1.0/events/classes`;
    try {
      const response = await axios.post(url, classDef, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `apiKey ${apiKey}`,
        },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, upstream: response.data });
      }
      // BMC returns 409-ish (or 400 with a body mentioning "already exists")
      // when the class already exists. Surface that as a soft success — the
      // class is in the desired state from the caller's perspective.
      const body = JSON.stringify(response.data || '').toLowerCase();
      if (response.status === 409 || body.includes('already exist') || body.includes('duplicate')) {
        return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, alreadyExists: true, upstream: response.data });
      }
      return res.status(502).json({
        error: `Helix event-classes API returned ${response.status}`,
        upstream: response.data,
      });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Helix event-classes API', details: e.message });
    }
  });

  // Provision (idempotently) the per-service correlation policy that turns
  // OTEL_TRACE_ANOMALY events into Situations. Follows the same auth/host
  // pattern as provision-class. Upsert: list policies, match by name, PUT or POST.
  app.post('/api/situations/provision-correlation-policy', async (req, res) => {
    const apiKey = (process.env.HELIX_API_KEY || '').trim();
    if (!apiKey) return res.status(412).json({ error: 'HELIX_API_KEY not configured — set it on the Settings page first.' });
    const baseUrl = resolveEventsBaseUrl();
    if (!baseUrl) return res.status(412).json({ error: 'No events endpoint configured — set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });

    const headers = { 'Content-Type': 'application/json', Authorization: `apiKey ${apiKey}` };
    const policiesUrl = `${baseUrl}/events-service/api/v1.0/event_policies`;
    try {
      // List existing policies to decide create vs update.
      const list = await axios.get(policiesUrl, { headers, timeout: 15_000, validateStatus: () => true });
      // Guard the read: a failed list (bad key, wrong host) must surface here,
      // not fall through to a blind POST that masks the real cause.
      if (list.status < 200 || list.status >= 300) {
        return res.status(502).json({ error: `Helix event-policies list returned ${list.status}`, upstream: list.data });
      }
      const existing = Array.isArray(list.data) ? list.data : (list.data && list.data.responseContent) || [];
      const action = selectPolicyUpsert(existing, CORRELATION_POLICY_NAME);
      const policy = buildCorrelationPolicy();

      const writeUrl = action.method === 'PUT' ? `${policiesUrl}/${action.id}` : policiesUrl;
      const response = await axios({
        method: action.method, url: writeUrl, headers, data: policy,
        timeout: 15_000, validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return res.json({ ok: true, action: action.method, policyName: CORRELATION_POLICY_NAME, upstream: response.data });
      }
      return res.status(502).json({ error: `Helix event-policies API returned ${response.status}`, upstream: response.data });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Helix event-policies API', details: e.message });
    }
  });
}

module.exports = { register };
