import React, { useEffect, useState } from 'react';
import { Check, CheckCircle2, AlertTriangle, Hexagon, X, Loader2 } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';

// Tri-state result from POST /api/diagnostics/step3-verify. See backend
// route comments for what each sub-result means; the overall verdict is
// what drives the banner color, but we surface the per-probe detail in
// a tooltip so the user can debug yellows without opening DevTools.
type Step3Verify = {
  topology: 'ok' | 'missing' | 'unknown';
  gatewayReceiver: 'ok' | 'unreachable' | 'unknown';
  collectorExporter: 'ok' | 'failing' | 'unknown' | 'not-probed';
  sharedNetwork: string | null;
  overall: 'green' | 'yellow' | 'red';
  message: string;
  remediation?: string;
};

export type DetectedCollector = {
  name: string;
  image: string;
  networks: string[];
  sharesNetworkWithSidecar: boolean;
  isKubernetes?: boolean;
  // Which signal(s) flagged this container as a collector. Surfaced as a
  // small badge so a user looking at an unfamiliar candidate (e.g. a vendor
  // distro caught by port exposure alone) can sanity-check before attaching.
  detectedVia?: 'image+ports' | 'image' | 'ports';
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
  // When exactly one collector is detected, name it in the body so the user
  // sees the same identifier that smart-add and the bridge action will touch.
  // For zero or many, fall back to generic copy — picking one when there are
  // many would imply we'd auto-pick, which is exactly what we don't do.
  const singleCollector = detectedCollectors.length === 1 ? detectedCollectors[0] : null;
  // Deep verification: receiver-listening + exporter-success probe layered
  // on top of the topology check. Fires once we observe `someoneAttached`
  // flip true, so the user sees the deeper result without having to click
  // Continue first. Re-fires whenever the bridged collector identity changes
  // (rare: only when the topology shifts mid-wizard).
  const bridgedCollector = detectedCollectors.find(c => c.sharesNetworkWithSidecar);
  const [verifyResult, setVerifyResult] = useState<Step3Verify | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    if (!bridgedCollector) {
      setVerifyResult(null);
      return;
    }
    let cancelled = false;
    setVerifying(true);
    fetch('/api/diagnostics/step3-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectorName: bridgedCollector.name }),
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: Step3Verify | null) => {
        if (!cancelled && data) setVerifyResult(data);
      })
      .catch(() => { /* fall through to topology-only banner */ })
      .finally(() => { if (!cancelled) setVerifying(false); });
    return () => { cancelled = true; };
  }, [bridgedCollector?.name]);

  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 3: Connect helix-gateway and your collector to a shared Docker network</h2>
      <p className="text-sm text-gray-400 mb-4">
        {singleCollector
          ? <>We'll bridge <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">helix-gateway</code> to <code className="font-mono text-gray-100 bg-gray-900 px-1 rounded">{singleCollector.name}</code>'s network so their OTLP traffic can flow over loopback.</>
          : 'helix-gateway and your collector need to share a Docker network so their OTLP traffic can flow over loopback.'}
      </p>

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
                        {c.detectedVia === 'ports' && (
                          // Port-only matches catch vendor distros and renamed
                          // images that don't carry "otelcol" in the name. Flag
                          // it so the user can sanity-check before attaching.
                          <span
                            className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700"
                            title="Detected by OTLP port exposure (4317/4318), not image name. Confirm this is actually a collector before attaching."
                          >
                            port match
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
            <p className="text-tiny text-gray-400 mb-2 font-semibold uppercase tracking-wider">Option B — alternative: attach your container to helix-bridge</p>
            <SnippetBlock text="docker network connect helix-bridge <your-container>" />
            <p className="text-tiny text-gray-500 -mt-4">Use this when your collector can't accept a new network at runtime — joining ours instead works the same way.</p>
          </div>
          <p className="text-tiny text-gray-500">Then restart your container.</p>
        </div>
      )}

      {someoneAttached && (
        // Tri-state. Verifying first (loader), then either the deep-verify
        // result if it landed, or a topology-only fallback if the probe
        // hadn't returned yet or failed. Each state names the collector and
        // the shared network so the user sees the same identifiers Step 4
        // will operate on, not a vague "your collector."
        verifying && !verifyResult ? (
          <div className="mt-4 flex items-start gap-3 p-2.5 bg-gray-1000 border border-gray-800 rounded text-tiny text-gray-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 mt-0.5" />
            <span>Verifying receiver and exporter…</span>
          </div>
        ) : verifyResult?.overall === 'green' ? (
          <div className="mt-4 flex items-start gap-3 p-2.5 bg-success/10 border border-success/40 rounded text-tiny text-gray-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold text-gray-100">{verifyResult.message}</span>{' '}
              {bridgedCollector && verifyResult.sharedNetwork && (
                <>helix-gateway is bridged to <code className="font-mono">{verifyResult.sharedNetwork}</code> with <code className="font-mono">{bridgedCollector.name}</code>.</>
              )}{' '}
              Continue to Verify.
            </span>
          </div>
        ) : verifyResult?.overall === 'yellow' ? (
          <div className="mt-4 flex items-start gap-3 p-2.5 bg-warning/10 border border-warning/40 rounded text-tiny text-gray-300">
            <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold text-gray-100">{verifyResult.message}</span>{' '}
              {verifyResult.remediation}
            </span>
          </div>
        ) : verifyResult?.overall === 'red' ? (
          <div className="mt-4 flex items-start gap-3 p-2.5 bg-danger/10 border border-danger/40 rounded text-tiny text-gray-300">
            <X className="w-3.5 h-3.5 text-danger flex-shrink-0 mt-0.5" aria-label="Error" />
            <span>
              <span className="font-semibold text-gray-100">{verifyResult.message}</span>{' '}
              {verifyResult.remediation}
            </span>
          </div>
        ) : (
          // Probe hasn't returned yet (or errored). Show the topology-only
          // signal — same message we had before — so the user isn't blocked
          // on a network blip to the verify endpoint.
          <div className="mt-4 flex items-start gap-3 p-2.5 bg-success/10 border border-success/40 rounded text-tiny text-gray-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold text-gray-100">helix-gateway is already on a network with a detected collector.</span>{' '}
              You can continue to Verify.
            </span>
          </div>
        )
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
