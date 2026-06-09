// backend/k8sChart/operatorPrereqs.js
// Pinned, validated prerequisite versions for the OTel-Operator chart path.
// Bump these together after smoke-testing a newer pair. Pinning the Operator
// version transitively pins the default auto-instrumentation agent images
// (we intentionally don't pin those in the Instrumentation CR).
const CERT_MANAGER_VERSION = 'v1.19.5';
const OPERATOR_VERSION = 'v0.152.0';

function prereqCommands() {
  return {
    certManager: `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml`,
    waitCertManager: 'kubectl wait --for=condition=Available --timeout=180s -n cert-manager deploy/cert-manager-webhook',
    operator: `kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/download/${OPERATOR_VERSION}/opentelemetry-operator.yaml`,
    waitOperator: 'kubectl rollout status -n opentelemetry-operator-system deploy/opentelemetry-operator-controller-manager --timeout=180s',
  };
}

module.exports = { CERT_MANAGER_VERSION, OPERATOR_VERSION, prereqCommands };
