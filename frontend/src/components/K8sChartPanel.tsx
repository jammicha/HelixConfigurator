import React, { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { SnippetBlock } from './SnippetBlock';

type Preview = {
  values: string;
  gatewayConfig: string;
  secretCommand: string;
  installCommand: string;
  files: string[];
  keyEmbedded: boolean;
};

// The generate-a-Helm-chart UX, shared by the dashboard K8sChartModal and the
// onboarding wizard's Kubernetes "Generate" step. Self-contained: owns the
// viewer/handoff toggles, fetches the preview, and renders the install steps +
// previews + download. Generate-only — no cluster calls.
export const K8sChartPanel: React.FC = () => {
  const [viewerEnabled, setViewerEnabled] = useState(true);
  const [handoff, setHandoff] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [viewerEnabled, handoff]);

  return (
    <div className="space-y-4">
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
          <div className="flex items-center justify-between">
            <p className="text-tiny uppercase tracking-wide text-gray-500">Install steps</p>
            <a
              href="https://github.com/jammicha/HelixConfigurator#generate-a-kubernetes-chart"
              target="_blank" rel="noopener noreferrer"
              className="text-tiny text-[#8b7cf6] hover:underline"
            >Full walkthrough ↗</a>
          </div>
          <div>
            <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">1 · Download the chart</p>
            <a
              href={`/api/k8s/chart?viewer=${viewerEnabled}`}
              className="bg-primary hover:bg-[#3006c2] text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors inline-flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Download chart (.zip)
            </a>
            <p className="text-tiny text-gray-500 mt-2">
              Then <code className="bg-gray-1000 px-1 py-0.5 rounded">unzip helix-otel-chart.zip</code> and run the next steps from the folder that now holds <code className="bg-gray-1000 px-1 py-0.5 rounded">helix-otel/</code>.
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
  );
};
