import React from 'react';
import { Boxes } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';
import { K8sChartPanel } from '../K8sChartPanel';

type Props = { namespace: string; onNamespaceChange: (ns: string) => void; onBack: () => void; onNext: () => void };

// Kubernetes (Operator) Step 2 — install the OTel Operator prerequisites, then
// generate the CR chart. Reuses K8sChartPanel in operator mode.
export const Step2K8sOperator: React.FC<Props> = ({ namespace, onNamespaceChange, onBack, onNext }) => (
  <div className="adapt-card">
    <div className="flex items-start justify-between gap-3 mb-2">
      <h2 className="text-lg font-semibold text-gray-200">Step 2: Install prerequisites &amp; generate</h2>
      <a href="/k8s-operator-walkthrough.html#prereqs" target="_blank" rel="noopener noreferrer"
         className="text-tiny text-[#8b7cf6] hover:underline whitespace-nowrap mt-1 flex-shrink-0">Full walkthrough ↗</a>
    </div>

    <div className="mb-4 p-3 rounded border border-primary/40 bg-primary/10">
      <div className="flex items-center gap-2 mb-2">
        <Boxes className="w-4 h-4 text-link" />
        <span className="text-sm font-semibold text-gray-100">One-time prerequisites</span>
      </div>
      <p className="text-tiny text-gray-400 mb-2">
        This chart deploys <code className="font-mono">OpenTelemetryCollector</code> and{' '}
        <code className="font-mono">Instrumentation</code> custom resources, so the cluster needs the
        OpenTelemetry Operator (and cert-manager) first. Run these once per cluster (cluster-admin):
      </p>
      <SnippetBlock text={`# 1. cert-manager (the Operator's webhook certs)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.19.5/cert-manager.yaml
kubectl wait --for=condition=Available --timeout=180s -n cert-manager deploy/cert-manager-webhook

# 2. OpenTelemetry Operator
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/download/v0.152.0/opentelemetry-operator.yaml
kubectl rollout status -n opentelemetry-operator-system deploy/opentelemetry-operator --timeout=180s`} />
      <p className="text-tiny text-gray-500">Already run the Operator? Skip straight to generating the chart.</p>
    </div>

    <p className="text-sm text-gray-400 mb-4">Then generate the chart, pre-wired to Helix, and <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">helm install</code> it:</p>
    <K8sChartPanel namespace={namespace} onNamespaceChange={onNamespaceChange} engine="operator" />

    <div className="flex gap-4 mt-6">
      <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
      <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Annotate pods →</button>
    </div>
  </div>
);
