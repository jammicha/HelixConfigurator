// frontend/src/components/wizard/wizardTargets.ts
// Pure helpers for the target-branched onboarding wizard. The `target`
// (docker | kubernetes) is chosen on the selector screen and drives per-step
// labels and the Kubernetes Service-DNS endpoint. Dependency-free + pure so it's
// unit-tested (the TDD core of this round).

export type WizardTarget = 'docker' | 'kubernetes';

export function isWizardTarget(v: unknown): v is WizardTarget {
  return v === 'docker' || v === 'kubernetes';
}

// localStorage validator: null (no choice yet) or a valid target.
export function isWizardTargetOrNull(v: unknown): v is WizardTarget | null {
  return v === null || isWizardTarget(v);
}

export type WizardStep = { n: number; label: string };

const DOCKER_STEPS: WizardStep[] = [
  { n: 1, label: 'Configure' },
  { n: 2, label: 'Exporter' },
  { n: 3, label: 'Connect' },
  { n: 4, label: 'Verify' },
  { n: 5, label: 'Link Service' },
];

const KUBERNETES_STEPS: WizardStep[] = [
  { n: 1, label: 'Configure' },
  { n: 2, label: 'Generate' },
  { n: 3, label: 'Point apps' },
  { n: 4, label: 'Verify' },
  { n: 5, label: 'Link Service' },
];

export function getWizardSteps(target: WizardTarget): WizardStep[] {
  return target === 'kubernetes' ? KUBERNETES_STEPS : DOCKER_STEPS;
}

// The in-cluster OTLP/HTTP endpoint apps use to reach the gateway Service. The
// Phase 1 chart names the Service `helix-gateway` (stable, release-independent),
// so the FQDN is helix-gateway.<ns>.svc.cluster.local:4318. Apps in the gateway's
// own namespace can use the short form http://helix-gateway:4318.
export function k8sGatewayEndpoint(namespace: string = 'default'): string {
  const ns = (namespace || 'default').trim() || 'default';
  return `http://helix-gateway.${ns}.svc.cluster.local:4318`;
}
