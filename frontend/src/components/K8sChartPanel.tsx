import React, { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { SnippetBlock } from './SnippetBlock';
import { namespacedCommands } from './wizard/wizardTargets';

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
type Props = { namespace: string; onNamespaceChange: (ns: string) => void };

export const K8sChartPanel: React.FC<Props> = ({ namespace, onNamespaceChange }) => {
  const [viewerEnabled, setViewerEnabled] = useState(true);
  const [exposeViewer, setExposeViewer] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/k8s/chart/preview?viewer=${viewerEnabled}&handoff=${handoff}&expose=${exposeViewer}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!cancelled) setPreview(d); })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [viewerEnabled, handoff, exposeViewer]);

  const cmds = namespacedCommands(namespace, preview ?? { secretCommand: '', installCommand: '' });

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="k8s-ns" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Install namespace</label>
        <input
          id="k8s-ns" type="text" value={namespace} onChange={e => onNamespaceChange(e.target.value)} spellCheck={false} placeholder="default"
          className="mt-1 w-full max-w-xs bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 text-sm focus:outline-none focus:border-link block"
        />
        <p className="text-tiny text-gray-500 mt-1">The secret &amp; install commands below target this namespace (they must match). Leave as <code className="font-mono">default</code> for a quick try.</p>
      </div>
      <label className="flex items-center gap-3 text-sm text-gray-300">
        <input type="checkbox" checked={viewerEnabled} onChange={e => { setViewerEnabled(e.target.checked); if (!e.target.checked) setExposeViewer(false); }} className="accent-primary w-4 h-4" />
        Include the local &quot;View OTel Data&quot; viewer (Deployment + PVC)
      </label>

      {viewerEnabled && (
        <label className="flex items-start gap-3 text-sm text-gray-300 ml-7">
          <input type="checkbox" checked={exposeViewer} onChange={e => setExposeViewer(e.target.checked)} className="accent-primary w-4 h-4 mt-0.5" />
          <span>Expose it at <code className="font-mono text-gray-100">localhost:8765</code> — no port-forward <span className="text-tiny text-gray-500">(Docker Desktop / local clusters only; the viewer is unauthenticated, so don&apos;t use this on a shared/cloud cluster)</span></span>
        </label>
      )}

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
              href="/k8s-walkthrough.html"
              target="_blank" rel="noopener noreferrer"
              className="text-tiny text-[#8b7cf6] hover:underline"
            >Full walkthrough ↗</a>
          </div>
          <div>
            <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">1 · Download &amp; unzip</p>
            <a
              href={`/api/k8s/chart?viewer=${viewerEnabled}`}
              className="bg-primary hover:bg-[#3006c2] text-white px-4 py-1.5 rounded text-tiny font-semibold transition-colors inline-flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Download chart (.zip)
            </a>
            <p className="text-tiny text-gray-500 mt-2">
              Then unzip and <code className="bg-gray-1000 px-1 py-0.5 rounded">cd</code> into the chart folder — steps 2 &amp; 3 run from inside it:
            </p>
            <SnippetBlock text={`unzip helix-otel-chart.zip && cd helix-otel`} />
          </div>
          <div>
            <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">2 · Create the secret</p>
            {cmds.createNamespace && (
              <>
                <p className="text-tiny text-gray-500 mb-1">First create the namespace so the secret can land in it:</p>
                <SnippetBlock text={cmds.createNamespace} />
              </>
            )}
            <SnippetBlock text={cmds.secretCommand} />
            {preview.keyEmbedded && (
              <p className="text-tiny text-[#fcd34d] mb-2">
                ⚠ Contains your live Helix key — it runs locally and is never written into the downloaded chart.
              </p>
            )}
          </div>
          <div>
            <p className="text-tiny uppercase tracking-wide text-gray-500 mb-1">3 · Install the chart</p>
            <SnippetBlock text={cmds.installCommand} />
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
