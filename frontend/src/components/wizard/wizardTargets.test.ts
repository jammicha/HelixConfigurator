// frontend/src/components/wizard/wizardTargets.test.ts
import { describe, it, expect } from 'vitest';
import {
  getWizardSteps,
  k8sGatewayEndpoint,
  isWizardTarget,
  isWizardTargetOrNull,
} from './wizardTargets';

describe('getWizardSteps', () => {
  it('docker labels', () => {
    expect(getWizardSteps('docker').map(s => s.label))
      .toEqual(['Configure', 'Exporter', 'Connect', 'Verify', 'Link Service']);
  });
  it('kubernetes labels', () => {
    expect(getWizardSteps('kubernetes').map(s => s.label))
      .toEqual(['Configure', 'Generate', 'Point apps', 'Verify', 'Link Service']);
  });
  it('always 5 steps numbered 1..5', () => {
    for (const t of ['docker', 'kubernetes'] as const) {
      const s = getWizardSteps(t);
      expect(s).toHaveLength(5);
      expect(s.map(x => x.n)).toEqual([1, 2, 3, 4, 5]);
    }
  });
});

describe('k8sGatewayEndpoint', () => {
  it('builds the FQDN for a namespace', () => {
    expect(k8sGatewayEndpoint('payments'))
      .toBe('http://helix-gateway.payments.svc.cluster.local:4318');
  });
  it('defaults to the default namespace when empty/blank/missing', () => {
    const expected = 'http://helix-gateway.default.svc.cluster.local:4318';
    expect(k8sGatewayEndpoint()).toBe(expected);
    expect(k8sGatewayEndpoint('')).toBe(expected);
    expect(k8sGatewayEndpoint('   ')).toBe(expected);
  });
  it('trims whitespace', () => {
    expect(k8sGatewayEndpoint('  ns ')).toBe('http://helix-gateway.ns.svc.cluster.local:4318');
  });
});

describe('isWizardTarget / isWizardTargetOrNull', () => {
  it('accepts valid targets', () => {
    expect(isWizardTarget('docker')).toBe(true);
    expect(isWizardTarget('kubernetes')).toBe(true);
  });
  it('rejects junk and null for isWizardTarget', () => {
    expect(isWizardTarget('nomad')).toBe(false);
    expect(isWizardTarget(null)).toBe(false);
    expect(isWizardTarget(3)).toBe(false);
  });
  it('isWizardTargetOrNull accepts null + valid targets, rejects junk', () => {
    expect(isWizardTargetOrNull(null)).toBe(true);
    expect(isWizardTargetOrNull('docker')).toBe(true);
    expect(isWizardTargetOrNull('x')).toBe(false);
  });
});
