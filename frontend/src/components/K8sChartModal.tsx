import React, { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { useEscClose } from '../hooks/useEscClose';
import { SnippetBlock } from './SnippetBlock';

type Preview = { values: string; gatewayConfig: string; installCommand: string; files: string[]; keyEmbedded: boolean };
type Props = { isOpen: boolean; onClose: () => void };

// "Generate Kubernetes deployment" — previews and downloads a self-contained
// Helm chart (gateway + optional viewer), pre-wired to Helix from live state.
export const K8sChartModal: React.FC<Props> = ({ isOpen, onClose }) => {
  useEscClose(isOpen, onClose);
  const [viewerEnabled, setViewerEnabled] = useState(true);
  const [handoff, setHandoff] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/k8s/chart/preview?viewer=${viewerEnabled}&handoff=${handoff}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) setPreview(d); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, viewerEnabled, handoff]);

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
          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={viewerEnabled} onChange={e => setViewerEnabled(e.target.checked)} className="accent-primary w-4 h-4" />
            Include the local &quot;View OTel Data&quot; viewer (Deployment + PVC)
          </label>

          <label className="flex items-center gap-3 text-sm text-gray-300">
            <input type="checkbox" checked={handoff} onChange={e => setHandoff(e.target.checked)} className="accent-primary w-4 h-4" />
            Generating this for someone else (omit my key)
          </label>

          <div className="flex items-center gap-3 text-sm text-gray-500">
            <input type="checkbox" checked={false} disabled className="w-4 h-4" />
            Use the OpenTelemetry Operator <span className="text-tiny px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700">coming soon</span>
          </div>

          {error && <div className="text-xs text-error-text bg-error/10 border border-error/40 rounded p-3">{error}</div>}
          {loading && <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Generating preview…</div>}

          {preview && !loading && (
            <>
              <div>
                <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">Install</p>
                <SnippetBlock text={preview.installCommand} />
                {preview.keyEmbedded && (
                  <p className="text-tiny text-[#fcd34d] mb-2">
                    ⚠ This command contains your live Helix key — it runs locally and is never written into the downloaded chart.
                  </p>
                )}
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
            href={`/api/k8s/chart?viewer=${viewerEnabled}`}
            className="bg-primary hover:bg-[#3006c2] text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download chart (.zip)
          </a>
        </div>
      </div>
    </div>
  );
};
