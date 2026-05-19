// Build the Helix Namespace Overview dashboard URL — the "service map for
// my namespace" surface the user wants to land on after a Layer 2 run.
//
// Mirrors the URL pattern already used in frontend/src/App.tsx (line 1845).
// Returns null when env isn't ready, so callers can hide the deep-link
// affordance cleanly.
const isPlaceholderEndpoint = (url) => /\/\/your-tenant\.onbmc\.com\b/i.test(url || '');

// HELIX_API_KEY format is `TenantID::AccessKey::SecretKey`. Tenant ID is
// the first colon-separated segment.
const extractTenantId = (apiKey) => {
  if (typeof apiKey !== 'string') return null;
  const parts = apiKey.split('::');
  if (parts.length !== 3) return null;
  const t = parts[0].trim();
  return t || null;
};

const buildHelixServiceMapLink = (env) => {
  if (!env || typeof env !== 'object') return null;
  const endpoint = env.HELIX_ENDPOINT;
  if (!endpoint || isPlaceholderEndpoint(endpoint)) return null;
  const baseUrl = String(endpoint).replace(/\/$/, '');
  const source = env.X_SOURCE || 'Helix-Configurator-Demo';
  const tenantId = extractTenantId(env.HELIX_API_KEY);

  const params = new URLSearchParams({
    'var-BusinessService': source,
    'var-OTelNamespace': source,
    from: 'now-3h',
    to: 'now',
    timezone: 'browser',
  });
  if (tenantId) params.set('orgId', tenantId);

  return `${baseUrl}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?${params.toString()}`;
};

module.exports = { buildHelixServiceMapLink };
