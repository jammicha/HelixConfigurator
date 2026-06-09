import React, { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';
import { SnippetBlock } from './SnippetBlock';

type Target = 'local' | 'remote';
type Preview = { target: Target; values: string; gatewayConfig: string; secretCommand: string; installCommand: string; files: string[]; keyEmbedded: boolean };
type Props = { isOpen: boolean; onClose: () => void };

// "Generate Kubernetes deployment" — previews and downloads a self-contained
// Helm chart (gateway only), pre-wired to Helix from live state.
// Local clusters send telemetry back to the host's configurator at localhost:8765.
// Remote clusters send to Helix only.
export const K8sChartModal: React.FC<Props> = ({ isOpen, onClose }) => {
  useEscClose(isOpen, onClose);
  const [clusterTarget, setClusterTarget] = useState<Target>('local');
  const [handoff, setHandoff] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/k8s/chart/preview?target=${clusterTarget}&handoff=${handoff}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) setPreview(d); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, clusterTarget, handoff]);

  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="k8s-modal-title"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-4 w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 id="k8s-modal-title" className="text-lg font-semibold text-gray-200">Generate Kubernetes deployment</h2>
            <p className="text-tiny text-gray-500">A self-contained Helm chart, pre-wired to Helix from your current config.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1" aria-label="Close dialog">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-tiny uppercase tracking-wide text-gray-500 mb-1">Cluster target</legend>
            <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
              <input type="radio" name="clusterTarget" value="local" checked={clusterTarget === 'local'} onChange={() => setClusterTarget('local')} className="accent-primary mt-0.5" />
              <span>
                <span className="font-medium text-gray-200">Local cluster (Docker Desktop)</span>
                <span className="block text-tiny text-gray-500 mt-0.5">Telemetry flows back to this app at localhost:8765/otel-data — same view as Docker.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
              <input type="radio" name="clusterTarget" value="remote" checked={clusterTarget === 'remote'} onChange={() => setClusterTarget('remote')} className="accent-primary mt-0.5" />
              <span>
                <span className="font-medium text-gray-200">Remote / cloud cluster</span>
                <span className="block text-tiny text-gray-500 mt-0.5">View your telemetry in BMC Helix. The local viewer isn't reachable from a remote cluster.</span>
              </span>
            </label>
          </fieldset>

          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={handoff} onChange={e => setHandoff(e.target.checked)} className="accent-primary w-4 h-4" />
            Generating this for someone else (omit my key)
          </label>

          <p className="text-tiny text-gray-500">
            Need the OpenTelemetry Operator flavor (CR-managed gateway + zero-code auto-instrumentation)?
            Generate it from <span className="text-gray-300">Onboarding → Kubernetes: Operator</span> — that
            wizard path builds the operator chart with prereq commands and runtime toggles.
          </p>

          {error && <div className="text-xs text-error-text bg-error/10 border border-error/40 rounded p-3">{error}</div>}
          {loading && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Generating preview…</div>}

          {preview && !loading && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-tiny uppercase tracking-wide text-gray-500">Install steps</p>
                <a
                  href="https://github.com/jammicha/HelixConfigurator#generate-a-kubernetes-chart"
                  target="_blank" rel="noopener noreferrer"
                  className="text-tiny text-[#8b7cf6] hover:underline"
                >Full walkthrough ↗</a>
              </div>
              <div>
                <p className="text-sm text-gray-300">
                  <span className="text-gray-500">1 ·</span> Download &amp; unzip the chart — click <span className="text-gray-200">Download chart (.zip)</span> below, then <code className="text-tiny bg-gray-1000 px-1 py-0.5 rounded">unzip helix-otel-chart.zip</code>. Run the next steps from the folder that now holds <code className="text-tiny bg-gray-1000 px-1 py-0.5 rounded">helix-otel/</code>.
                </p>
              </div>
              <div>
                <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">2 · Create the secret</p>
                <SnippetBlock text={preview.secretCommand} />
                {preview.keyEmbedded && (
                  <p className="text-tiny text-[#fcd34d] mb-2">
                    ⚠ Contains your live Helix key — it runs locally and is never written into the downloaded chart.
                  </p>
                )}
              </div>
              <div>
                <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">3 · Install the chart</p>
                <SnippetBlock text={preview.installCommand} />
              </div>
              <details>
                <summary className="text-sm text-gray-300 cursor-pointer select-none">Preview values.yaml</summary>
                <SnippetBlock text={preview.values} />
              </details>
              <details>
                <summary className="text-sm text-gray-300 cursor-pointer select-none">Preview gateway collector config</summary>
                <SnippetBlock text={preview.gatewayConfig} />
              </details>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-700 flex-shrink-0">
          <a
            href={`/api/k8s/chart?target=${clusterTarget}`}
            className="bg-primary hover:bg-[#3006c2] text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download chart (.zip)
          </a>
        </div>
      </div>
    </div>
  );
};
