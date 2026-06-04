import React from 'react';
import { Hexagon, ExternalLink, ArrowRight } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';

type Props = {
  otelDashboardUrl: string | null;
  onBack: () => void;
  onFinishStep: () => void;
};

// Kubernetes Step 4 — "Verify": generate-only can't read the user's cluster, so
// this is guidance (kubectl / port-forward) plus the universal "see it in Helix"
// deep-link. No live counters, nothing gates leaving the step.
export const Step4K8s: React.FC<Props> = ({ otelDashboardUrl, onBack, onFinishStep }) => (
  <div className="adapt-card">
    <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 4: Verify telemetry is flowing</h2>
    <p className="text-sm text-gray-400 mb-4">
      The configurator generated the chart but doesn&apos;t reach into your cluster — verify from your own{' '}
      <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">kubectl</code> and in Helix.
    </p>

    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">1 · Gateway pods are up</p>
        <SnippetBlock text={`kubectl get pods -l app.kubernetes.io/part-of=helix-otel -n <namespace>`} />
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">2 · Watch it locally (if you included the viewer)</p>
        <SnippetBlock text={`kubectl port-forward svc/helix-viewer 3001:3001 -n <namespace>`} />
        <p className="text-tiny text-gray-500 -mt-4">Then open <code className="font-mono">http://localhost:3001/otel-data</code>.</p>
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">3 · See it in Helix</p>
        {otelDashboardUrl ? (
          <a href={otelDashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-link hover:underline text-sm font-semibold">
            <ExternalLink className="w-4 h-4" /> Open the OTel namespace dashboard
          </a>
        ) : (
          <p className="text-tiny text-gray-500">Set a real Helix endpoint in Step 1 to get a dashboard deep-link.</p>
        )}
      </div>
    </div>

    <div className="mt-5 flex items-start gap-3 p-2.5 rounded border border-primary/40 bg-primary/10 text-tiny text-gray-300">
      <Hexagon className="w-3.5 h-3.5 text-link flex-shrink-0 mt-0.5" />
      <span>Generate-only: the configurator can&apos;t read your cluster&apos;s gateway counters, so these checks run on your side. Live in-cluster verification is on the roadmap.</span>
    </div>

    <div className="flex gap-4 mt-6">
      <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
      <button onClick={onFinishStep} className="flex-1 bg-success hover:bg-success-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm flex items-center justify-center gap-2">Next: Link your service <ArrowRight className="w-4 h-4" /></button>
    </div>
  </div>
);
