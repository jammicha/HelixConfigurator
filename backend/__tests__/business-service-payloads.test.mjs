import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildBindInstructions, extractServiceKey, collapseNamespaces } = require('../business-service-payloads');

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
    // Blueprint label + docs URL ride along so the UI can linkify the exact
    // phrase in step 3 without matching a magic string.
    expect(r.blueprintLabel).toBe('Default Blueprint for OTel Service');
    expect(r.steps[2]).toContain(r.blueprintLabel);
    expect(r.blueprintDocsUrl).toMatch(/^https:\/\/docs\.helixops\.ai\/.*#configureCollector$/);
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

describe('collapseNamespaces', () => {
  it('merges the X-Source fallback bucket into a matching namespace, summing counts and taking the newer lastSeen', () => {
    const rows = [
      { namespace: 'hotrod', traceCount: 496, lastSeen: 10 },
      { namespace: null, traceCount: 4, lastSeen: 20 },
    ];
    expect(collapseNamespaces(rows, 'hotrod')).toEqual([
      { namespace: 'hotrod', traceCount: 500, lastSeen: 20, fallback: false },
    ]);
  });

  it('keeps the fallback row when X-Source matches no existing namespace', () => {
    const rows = [
      { namespace: 'shop', traceCount: 3, lastSeen: 2 },
      { namespace: null, traceCount: 1, lastSeen: 1 },
    ];
    expect(collapseNamespaces(rows, 'fallback-src')).toEqual([
      { namespace: 'shop', traceCount: 3, lastSeen: 2, fallback: false },
      { namespace: 'fallback-src', traceCount: 1, lastSeen: 1, fallback: true },
    ]);
  });

  it('passes explicit namespaces through untouched when there is no un-namespaced bucket', () => {
    const rows = [{ namespace: 'a', traceCount: 5, lastSeen: 3 }];
    expect(collapseNamespaces(rows, 'hotrod')).toEqual([
      { namespace: 'a', traceCount: 5, lastSeen: 3, fallback: false },
    ]);
  });

  it('re-sorts by lastSeen desc after merging (merged count, newer lastSeen wins position)', () => {
    const rows = [
      { namespace: 'hotrod', traceCount: 496, lastSeen: 5 },
      { namespace: 'payments', traceCount: 200, lastSeen: 9 },
      { namespace: null, traceCount: 4, lastSeen: 7 },
    ];
    expect(collapseNamespaces(rows, 'hotrod')).toEqual([
      { namespace: 'payments', traceCount: 200, lastSeen: 9, fallback: false },
      { namespace: 'hotrod', traceCount: 500, lastSeen: 7, fallback: false },
    ]);
  });

  it('trims X-Source before matching', () => {
    const rows = [
      { namespace: 'hotrod', traceCount: 496, lastSeen: 10 },
      { namespace: null, traceCount: 4, lastSeen: 20 },
    ];
    expect(collapseNamespaces(rows, '  hotrod  ')).toEqual([
      { namespace: 'hotrod', traceCount: 500, lastSeen: 20, fallback: false },
    ]);
  });

  it('leaves the un-namespaced bucket as an empty-named fallback row when X-Source is unset (out of scope, no merge)', () => {
    const rows = [
      { namespace: 'a', traceCount: 5, lastSeen: 3 },
      { namespace: null, traceCount: 2, lastSeen: 1 },
    ];
    expect(collapseNamespaces(rows, '')).toEqual([
      { namespace: 'a', traceCount: 5, lastSeen: 3, fallback: false },
      { namespace: '', traceCount: 2, lastSeen: 1, fallback: true },
    ]);
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
