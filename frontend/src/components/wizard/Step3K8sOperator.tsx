import React from 'react';
import { Hexagon } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';
import { NamespaceRecipe } from './NamespaceRecipe';

type Props = { namespace: string; onBack: () => void; onNext: () => void };

const ANNOTATIONS: { lang: string; label: string; key: string }[] = [
  { lang: 'java', label: 'Java', key: 'inject-java' },
  { lang: 'nodejs', label: 'Node.js', key: 'inject-nodejs' },
  { lang: 'python', label: 'Python', key: 'inject-python' },
  { lang: 'dotnet', label: '.NET', key: 'inject-dotnet' },
];

// Kubernetes (Operator) Step 3 — annotate pods so the Operator injects the agent.
// No app code changes; the agent is added on the next pod restart.
export const Step3K8sOperator: React.FC<Props> = ({ namespace, onBack, onNext }) => {
  const ns = namespace.trim() || 'default';
  return (
    <div className="adapt-card">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h2 className="text-lg font-semibold text-gray-200">Step 3: Annotate your pods (zero code changes)</h2>
        <a href="/k8s-operator-walkthrough.html#annotate" target="_blank" rel="noopener noreferrer"
           className="text-tiny text-[#8b7cf6] hover:underline whitespace-nowrap mt-1 flex-shrink-0">Full walkthrough ↗</a>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        Add a pod-template annotation to your app&apos;s Deployment. The Operator injects the language
        agent via an init container on the next rollout — no changes to your app image or code.
      </p>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Annotation per runtime</p>
      <SnippetBlock text={ANNOTATIONS.map(a => `instrumentation.opentelemetry.io/${a.key}: "${ns}/helix-instrumentation"   # ${a.label}`).join('\n')} />
      <p className="text-tiny text-gray-500 -mt-4 mb-4">
        The value is <code className="font-mono">&lt;namespace&gt;/helix-instrumentation</code> (the Instrumentation
        CR lives in <code className="font-mono">{ns}</code>, where you installed the chart). If your app runs in
        that same namespace, <code className="font-mono">&quot;true&quot;</code> works too.
      </p>

      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Apply &amp; roll out (example: a Java Deployment)</p>
      <SnippetBlock text={`kubectl patch deployment <app> -n <app-ns> -p \\
  '{"spec":{"template":{"metadata":{"annotations":{"instrumentation.opentelemetry.io/inject-java":"${ns}/helix-instrumentation"}}}}}'
# the rollout restarts pods; the Operator injects the agent as they come back up`} />

      <div className="mb-4 mt-2 flex items-start gap-3 p-2.5 rounded border border-gray-800 bg-gray-1000/50 text-tiny text-gray-400">
        <Hexagon className="w-3.5 h-3.5 text-link flex-shrink-0 mt-0.5" />
        <span>Prefer not to annotate? Apps can still send OTLP straight to the gateway:{' '}
          <code className="font-mono">OTEL_EXPORTER_OTLP_ENDPOINT=http://helix-gateway.{ns}.svc.cluster.local:4318</code>.</span>
      </div>

      <NamespaceRecipe extraNote={<>Auto-instrumentation reads <code className="font-mono">OTEL_RESOURCE_ATTRIBUTES</code> too — set them on the app the same way.</>} />

      <div className="flex gap-4">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
        <button onClick={onNext} className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm">Next: Verify →</button>
      </div>
    </div>
  );
};
