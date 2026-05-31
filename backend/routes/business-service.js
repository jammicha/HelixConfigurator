// Guided "link OTel namespace → Business Service" API. The OTel ingest key can't
// reach CMDB/service-model APIs (Task 0 spike), so this makes NO authenticated
// Helix calls — it reads local telemetry, builds a guided checklist + deep-links,
// and persists BUSINESS_SERVICE_KEY to its own .env. Collaborators injectable.
const path = require('path');
const { buildBindInstructions, extractServiceKey, collapseNamespaces } = require('../business-service-payloads');
const { upsertEnvVar } = require('../envFile');

function register(app, {
  otelStore,
  env = process.env,
  envPath = path.join(__dirname, '..', '..', '.env'),
} = {}) {
  const tenantId = () => String((env.HELIX_API_KEY || '').split('::')[0] || '').trim();

  // OTel namespaces currently arriving (local otelStore). The un-namespaced
  // bucket maps to X_SOURCE, and collapses into a matching namespace so an
  // X_SOURCE that equals a real namespace doesn't show as a duplicate row.
  app.get('/api/business-service/namespaces', (req, res) => {
    res.json({ namespaces: collapseNamespaces(otelStore.listNamespaces() || [], env.X_SOURCE || '') });
  });

  // Guided-bind checklist + deep-links (pure; no write).
  app.get('/api/business-service/bind-instructions', (req, res) => {
    res.json(buildBindInstructions({
      endpoint: env.HELIX_ENDPOINT || '',
      namespace: (req.query.namespace || '').toString(),
      xSource: env.X_SOURCE || '',
      tenantId: tenantId(),
    }));
  });

  // Capture: extract the key (tolerates a pasted AIOps URL), persist to .env AND
  // process.env so it applies with no restart (read per-request elsewhere).
  app.post('/api/business-service/persist-key', (req, res) => {
    const key = extractServiceKey(((req.body || {}).key || '').toString());
    if (!key) return res.status(400).json({ error: 'key is required' });
    try {
      upsertEnvVar(envPath, 'BUSINESS_SERVICE_KEY', key);
      env.BUSINESS_SERVICE_KEY = key;
      return res.json({ ok: true, businessServiceKey: key });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to persist key', details: e.message });
    }
  });
}

module.exports = { register };
