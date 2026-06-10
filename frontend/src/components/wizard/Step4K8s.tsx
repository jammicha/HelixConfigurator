import React from 'react';
import { Hexagon, ExternalLink, ArrowRight } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';

type Props = {
  otelDashboardUrl: string | null;
  namespace: string;
  engine?: 'deployment' | 'operator';
  clusterTarget?: 'local' | 'remote';
  onBack: () => void;
  onFinishStep: () => void;
};

// Kubernetes Step 4 — "Verify": generate-only can't read the user's cluster, so
// this is guidance (kubectl + the built-in viewer) plus the universal "see it in
// Helix" deep-link. No live counters, nothing gates leaving the step.
//
// The chart is gateway-only: on local clusters the gateway loops telemetry back
// to this app (host.docker.internal:8765), so the viewer "just works" with no
// port-forward and no extra Service — mirror of the Docker experience.
export const Step4K8s: React.FC<Props> = ({ otelDashboardUrl, namespace, engine = 'deployment', clusterTarget = 'local', onBack, onFinishStep }) => {
  // Pod label differs per engine: the Deployment chart labels its gateway pod
  // component=gateway; Operator-managed collector pods carry the Operator's
  // component=opentelemetry-collector.
  const podLabel = engine === 'operator'
    ? 'app.kubernetes.io/component=opentelemetry-collector'
    : 'app.kubernetes.io/component=gateway';
  const walkthroughHref = engine === 'operator' ? '/k8s-operator-walkthrough.html' : '/k8s-walkthrough.html#verify';
  const ns = namespace.trim() || 'default';
  // The Operator names the Deployment <cr>-collector; the manual chart is just
  // helix-gateway.
  const gatewayDeploy = engine === 'operator' ? 'deploy/helix-gateway-collector' : 'deploy/helix-gateway';
  return (
    <div className="adapt-card">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h2 className="text-lg font-semibold text-gray-200">Step 4: Verify telemetry is flowing</h2>
        <a
          href={walkthroughHref}
          target="_blank" rel="noopener noreferrer"
          className="text-tiny text-[#8b7cf6] hover:underline whitespace-nowrap mt-1 flex-shrink-0"
        >Full walkthrough ↗</a>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        The configurator generated the chart but doesn&apos;t reach into your cluster — verify from your own{' '}
        <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">kubectl</code> and in Helix.
      </p>

      <div className="space-y-5">
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">1 · Gateway pods are up</p>
          <SnippetBlock text={`kubectl get pods -l ${podLabel} -n ${ns}`} />
        </div>
        {clusterTarget === 'remote' ? (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">2 · Telemetry is leaving the cluster</p>
            <p className="text-tiny text-gray-500 mb-2">
              Your chart sends telemetry to Helix only — the local viewer can&apos;t be reached from a remote cluster,
              so the place to see your data is Helix (step 3). Gateway-side, the exporter logs confirm data is flowing out:
            </p>
            <SnippetBlock text={`kubectl logs ${gatewayDeploy} -n ${ns} --tail=20`} />
          </div>
        ) : (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">2 · Watch it locally</p>
            <p className="text-tiny text-gray-500 mb-2">
              On a local cluster the gateway automatically sends a copy of your telemetry back to this app — no
              port-forward, no extra Service. Just open the built-in viewer, the same one the Docker setup uses:
            </p>
            <a href="/otel-data" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-link hover:underline text-sm font-semibold">
              <ExternalLink className="w-4 h-4" /> Open View OTel Data
            </a>
          </div>
        )}
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
        <span>Generate-only: the configurator can&apos;t read your cluster&apos;s gateway counters, so these checks run on your side.</span>
      </div>

      <div className="flex gap-4 mt-6">
        <button onClick={onBack} className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm">Back</button>
        <button onClick={onFinishStep} className="flex-1 bg-success hover:bg-success-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm flex items-center justify-center gap-2">Next: Link your service <ArrowRight className="w-4 h-4" /></button>
      </div>
    </div>
  );
};
