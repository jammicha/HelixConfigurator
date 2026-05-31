import React, { useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';

type EnvVars = {
  HELIX_ENDPOINT: string;
  HELIX_API_KEY: string;
  X_SOURCE: string;
  BUSINESS_SERVICE_KEY: string;
  [key: string]: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  envVars: EnvVars;
  setEnvVars: (next: EnvVars) => void;
  showApiKey: boolean;
  setShowApiKey: (next: boolean | ((prev: boolean) => boolean)) => void;
  isUpdatingSettings: boolean;
  onUpdate: () => void;
  parseHelixKeyBundle: (raw: string) => string | null;
  extractServiceKey: (raw: string) => string;
};

export const HelixConnectionSettingsDrawer: React.FC<Props> = ({
  open, onClose, envVars, setEnvVars, showApiKey, setShowApiKey,
  isUpdatingSettings, onUpdate, parseHelixKeyBundle, extractServiceKey,
}) => {
  // ESC to close. Mount listener only while the drawer is open so other
  // ESC-sensitive UI (modals, services panel) isn't disturbed when this is
  // closed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while open so the page underneath doesn't shift when
  // the drawer takes focus.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  type ProvState = 'idle' | 'running' | 'done' | 'error';
  const [classState, setClassState] = React.useState<ProvState>('idle');
  const [classMsg, setClassMsg] = React.useState('');
  const [policyState, setPolicyState] = React.useState<ProvState>('idle');
  const [policyMsg, setPolicyMsg] = React.useState('');

  const provision = async (
    path: string,
    setState: (s: ProvState) => void,
    setMsg: (m: string) => void,
    okMsg: string,
  ) => {
    setState('running'); setMsg('');
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setState('done'); setMsg(data.alreadyExists ? `${okMsg} (already existed)` : okMsg); }
      else { setState('error'); setMsg(data.error || `Request failed (${res.status})`); }
    } catch (e: any) { setState('error'); setMsg(e.message || 'Network error'); }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop — dismiss on click */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/50 z-40"
        aria-hidden="true"
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Helix Connection Settings"
        className="fixed inset-y-0 right-0 w-full max-w-[520px] bg-gray-1000 border-l border-gray-800 shadow-4 z-50 overflow-y-auto flex flex-col"
      >
        <header className="sticky top-0 bg-gray-1000 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-100">Helix Connection Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-900"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 p-6 space-y-5">
          <div className="space-y-1">
            <label htmlFor="conn-endpoint" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Ingest Endpoint</label>
            <input
              id="conn-endpoint"
              type="text"
              value={envVars.HELIX_ENDPOINT}
              onChange={(e) => setEnvVars({ ...envVars, HELIX_ENDPOINT: e.target.value })}
              className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-link focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all text-sm"
              placeholder="https://otel-itom.onbmc.com"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="conn-api-key" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">X-Api-Key (TenantID::AccessKey::SecretKey)</label>
            <div className="relative">
              <input
                type="text"
                id="conn-api-key"
                name="helix-x-api-key"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                style={!showApiKey ? ({ WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties) : undefined}
                value={envVars.HELIX_API_KEY}
                onChange={(e) => {
                  const parsed = parseHelixKeyBundle(e.target.value);
                  setEnvVars({ ...envVars, HELIX_API_KEY: parsed ?? e.target.value });
                }}
                className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 pr-16 text-gray-100 focus:outline-none focus:border-link focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all font-mono text-sm"
                placeholder="123456789::ABCDE12345::FGHIJ67890..."
              />
              <button
                type="button"
                onClick={() => setShowApiKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-tiny text-gray-400 hover:text-gray-200 uppercase tracking-wider font-semibold px-1"
              >
                {showApiKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="conn-x-source" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">X-Source (Business Service)</label>
            <input
              id="conn-x-source"
              type="text"
              value={envVars.X_SOURCE}
              onChange={(e) => setEnvVars({ ...envVars, X_SOURCE: e.target.value })}
              className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-link focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all text-sm"
              placeholder="Source Name"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="conn-bskey" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">AIOps Business Service Key (optional)</label>
            <input
              id="conn-bskey"
              type="text"
              value={envVars.BUSINESS_SERVICE_KEY}
              onChange={(e) => setEnvVars({ ...envVars, BUSINESS_SERVICE_KEY: extractServiceKey(e.target.value) })}
              className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-link focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all font-mono text-sm"
              placeholder="e.g. LYVlMZN2grhnvxM4uik8s5PmVpJNidFS, or paste the full AIOps service URL"
            />
          </div>

          <div className="space-y-2 pt-2 border-t border-gray-800">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">AIOps Provisioning</div>
            <p className="text-tiny text-gray-500">Provisions against your <em>saved</em> connection. Update settings first, then provision the event class, then the correlation policy.</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => provision('/api/situations/provision-class', setClassState, setClassMsg, 'Event class provisioned')}
                disabled={classState === 'running'}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded border border-gray-800 hover:border-active text-sm font-semibold text-gray-200 disabled:opacity-60"
              >
                {classState === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
                1. Provision event class
              </button>
              {classMsg && <span className={`text-tiny ${classState === 'error' ? 'text-danger-text' : 'text-gray-400'}`}>{classMsg}</span>}
              <button
                type="button"
                onClick={() => provision('/api/situations/provision-correlation-policy', setPolicyState, setPolicyMsg, 'Correlation policy provisioned')}
                disabled={policyState === 'running'}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded border border-gray-800 hover:border-active text-sm font-semibold text-gray-200 disabled:opacity-60"
              >
                {policyState === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
                2. Provision correlation policy
              </button>
              {policyMsg && <span className={`text-tiny ${policyState === 'error' ? 'text-danger-text' : 'text-gray-400'}`}>{policyMsg}</span>}
            </div>
          </div>
        </div>

        <footer className="sticky bottom-0 bg-gray-1000 border-t border-gray-800 px-6 py-4 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded font-semibold text-sm text-gray-300 hover:text-gray-100 hover:bg-gray-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onUpdate}
            disabled={isUpdatingSettings}
            className="bg-primary hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-2 rounded font-semibold transition-all shadow-1 text-sm flex items-center gap-2"
          >
            {isUpdatingSettings && <Loader2 className="w-4 h-4 animate-spin" />}
            {isUpdatingSettings ? 'Updating…' : 'Update Settings'}
          </button>
        </footer>
      </aside>
    </>
  );
};
