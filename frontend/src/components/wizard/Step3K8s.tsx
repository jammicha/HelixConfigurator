import React from 'react';
import { SnippetBlock } from '../SnippetBlock';
import { NamespaceRecipe } from './NamespaceRecipe';
import { k8sGatewayEndpoint } from './wizardTargets';

type Props = { namespace: string; onBack: () => void; onNext: () => void };

// Kubernetes Step 3 — "Point apps": point instrumented apps (or the user's own
// collector) at the gateway's in-cluster Service DNS. No Docker socket, no
// bridging — a Service gives the gateway a stable DNS name. The namespace lifts
// to App state so Step 4's kubectl commands show the same value.
export const Step3K8s: React.FC<Props> = ({ namespace, onBack, onNext }) => {
  const endpoint = k8sGatewayEndpoint(namespace);
  const ns = namespace.trim() || 'default';
  return (
    <div className="adapt-card">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h2 className="text-lg font-semibold text-gray-200">Step 3: Point your apps at the gateway</h2>
        <a
          href="/k8s-walkthrough.html#point"
          target="_blank" rel="noopener noreferrer"
          className="text-tiny text-[#8b7cf6] hover:underline whitespace-nowrap mt-1 flex-shrink-0"
        >Full walkthrough ↗</a>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        Once the chart is installed, the gateway is reachable in-cluster at its Service DNS name. Point your
        own collector (or your apps directly) at it.
      </p>

      <div className="mb-4 p-2.5 rounded border border-gray-800 bg-gray-1000/50">
        <p className="text-tiny text-gray-400 mb-1">First, confirm the gateway came up in Step 2 — apps can&apos;t reach a Service with no running pods behind it (namespace <code className="font-mono">{ns}</code>, from the Generate step):</p>
        <SnippetBlock text={`kubectl get pods -l app.kubernetes.io/component=gateway -n ${ns}`} />
      </div>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Option A · You run your own collector</p>
      <SnippetBlock text={`exporters:
  otlphttp/helix_gateway:
    endpoint: "${endpoint}"
    tls:
      insecure: true

service:
  pipelines:
    traces:  { exporters: [..., otlphttp/helix_gateway] }
    metrics: { exporters: [..., otlphttp/helix_gateway] }
    logs:    { exporters: [..., otlphttp/helix_gateway] }`} />
      <p className="text-tiny text-gray-500 -mt-4 mb-5">
        Add to your collector&apos;s ConfigMap, then <code className="font-mono">kubectl rollout restart deployment/&lt;your-collector&gt;</code>.
      </p>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Option B · App sends OTLP directly</p>
      <SnippetBlock text={`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`} />
      <p className="text-tiny text-gray-500 -mt-4 mb-5">
        Set this on your app&apos;s Deployment. Apps in the gateway&apos;s own namespace can use the short form{' '}
        <code className="font-mono">http://helix-gateway:4318</code>.
      </p>

      <NamespaceRecipe
        extraNote={<>If you can&apos;t set env vars on the app, add a <code className="font-mono">resource</code> processor to your collector&apos;s ConfigMap instead.</>}
      />

      <div className="flex gap-4">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
        <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Verify →</button>
      </div>
    </div>
  );
};
