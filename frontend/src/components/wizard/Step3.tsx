import React from 'react';
import { Check, CheckCircle2, AlertTriangle, Hexagon, X } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';

export type DetectedCollector = {
  name: string;
  image: string;
  networks: string[];
  sharesNetworkWithSidecar: boolean;
  isKubernetes?: boolean;
};

export type BridgeStatus =
  | { kind: 'success'; network: string; targetContainer: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; reason: string }
  | null;

type Props = {
  bridgeStatus: BridgeStatus;
  tab: 'detected' | 'manual';
  setTab: (tab: 'detected' | 'manual') => void;
  detectedCollectors: DetectedCollector[];
  attachingNetwork: string | null;
  attachResult: { network: string; ok: boolean; message: string } | null;
  onAttachNetwork: (network: string) => void;
  k8sApplying: boolean;
  k8sApplyResult: 'applied' | 'failed' | null;
  onApplyK8sTemplate: () => void;
  onBack: () => void;
  onNext: () => void;
};

export const Step3: React.FC<Props> = ({
  bridgeStatus,
  tab,
  setTab,
  detectedCollectors,
  attachingNetwork,
  attachResult,
  onAttachNetwork,
  k8sApplying,
  k8sApplyResult,
  onApplyK8sTemplate,
  onBack,
  onNext,
}) => {
  const k8sDetected = detectedCollectors.some(c => c.isKubernetes);
  const someoneAttached = detectedCollectors.some(c => c.sharesNetworkWithSidecar);

  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 3: Connect your collector to <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">helix-bridge</code></h2>
      <p className="text-sm text-gray-400 mb-4">helix-gateway and your collector need to share a Docker network.</p>

      {bridgeStatus?.kind === 'success' && (
        <div className="mb-4 flex items-start gap-3 p-3 bg-success/10 border border-success/40 rounded text-sm">
          <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
          <span className="text-gray-200"><span className="font-semibold">helix-gateway was automatically attached to your app's network.</span> It joined <code className="font-mono">{bridgeStatus.network}</code> (matched container <code className="font-mono">{bridgeStatus.targetContainer}</code>).</span>
        </div>
      )}
      {bridgeStatus?.kind === 'error' && (
        <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-gray-200"><span className="font-semibold">Auto-attach failed: </span>{bridgeStatus.reason}. Use the controls below to connect manually.</span>
        </div>
      )}

      {!someoneAttached && (
        <div className="flex border-b border-gray-800 mb-4 -mb-px">
          <button
            onClick={() => setTab('detected')}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'detected' ? 'border-active text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >Detected on this host</button>
          <button
            onClick={() => setTab('manual')}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'manual' ? 'border-active text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >Manual</button>
        </div>
      )}

      {!someoneAttached && tab === 'detected' && (
        <div className="mt-2">
          {k8sDetected && (
            <div className="mb-4 flex items-start gap-3 p-3 bg-primary/10 border border-primary/40 rounded text-sm">
              <Hexagon className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold text-gray-100 mb-1">Kubernetes detected</div>
                <p className="text-tiny text-gray-300">
                  Apply the K8s Attribute Enrichment template to auto-enrich telemetry with pod, namespace &amp; node metadata.
                </p>
              </div>
              <button
                onClick={onApplyK8sTemplate}
                disabled={k8sApplying || k8sApplyResult === 'applied'}
                className={`flex-shrink-0 px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider transition-colors ${
                  k8sApplyResult === 'applied'
                    ? 'bg-success/20 text-success border border-success/40 cursor-default'
                    : 'bg-primary hover:bg-primary-hover text-white disabled:opacity-60'
                }`}
              >
                {k8sApplying
                  ? 'Applying…'
                  : k8sApplyResult === 'applied'
                    ? (<><Check className="w-3.5 h-3.5 inline" aria-hidden="true" /> Applied</>)
                    : 'Apply template'}
              </button>
            </div>
          )}
          {k8sApplyResult === 'failed' && (
            <div className="mb-3 text-tiny text-danger inline-flex items-center gap-1.5"><X className="w-3.5 h-3.5" aria-hidden="true" /> Could not apply template — retry or apply it from the YAML editor on the dashboard.</div>
          )}

          {detectedCollectors.length === 0 ? (
            <div className="p-4 text-center text-tiny text-gray-500 border border-gray-800 rounded bg-gray-1000">
              No OTel collector containers detected on this host yet. Switch to the <button onClick={() => setTab('manual')} className="text-active hover:underline font-semibold">Manual</button> tab to attach by network name.
            </div>
          ) : (
            <div className="space-y-2">
              {detectedCollectors.map(c => {
                const attachable = c.networks.filter(n => n !== 'helix-bridge');
                const reachable = c.sharesNetworkWithSidecar;
                return (
                  <div key={c.name} className="flex items-start justify-between gap-3 p-3 bg-gray-1000 border border-gray-800 rounded">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className="text-gray-200 font-mono text-sm truncate">{c.name}</span>
                        {c.isKubernetes && (
                          <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/20 text-primary inline-flex items-center gap-1">
                            <Hexagon className="w-2.5 h-2.5" />k8s
                          </span>
                        )}
                        {reachable ? (
                          <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-success/20 text-success">reachable</span>
                        ) : (
                          <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/20 text-warning">not reachable</span>
                        )}
                      </div>
                      <div className="text-tiny text-gray-500 truncate" title={c.image}>
                        {c.image}{attachable.length ? ` • on ${attachable.join(', ')}` : ''}
                      </div>
                    </div>
                    {reachable ? (
                      <span className="px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-success/20 text-success border border-success/40">Attached</span>
                    ) : attachable.length === 0 ? (
                      <span className="text-tiny text-gray-500 self-center">no user networks</span>
                    ) : attachable.length === 1 ? (
                      <button
                        onClick={() => onAttachNetwork(attachable[0])}
                        disabled={attachingNetwork === attachable[0]}
                        className="px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-primary hover:bg-primary-hover disabled:opacity-60 text-white"
                      >
                        {attachingNetwork === attachable[0] ? 'Attaching…' : 'Attach'}
                      </button>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {attachable.map(n => (
                          <button
                            key={n}
                            onClick={() => onAttachNetwork(n)}
                            disabled={attachingNetwork === n}
                            className="px-2 py-1 text-tiny rounded bg-primary hover:bg-primary-hover disabled:opacity-60 text-white font-semibold"
                          >
                            {attachingNetwork === n ? '…' : `Attach to ${n}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {attachResult && (
                <div className={`text-tiny inline-flex items-center gap-1.5 ${attachResult.ok ? 'text-success' : 'text-danger'}`}>
                  {attachResult.ok
                    ? <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    : <X className="w-3.5 h-3.5" aria-hidden="true" />}
                  {attachResult.message}
                </div>
              )}
            </div>
          )}
          <p className="text-tiny text-gray-500 mt-3">After attaching, restart your collector so helix-gateway resolves.</p>
        </div>
      )}

      {!someoneAttached && tab === 'manual' && (
        <div className="mt-2 space-y-4">
          <div>
            <p className="text-tiny text-gray-400 mb-2 font-semibold uppercase tracking-wider">Option A — attach helix-gateway to your app's network</p>
            <SnippetBlock text="docker network connect <your-network> helix-gateway" />
            <p className="text-tiny text-gray-500 -mt-4">
              Replace <code className="font-mono">&lt;your-network&gt;</code> with your compose network name.
            </p>
          </div>
          <div>
            <p className="text-tiny text-gray-400 mb-2 font-semibold uppercase tracking-wider">Option B — attach your container to helix-bridge</p>
            <SnippetBlock text="docker network connect helix-bridge <your-container>" />
          </div>
          <p className="text-tiny text-gray-500">Then restart your container.</p>
        </div>
      )}

      {someoneAttached && (
        <div className="mt-4 flex items-start gap-3 p-2.5 bg-success/10 border border-success/40 rounded text-tiny text-gray-300">
          <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
          <span>
            <span className="font-semibold text-gray-100">helix-gateway is already on a network with a detected collector.</span>{' '}
            You can continue to Verify.
          </span>
        </div>
      )}
      <div className="mt-6 flex gap-4">
        <button
          onClick={onBack}
          className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
        >Back</button>
        <button
          onClick={onNext}
          className={`flex-1 px-6 py-3 rounded font-semibold transition-all text-sm text-white ${
            someoneAttached ? 'bg-success hover:bg-success-hover' : 'bg-primary hover:bg-primary-hover'
          }`}
        >{someoneAttached ? 'Continue to Verify →' : 'Next: Verify →'}</button>
      </div>
    </div>
  );
};
