// frontend/src/components/wizard/wizardTargets.test.ts
import { describe, it, expect } from 'vitest';
import {
  getWizardSteps,
  k8sGatewayEndpoint,
  isWizardTarget,
  isWizardTargetOrNull,
  namespacedCommands,
  isK8sTarget,
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

describe('namespacedCommands', () => {
  const base = {
    secretCommand: "kubectl create secret generic helix-key --from-literal=HELIX_API_KEY='K'",
    installCommand: 'helm install helix . --set helix.existingSecret=helix-key',
  };
  it('default/blank namespace: commands unchanged, no create-namespace', () => {
    for (const ns of ['default', '', '   ']) {
      const r = namespacedCommands(ns, base);
      expect(r.createNamespace).toBeNull();
      expect(r.secretCommand).toBe(base.secretCommand);
      expect(r.installCommand).toBe(base.installCommand);
    }
  });
  it('non-default namespace: creates it and adds -n to both commands', () => {
    const r = namespacedCommands('observability', base);
    expect(r.createNamespace).toBe('kubectl create namespace observability');
    expect(r.secretCommand).toBe(`${base.secretCommand} -n observability`);
    expect(r.installCommand).toBe(`${base.installCommand} -n observability`);
  });
  it('trims surrounding whitespace', () => {
    expect(namespacedCommands('  obs ', base).createNamespace).toBe('kubectl create namespace obs');
  });
});

describe('kubernetes-operator target', () => {
  it('is a valid target', () => {
    expect(isWizardTarget('kubernetes-operator')).toBe(true);
    expect(isWizardTargetOrNull('kubernetes-operator')).toBe(true);
  });
  it('has its own step labels (Prereqs & Generate / Annotate)', () => {
    expect(getWizardSteps('kubernetes-operator').map(s => s.label))
      .toEqual(['Configure', 'Prereqs & Generate', 'Annotate', 'Verify', 'Link Service']);
  });
  it('isK8sTarget covers both kubernetes variants, not docker', () => {
    expect(isK8sTarget('kubernetes')).toBe(true);
    expect(isK8sTarget('kubernetes-operator')).toBe(true);
    expect(isK8sTarget('docker')).toBe(false);
  });
});
