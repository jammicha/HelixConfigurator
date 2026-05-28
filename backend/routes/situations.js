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

    const summary = trace.summary;
    const payload = buildAnomalyEventPayload({
      summary,
      p95Ms,
      businessServiceKey: (process.env.BUSINESS_SERVICE_KEY || '').trim(),
      xSource: process.env.X_SOURCE,
      appUrl: process.env.APP_URL,
    });
    // severity for the response body comes from the built event
    const severity = payload[0].severity;

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

    const classDef = buildClassDefinition();

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
        // Class already exists — try to add any newly-introduced slots so older
        // tenants pick up service_name/service_namespace/trace_url. (The exact
        // update verb is being confirmed against a live tenant in Task 1; PUT of
        // the full definition is the working assumption. Degrade gracefully if
        // the update is rejected so an existing class is never left broken.)
        const updateUrl = `${url}/${OTEL_TRACE_ANOMALY_CLASS}`;
        const upd = await axios.put(updateUrl, classDef, {
          headers: { 'Content-Type': 'application/json', Authorization: `apiKey ${apiKey}` },
          timeout: 15_000,
          validateStatus: () => true,
        });
        if (upd.status >= 200 && upd.status < 300) {
          return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, updated: true, addedSlots: ADDED_SLOTS, upstream: upd.data });
        }
        return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, alreadyExists: true, slotUpdate: `failed (${upd.status})`, upstream: upd.data });
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
