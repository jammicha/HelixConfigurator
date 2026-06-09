// backend/__tests__/k8sChart-operator-prereqs.test.mjs
import { describe, it, expect } from 'vitest';
import { CERT_MANAGER_VERSION, OPERATOR_VERSION, prereqCommands } from '../k8sChart/operatorPrereqs.js';

describe('operatorPrereqs', () => {
  it('pins concrete versions (not "latest")', () => {
    expect(CERT_MANAGER_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(OPERATOR_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('prereqCommands references the pinned versions and waits for readiness', () => {
    const c = prereqCommands();
    expect(c.certManager).toContain(`cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`);
    expect(c.operator).toContain(`opentelemetry-operator/releases/download/${OPERATOR_VERSION}/opentelemetry-operator.yaml`);
    expect(c.waitCertManager).toMatch(/kubectl wait.*cert-manager/);
    expect(c.waitOperator).toMatch(/kubectl rollout status/);
    // The deployment the operator manifest creates is named
    // `opentelemetry-operator-controller-manager` (NOT `opentelemetry-operator`);
    // waiting on the wrong name fails with NotFound. Verified live on v0.152.0.
    expect(c.waitOperator).toContain('deploy/opentelemetry-operator-controller-manager');
  });
});
