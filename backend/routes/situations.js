// Convert OTel traces into BMC Helix AIOps Events via the Events API.
// The customer's correlation policy in AIOps is what aggregates events into
// Situations — we don't (and shouldn't) create Situations directly. Endpoint
// reference: docs.bmc.com/docs/helixoperationsmanagement/241/en/event-management-...
// Auth: same API key as the OTel collector, but in the Authorization header
// with the `apiKey` scheme instead of `X-Api-Key`.
const axios = require('axios');
const {
  OTEL_TRACE_ANOMALY_CLASS, CORRELATION_POLICY_NAME, ADDED_SLOTS,
  buildClassDefinition, buildClassUpdateBody, buildAnomalyEventPayload, buildCorrelationPolicy, splitApiKey,
  buildClassByNameUrl, buildClassByIdUrl,
  buildTriageNoteForTrace, buildEventUpdateBody, buildEventByIdUrl, extractCreatedEventIds,
  buildEventSearchUrl, buildEventSearchBody, extractSearchEventIds, buildResolutionNote, summarizeOpenEvents,
} = require('./situations-payloads');

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

// The events-service REST API (classes, policies) rejects the raw API key — it
// requires a JWT. Exchange the key's access/secret halves for one via BMC IMS
// (`/ims/api/v1/access_keys/login`) and send it as `Authorization: Bearer <jwt>`.
// The JWT lives 15 min; cache just under that (keyed by api key so a Settings
// change invalidates it) to avoid logging in on every call.
// BMC's events-service rejects axios's default Accept header
// ("application/json, text/plain, */*") with 400 validation.request.accept.invalid.
// Force a single valid media type on every events-service / IMS call.
function bmcHeaders(bearer) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

let _bearerCache = { key: null, token: null, exp: 0 };
async function getHelixBearerToken(baseUrl, apiKey) {
  if (_bearerCache.token && _bearerCache.key === apiKey && Date.now() < _bearerCache.exp) {
    return _bearerCache.token;
  }
  const creds = splitApiKey(apiKey);
  if (!creds) throw new Error('HELIX_API_KEY must be in TenantID::AccessKey::SecretKey form');
  const res = await axios.post(
    `${baseUrl}/ims/api/v1/access_keys/login`,
    { access_key: creds.accessKey, access_secret_key: creds.accessSecretKey },
    { headers: bmcHeaders(), timeout: 15_000, validateStatus: () => true },
  );
  const jwt = res.data && res.data.json_web_token;
  if (res.status < 200 || res.status >= 300 || !jwt) {
    const e = new Error(`Helix IMS login returned ${res.status}`);
    e.upstream = res.data;
    throw e;
  }
  _bearerCache = { key: apiKey, token: jwt, exp: Date.now() + 14 * 60_000 };
  return jwt;
}

// Best-effort: PATCH a note onto each just-created event's Logs & Notes tab.
// Never throws — a note failure must not fail the send. Returns true if any wrote.
async function attachNoteToEvents(baseUrl, bearer, eventIds, note) {
  if (!note || !Array.isArray(eventIds) || eventIds.length === 0) return false;
  let any = false;
  for (const id of eventIds) {
    try {
      const r = await axios.patch(buildEventByIdUrl(baseUrl, id), buildEventUpdateBody({ note }), {
        headers: bmcHeaders(bearer), timeout: 10_000, validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) any = true;
    } catch { /* best-effort */ }
  }
  return any;
}

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
    // The trace deep-link points at the portal dashboard, which lives at the
    // HELIX_ENDPOINT origin (the events base URL may be a different host/path).
    // tenantId is the first segment of the API key (TenantID::Access::Secret).
    const tenantId = (splitApiKey(apiKey) || {}).tenantId || '';
    const portalBaseUrl = (process.env.HELIX_ENDPOINT || '').trim();
    const payload = buildAnomalyEventPayload({
      summary,
      p95Ms,
      businessServiceKey: (process.env.BUSINESS_SERVICE_KEY || '').trim(),
      xSource: process.env.X_SOURCE,
      spans: trace.spans,
      baseUrl: portalBaseUrl,
      tenantId,
      spanDashboardUid: (process.env.HELIX_SPAN_DASHBOARD_UID || '').trim(),
      // Opt-in: emit one event per service on the failure path so BMC's ML can
      // correlate them into an ML Situation (needs >=2 events). Off by default.
      multiEvent: process.env.HELIX_MULTI_EVENT === '1',
    });
    // severity for the response body comes from the built event
    const severity = payload[0].severity;

    let bearer;
    try { bearer = await getHelixBearerToken(baseUrl, apiKey); }
    catch (e) { return res.status(502).json({ error: 'Helix authentication failed', details: e.message, upstream: e.upstream }); }

    const url = `${baseUrl}/events-service/api/v1.0/events`;
    try {
      const response = await axios.post(url, payload, {
        headers: bmcHeaders(bearer),
        timeout: 10_000,
        // Resolve on any status so we can surface the upstream error verbatim.
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        const createdIds = extractCreatedEventIds(response.data);
        const triageNote = buildTriageNoteForTrace({
          summary, spans: trace.spans, baseUrl: portalBaseUrl, tenantId, source: process.env.X_SOURCE,
        });
        let noteWritten = false;
        try { noteWritten = await attachNoteToEvents(baseUrl, bearer, createdIds, triageNote); } catch { /* best-effort */ }
        return res.json({ ok: true, severity, eventIds: createdIds, noteWritten, upstream: response.data });
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

    let bearer;
    try { bearer = await getHelixBearerToken(baseUrl, apiKey); }
    catch (e) { return res.status(502).json({ error: 'Helix authentication failed', details: e.message, upstream: e.upstream }); }

    const classDef = buildClassDefinition();

    const url = `${baseUrl}/events-service/api/v1.0/events/classes`;
    try {
      const response = await axios.post(url, classDef, {
        headers: bmcHeaders(bearer),
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
      // Guard against masking a failed create as "already exists". An attribute
      // collision (e.g. a built-in slot re-declared with a different type:
      // statusCode ATTR_EXIST_WITH_DIFF_TYPE, message "...already exist with
      // different data type") is a HARD failure, not a duplicate class — treating
      // it as a soft success hid a class that never got created.
      const attrCollision = body.includes('attr_exist') || body.includes('different data type');
      if (!attrCollision && (response.status === 409 || body.includes('already exist') || body.includes('duplicate'))) {
        // Class already exists — add any newly-introduced slots so it picks up the
        // RCA-enrichment attributes. The update endpoint is addressed by the class
        // UUID, NOT the name: PUT .../classes/OTEL_TRACE_ANOMALY 500s "Invalid UUID
        // string" (the path is parsed as a UUID, and unlike GET, ?idType=name does
        // NOT fix PUT). So resolve the id by name, then PUT by id. The body is
        // buildClassUpdateBody() (attributes only — the endpoint rejects
        // name/parentClassName via additionalProperties); sending the full OWN
        // attribute set is additive (inherited EVENT slots live on the parent).
        // Degrade gracefully on any failure so an existing class is never left broken.
        const idRes = await axios.get(buildClassByNameUrl(baseUrl, OTEL_TRACE_ANOMALY_CLASS), {
          headers: bmcHeaders(bearer), timeout: 15_000, validateStatus: () => true,
        });
        const classId = ((idRes.data && (idRes.data.eventClass || idRes.data)) || {}).id;
        if (!classId) {
          return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, alreadyExists: true, slotUpdate: `skipped (could not resolve class id, GET ${idRes.status})`, upstream: idRes.data });
        }
        const upd = await axios.put(buildClassByIdUrl(baseUrl, classId), buildClassUpdateBody(), {
          headers: bmcHeaders(bearer), timeout: 15_000, validateStatus: () => true,
        });
        if (upd.status >= 200 && upd.status < 300) {
          return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, updated: true, classId, addedSlots: ADDED_SLOTS, upstream: upd.data });
        }
        return res.json({ ok: true, className: OTEL_TRACE_ANOMALY_CLASS, alreadyExists: true, classId, slotUpdate: `failed (${upd.status})`, upstream: upd.data });
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

    let bearer;
    try { bearer = await getHelixBearerToken(baseUrl, apiKey); }
    catch (e) { return res.status(502).json({ error: 'Helix authentication failed', details: e.message, upstream: e.upstream }); }

    // POST the policy directly. The list endpoint 500s on this tenant, so we
    // can't pre-check existence; create it, and treat a name collision
    // (POLICY_ALREADY_EXIST) as a soft success — mirrors provision-class.
    const url = `${baseUrl}/events-service/api/v1.0/event_policies`;
    try {
      const response = await axios.post(url, buildCorrelationPolicy(), {
        headers: bmcHeaders(bearer),
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return res.json({ ok: true, policyName: CORRELATION_POLICY_NAME, upstream: response.data });
      }
      const body = JSON.stringify(response.data || '').toLowerCase();
      if (body.includes('already exist') || body.includes('duplicate')) {
        return res.json({ ok: true, policyName: CORRELATION_POLICY_NAME, alreadyExists: true, upstream: response.data });
      }
      return res.status(502).json({ error: `Helix event-policies API returned ${response.status}`, upstream: response.data });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach Helix event-policies API', details: e.message });
    }
  });
  // Close the configurator's OWN open OTEL_TRACE_ANOMALY events so the correlated
  // Situation auto-closes. Stateless: re-discovers events from Helix by
  // source_identifier (no remembered ids). Non-destructive — only ever touches
  // events whose class is OTEL_TRACE_ANOMALY (the search is scoped to it).
  app.post('/api/situations/close-events', async (req, res) => {
    const { traceId, all, eventIds } = req.body || {};
    const explicitIds = Array.isArray(eventIds) ? eventIds.filter((x) => typeof x === 'string' && x.trim()) : null;
    if (!traceId && !all && (!explicitIds || explicitIds.length === 0)) {
      return res.status(400).json({ error: 'Provide one of: traceId, all:true, or eventIds[]' });
    }
    const apiKey = (process.env.HELIX_API_KEY || '').trim();
    if (!apiKey) return res.status(412).json({ error: 'HELIX_API_KEY not configured — set it on the Settings page first.' });
    const baseUrl = resolveEventsBaseUrl();
    if (!baseUrl) return res.status(412).json({ error: 'No events endpoint configured — set HELIX_EVENTS_ENDPOINT (or HELIX_ENDPOINT) on the Settings page.' });

    let bearer;
    try { bearer = await getHelixBearerToken(baseUrl, apiKey); }
    catch (e) { return res.status(502).json({ error: 'Helix authentication failed', details: e.message, upstream: e.upstream }); }

    let ids = explicitIds;
    if (!ids || ids.length === 0) {
      try {
        const sr = await axios.post(buildEventSearchUrl(baseUrl), buildEventSearchBody({ traceId, all: !!all }), {
          headers: bmcHeaders(bearer), timeout: 15_000, validateStatus: () => true,
        });
        if (sr.status < 200 || sr.status >= 300) {
          return res.status(502).json({ error: `Helix event search returned ${sr.status}`, upstream: sr.data });
        }
        ids = extractSearchEventIds(sr.data);
      } catch (e) {
        return res.status(502).json({ error: 'Failed to reach Helix event search API', details: e.message });
      }
    }
    if (ids.length === 0) return res.json({ ok: true, closed: 0, results: [] });

    const note = buildResolutionNote(null);
    const results = [];
    for (const id of ids) {
      let ok = false; let status = 0;
      try {
        // 1) Guaranteed close (status only). Omitting ?skipAddNotes records an auto note.
        const r = await axios.patch(buildEventByIdUrl(baseUrl, id), buildEventUpdateBody({ status: 'CLOSED' }), {
          headers: bmcHeaders(bearer), timeout: 10_000, validateStatus: () => true,
        });
        status = r.status;
        const body = JSON.stringify(r.data || '').toLowerCase();
        ok = (r.status >= 200 && r.status < 300) || body.includes('already') || body.includes('closed');
        // 2) Best-effort custom resolution note (separate; never affects close result).
        try {
          await axios.patch(buildEventByIdUrl(baseUrl, id), buildEventUpdateBody({ note }), {
            headers: bmcHeaders(bearer), timeout: 10_000, validateStatus: () => true,
          });
        } catch { /* best-effort */ }
      } catch (e) { status = -1; ok = false; }
      results.push({ id, ok, status });
    }
    return res.json({ ok: true, closed: results.filter((r) => r.ok).length, results });
  });
}

module.exports = { register };
