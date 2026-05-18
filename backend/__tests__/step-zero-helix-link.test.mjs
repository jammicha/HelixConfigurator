import { describe, it, expect } from 'vitest';
import { buildHelixServiceMapLink } from '../routes/step-zero/helix-link.js';

describe('buildHelixServiceMapLink', () => {
  it('returns null when HELIX_ENDPOINT is missing', () => {
    expect(buildHelixServiceMapLink({})).toBe(null);
    expect(buildHelixServiceMapLink({ HELIX_ENDPOINT: '' })).toBe(null);
  });

  it('returns null when HELIX_ENDPOINT is the placeholder', () => {
    expect(buildHelixServiceMapLink({
      HELIX_ENDPOINT: 'https://your-tenant.onbmc.com',
      X_SOURCE: 'demo',
    })).toBe(null);
  });

  it('builds the namespace-overview URL with X_SOURCE as namespace', () => {
    const url = buildHelixServiceMapLink({
      HELIX_ENDPOINT: 'https://helixdemo.onbmc.com/',
      X_SOURCE: 'step-zero-demo',
      HELIX_API_KEY: '1234567890::AKEY::SKEY',
    });
    expect(url).toContain('https://helixdemo.onbmc.com');
    expect(url).toContain('/dashboards/d/OTelNamespaceOverview/otel-namespace-overview');
    expect(url).toContain('var-OTelNamespace=step-zero-demo');
    expect(url).toContain('var-BusinessService=step-zero-demo');
    expect(url).toContain('orgId=1234567890');
    expect(url).not.toMatch(/\/\/\/dashboards/); // trailing slash stripped
  });

  it('falls back to X_SOURCE when HELIX_API_KEY is missing or malformed', () => {
    const url = buildHelixServiceMapLink({
      HELIX_ENDPOINT: 'https://helixdemo.onbmc.com',
      X_SOURCE: 'demo',
    });
    // No orgId param when tenantId can't be extracted.
    expect(url).toContain('/dashboards/d/OTelNamespaceOverview');
    expect(url).not.toContain('orgId=');
  });
});
