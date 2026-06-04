import React, { useState } from 'react';
import { SnippetBlock } from '../SnippetBlock';
import { NamespaceRecipe } from './NamespaceRecipe';
import { k8sGatewayEndpoint } from './wizardTargets';

type Props = { onBack: () => void; onNext: () => void };

// Kubernetes Step 3 — "Point apps": point instrumented apps (or the user's own
// collector) at the gateway's in-cluster Service DNS. No Docker socket, no
// bridging — a Service gives the gateway a stable DNS name.
export const Step3K8s: React.FC<Props> = ({ onBack, onNext }) => {
  const [namespace, setNamespace] = useState('default');
  const endpoint = k8sGatewayEndpoint(namespace);
  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 3: Point your apps at the gateway</h2>
      <p className="text-sm text-gray-400 mb-4">
        Once the chart is installed, the gateway is reachable in-cluster at its Service DNS name. Point your
        instrumented apps (or your own collector) at it.
      </p>

      <div className="mb-4">
        <label htmlFor="k8s-namespace" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Gateway namespace</label>
        <input
          id="k8s-namespace"
          type="text"
          value={namespace}
          onChange={e => setNamespace(e.target.value)}
          spellCheck={false}
          className="mt-1 w-full max-w-xs bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 text-sm focus:outline-none focus:border-link block"
          placeholder="default"
        />
        <p className="text-tiny text-gray-500 mt-1">The namespace you <code className="font-mono">helm install</code>ed into (the <code className="font-mono">-n</code> flag).</p>
      </div>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Option A · App sends OTLP directly</p>
      <SnippetBlock text={`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`} />
      <p className="text-tiny text-gray-500 -mt-4 mb-5">
        Set this on your app&apos;s Deployment. Apps in the gateway&apos;s own namespace can use the short form{' '}
        <code className="font-mono">http://helix-gateway:4318</code>.
      </p>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Option B · You run your own collector</p>
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
