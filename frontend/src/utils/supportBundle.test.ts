import { describe, it, expect } from 'vitest';
import { buildSupportBundle, type SupportBundleInput } from './supportBundle';

const base: SupportBundleInput = {
  envVars: {
    HELIX_ENDPOINT: 'https://tenant.onbmc.com',
    HELIX_API_KEY: 'TENANT1::ACCESS::SECRET',
    X_SOURCE: 'my-service',
    BUSINESS_SERVICE_KEY: 'bskey',
  },
  gatewayStatus: 'running',
  collectorDiag: { status: 'PASS' },
  apiKeyDiag: { status: 'PASS' },
  networkDiag: { status: 'Success' },
  liveMetrics: { received: 10, sent: 9, failed: 1 },
  metricsHistory: [],
  timeline: [],
  recentLogs: 'line one\nline two',
};

describe('buildSupportBundle', () => {
  it('redacts the access/secret segments but keeps the tenant id', () => {
    const out = buildSupportBundle(base);
    expect(out).toContain('HELIX_API_KEY: TENANT1::***::***');
    expect(out).not.toContain('ACCESS');
    expect(out).not.toContain('SECRET');
  });

  it('masks BUSINESS_SERVICE_KEY presence without leaking its value', () => {
    expect(buildSupportBundle(base)).toContain('BUSINESS_SERVICE_KEY: (set)');
    expect(buildSupportBundle(base)).not.toContain('bskey');
    const unset = buildSupportBundle({ ...base, envVars: { ...base.envVars, BUSINESS_SERVICE_KEY: '' } });
    expect(unset).toContain('BUSINESS_SERVICE_KEY: (unset)');
  });

  it('falls back to placeholders for empty/odd values', () => {
    const out = buildSupportBundle({
      ...base,
      envVars: { HELIX_ENDPOINT: '', HELIX_API_KEY: '', X_SOURCE: '', BUSINESS_SERVICE_KEY: '' },
      gatewayStatus: '',
    });
    expect(out).toContain('HELIX_ENDPOINT: (unset)');
    expect(out).toContain('HELIX_API_KEY: (unset)');
    expect(out).toContain('X-Source Format: FAIL');
    expect(out).toContain('Container: unknown');
  });

  it('renders per-sample rate deltas (clamped at zero on counter reset)', () => {
    const out = buildSupportBundle({
      ...base,
      metricsHistory: [
        { received: 0, sent: 0, failed: 0 },
        { received: 5, sent: 4, failed: 1 },
        { received: 2, sent: 4, failed: 1 }, // counter reset -> clamps to 0
      ],
    });
    expect(out).toContain('recv/Δ');
    expect(out).toMatch(/1 {7}5 {7}4 {7}1/); // sample 1 deltas
    expect(out).not.toContain('-3'); // reset clamped, no negative delta
  });

  it('notes empty history and timeline', () => {
    const out = buildSupportBundle(base);
    expect(out).toContain('(no rate history available)');
    expect(out).toContain('(no events recorded this session)');
  });
});
