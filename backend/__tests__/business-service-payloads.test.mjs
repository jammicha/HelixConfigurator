import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildBindInstructions, extractServiceKey } = require('../business-service-payloads');

describe('buildBindInstructions', () => {
  it('builds the AIOps link, namespace-overview dashboard URL, and a 5-step checklist', () => {
    const r = buildBindInstructions({ endpoint: 'https://acme.onbmc.com/', namespace: 'checkout', xSource: 'src', tenantId: 'T1' });
    expect(r.aiopsUrl).toBe('https://acme.onbmc.com/aiops/');
    const d = new URL(r.dashboardUrl);
    expect(d.pathname).toBe('/dashboards/d/OTelNamespaceOverview/otel-namespace-overview');
    expect(d.searchParams.get('var-OTelNamespace')).toBe('checkout');
    expect(d.searchParams.get('orgId')).toBe('T1');
    expect(r.steps).toHaveLength(5);
    expect(r.steps[2]).toContain('Default Blueprint for OTel Service');
    expect(r.steps[3]).toContain('checkout');
    expect(r.steps[4]).toContain('paste it back');
  });
  it('falls back to X_SOURCE when namespace is empty', () => {
    const r = buildBindInstructions({ endpoint: 'https://acme.onbmc.com', namespace: '', xSource: 'fallback-src' });
    expect(r.namespace).toBe('fallback-src');
    expect(new URL(r.dashboardUrl).searchParams.get('var-OTelNamespace')).toBe('fallback-src');
  });
  it('returns empty links (steps still present) for the placeholder/empty endpoint', () => {
    const r = buildBindInstructions({ endpoint: 'https://your-tenant.onbmc.com', namespace: 'shop' });
    expect(r.aiopsUrl).toBe('');
    expect(r.dashboardUrl).toBe('');
    expect(r.steps).toHaveLength(5);
  });
});

describe('extractServiceKey', () => {
  it('pulls the key from a full AIOps entity URL', () => {
    expect(extractServiceKey('https://acme.onbmc.com/aiops/#/entities/service/RE-9?type=key')).toBe('RE-9');
  });
  it('returns a bare key untouched and trims query/whitespace', () => {
    expect(extractServiceKey('  RE-9  ')).toBe('RE-9');
    expect(extractServiceKey('RE-9?type=key')).toBe('RE-9');
    expect(extractServiceKey('')).toBe('');
  });
});
