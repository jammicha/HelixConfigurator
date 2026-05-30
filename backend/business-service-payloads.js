// Pure builders for the guided "link to Business Service" flow. No network, no
// process.env — all inputs passed in, unit-tested in isolation.

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const isPlaceholder = (url) => /\/\/your-tenant\.onbmc\.com\b/i.test(url || '');

// Guided-bind payload: where to go in AIOps, the namespace-overview dashboard to
// eyeball the rollup afterward, and the exact click-path. The dashboard URL
// mirrors the existing OTelNamespaceOverview pattern (helix-link.js / App.tsx).
// Links are '' for the install-bundle placeholder so the UI hides them.
function buildBindInstructions({ endpoint, namespace, xSource = '', tenantId = '' }) {
  const base = stripSlash(endpoint);
  const real = !!base && !isPlaceholder(base);
  const ns = namespace || xSource || '';
  const aiopsUrl = real ? `${base}/aiops/` : '';
  let dashboardUrl = '';
  if (real && ns) {
    const params = new URLSearchParams({
      'var-BusinessService': ns,
      'var-OTelNamespace': ns,
      from: 'now-3h',
      to: 'now',
      timezone: 'browser',
    });
    if (tenantId) params.set('orgId', tenantId);
    dashboardUrl = `${base}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?${params.toString()}`;
  }
  const steps = [
    `Open BMC Helix AIOps${aiopsUrl ? ' (link below)' : ''} and go to Services.`,
    `Create a new Business Service, or open the one this app belongs under. (If X-Source "${xSource}" already auto-created a service, open that one.)`,
    `Edit the service → Add Dynamic content → "Default Blueprint for OTel Service".`,
    `Select the OpenTelemetry namespace "${ns}" (add others if needed), then Save.`,
    `Copy the Business Service's URL from your browser and paste it back here to capture its key.`,
  ];
  return { namespace: ns, steps, aiopsUrl, dashboardUrl };
}

// Accept a bare key, a URL fragment, or a full AIOps URL → the opaque key.
// Mirrors frontend extractServiceKey (otel-data/utils.ts) so paste-back is robust.
function extractServiceKey(input) {
  if (!input) return '';
  const trimmed = String(input).trim();
  const m = trimmed.match(/\/entities\/service\/([^/?#\s]+)/);
  if (m) return m[1];
  return trimmed.split(/[?#\s]/)[0];
}

module.exports = { buildBindInstructions, extractServiceKey };
