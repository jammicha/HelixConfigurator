import React, { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, CheckCircle2, Loader2, Boxes, AlertTriangle } from 'lucide-react';
import { useBusinessServiceLink, type NamespaceRow } from '../../hooks/useBusinessServiceLink';

type Props = {
  context: 'wizard' | 'dashboard';
  currentKey?: string;
  onCaptured?: (key: string) => void;
  onToast?: (message: string, type?: 'success' | 'error') => void;
};

export const LinkBusinessService: React.FC<Props> = ({ context, currentKey, onCaptured, onToast }) => {
  const bs = useBusinessServiceLink();
  const [phase, setPhase] = useState<'detect' | 'guide' | 'done'>('detect');
  const [selectedNs, setSelectedNs] = useState('');
  const [paste, setPaste] = useState('');

  useEffect(() => { bs.loadNamespaces(); // on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (ns: string) => {
    setSelectedNs(ns);
    await bs.loadInstructions(ns);
    setPhase('guide');
  };

  const capture = async () => {
    const ok = await bs.persistKey(paste);
    if (ok) {
      setPhase('done');
      onToast?.('Business Service key captured', 'success');
      onCaptured?.(paste);
    } else {
      onToast?.(bs.error || 'Could not save key', 'error');
    }
  };

  if (phase === 'detect') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-400">
          Link each OpenTelemetry namespace arriving from your gateway to a Business Service in AIOps,
          so topology, health, and Situations roll up to it.
        </p>
        {currentKey && <div className="text-tiny text-gray-500">Currently linked key: <span className="font-mono text-gray-300">{currentKey}</span></div>}
        {bs.loadingNamespaces && <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Detecting namespaces…</div>}
        {!bs.loadingNamespaces && bs.namespaces.length === 0 && (
          <div className="bg-gray-1000 border border-gray-800 rounded p-3 text-sm text-gray-300">
            No telemetry arriving yet. Start your app or run a synthetic scenario from{' '}
            <a href="/step-zero" className="text-link hover:underline">Start from zero</a>, then come back.
          </div>
        )}
        {bs.namespaces.map((n: NamespaceRow) => (
          <div key={n.namespace} className="bg-gray-1000 border border-gray-800 rounded p-3 flex items-center gap-3">
            <Boxes className="w-4 h-4 text-blue-300 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-100 font-medium truncate">{n.namespace}{n.fallback && <span className="ml-2 text-tiny text-gray-500">(via X-Source)</span>}</div>
              <div className="text-tiny text-gray-500">{n.traceCount} trace{n.traceCount === 1 ? '' : 's'} seen</div>
            </div>
            <button onClick={() => pick(n.namespace)} className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-3 py-1.5 rounded font-semibold text-sm flex items-center gap-1.5">
              Link <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {bs.error && <div className="flex items-center gap-2 text-sm text-[#ff8a8a]"><AlertTriangle className="w-4 h-4" /> {bs.error}</div>}
      </div>
    );
  }

  if (phase === 'guide') {
    const ins = bs.instructions;
    return (
      <div className="space-y-3">
        <button onClick={() => { setPhase('detect'); bs.reset(); }} className="text-tiny text-gray-400 hover:text-gray-200 underline">← Pick a different namespace</button>
        <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider">Link "{selectedNs}" in AIOps</div>
        {bs.loadingInstructions && <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
        {ins && (
          <>
            <ol className="list-decimal ml-5 space-y-1.5 text-sm text-gray-300">
              {ins.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {ins.aiopsUrl && (
              <a href={ins.aiopsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-link hover:underline">
                Open BMC Helix AIOps <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <div className="bg-gray-1000 border border-gray-800 rounded p-3 space-y-2">
              <label className="block text-tiny font-semibold text-gray-400 uppercase tracking-wider">Paste the Business Service URL (or key)</label>
              <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="https://…/aiops/#/entities/service/…?type=key" className="adapt-input" />
              <button onClick={capture} disabled={!paste.trim() || bs.saving} className="bg-primary hover:bg-[#3006c2] disabled:opacity-60 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded text-sm font-semibold transition-all flex items-center gap-2">
                {bs.saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Capture key
              </button>
            </div>
          </>
        )}
        {bs.error && <div className="flex items-center gap-2 text-sm text-[#ff8a8a]"><AlertTriangle className="w-4 h-4" /> {bs.error}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="w-5 h-5" /> Linked — key captured for "{selectedNs}".</div>
      <p className="text-sm text-gray-400">Your AIOps deep-links now resolve to this Business Service. Confirm the rollup:</p>
      {bs.instructions?.dashboardUrl && (
        <a href={bs.instructions.dashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-link hover:underline">
          Open the namespace dashboard <ExternalLink className="w-4 h-4" />
        </a>
      )}
      <div><button onClick={() => { setPhase('detect'); setPaste(''); setSelectedNs(''); bs.reset(); bs.loadNamespaces(); }} className="text-tiny text-gray-400 hover:text-gray-200 underline">Link another namespace</button></div>
    </div>
  );
};
