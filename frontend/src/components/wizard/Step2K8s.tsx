import React from 'react';
import { K8sChartPanel, type ClusterTarget } from '../K8sChartPanel';

type Props = {
  namespace: string; onNamespaceChange: (ns: string) => void;
  clusterTarget: ClusterTarget; onClusterTargetChange: (t: ClusterTarget) => void;
  onBack: () => void; onNext: () => void;
};

// Kubernetes Step 2 — "Generate": stand up the gateway by generating and
// helm-installing the chart. Reuses the shared K8sChartPanel; the next step
// points apps at the now-existing Service.
export const Step2K8s: React.FC<Props> = ({ namespace, onNamespaceChange, clusterTarget, onClusterTargetChange, onBack, onNext }) => (
  <div className="adapt-card">
    <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 2: Generate your Kubernetes deployment</h2>
    <p className="text-sm text-gray-400 mb-4">
      Download a self-contained Helm chart, pre-wired to Helix from the credentials you just saved, and{' '}
      <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">helm install</code> it in your cluster. You can
      install now or come back to it — the next step shows your apps where to send telemetry.
    </p>
    <K8sChartPanel namespace={namespace} onNamespaceChange={onNamespaceChange} clusterTarget={clusterTarget} onClusterTargetChange={onClusterTargetChange} />
    <div className="flex gap-4 mt-6">
      <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
      <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Point apps →</button>
    </div>
  </div>
);
