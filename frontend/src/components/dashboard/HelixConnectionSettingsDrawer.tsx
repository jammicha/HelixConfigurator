import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { fetchCapabilityWithRetry } from '../updateCapability';
import { formatInstallLabel } from './installLabel';
import { ConnectionForm } from '../connections/ConnectionForm';
import type { ConnectionFormValue } from '../connections/ConnectionForm';
import { validateConnectionFields } from '../../utils/connectionValidators';

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

// The drawer saves through the same single-connection /api/env facade Step 1
// uses (see handleUpdateEnvSettings in App.tsx), which has no notion of a
// connection name or per-signal toggles. ConnectionFormValue still requires
// both, so the adapter fills them with a fixed, always-valid placeholder;
// hideName/hideSignals keep them off screen and the placeholders keep the
// shared validator from ever reporting an error for a field this form does
// not render. Name and signals for a saved connection are set on the Manage
// Connections page instead.
const PLACEHOLDER_SIGNALS = { traces: true, metrics: true, logs: true };

const toFormValue = (envVars: EnvVars): ConnectionFormValue => ({
  name: 'drawer-connection',
  endpoint: envVars.HELIX_ENDPOINT,
  apiKey: envVars.HELIX_API_KEY,
  xSource: envVars.X_SOURCE,
  businessServiceKey: envVars.BUSINESS_SERVICE_KEY,
  eventsEndpoint: envVars.HELIX_EVENTS_ENDPOINT || '',
  signals: PLACEHOLDER_SIGNALS,
});

const fromFormValue = (envVars: EnvVars, next: ConnectionFormValue): EnvVars => ({
  ...envVars,
  HELIX_ENDPOINT: next.endpoint,
  HELIX_API_KEY: next.apiKey,
  X_SOURCE: next.xSource,
  BUSINESS_SERVICE_KEY: next.businessServiceKey,
  HELIX_EVENTS_ENDPOINT: next.eventsEndpoint,
});

// Mirrors the field set the drawer actually renders (endpoint, apiKey,
// xSource). name/signals errors can never fire given the always-valid
// placeholders above, but are stripped defensively so a future validator
// change can't surface an error for a field this form hides.
const computeErrors = (envVars: EnvVars): Record<string, string> => {
  const { errors } = validateConnectionFields({
    name: 'drawer-connection',
    endpoint: envVars.HELIX_ENDPOINT,
    apiKey: envVars.HELIX_API_KEY,
    xSource: envVars.X_SOURCE,
    signals: PLACEHOLDER_SIGNALS,
  });
  delete errors.name;
  delete errors.signals;
  return errors;
};

export const HelixConnectionSettingsDrawer: React.FC<Props> = ({
  open, onClose, envVars, setEnvVars, showApiKey, setShowApiKey,
  isUpdatingSettings, onUpdate, parseHelixKeyBundle: _parseHelixKeyBundle, extractServiceKey: _extractServiceKey,
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

  // Which install is serving this UI, for the footer label. Fetched when the
  // drawer opens rather than on mount, since it is only ever shown here, and
  // fetched once per open (both endpoints are cheap and public). Failures are
  // silent: the label simply does not render.
  const [installLabel, setInstallLabel] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      fetch('/api/version').then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetchCapabilityWithRetry(fetch, { attempts: 2 }),
    ]).then(([version, cap]) => {
      if (cancelled) return;
      setInstallLabel(formatInstallLabel({ version: version?.current, mode: cap?.mode }));
    });
    return () => { cancelled = true; };
  }, [open]);

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

  type OpenEvent = { id: string; service: string; msg: string; severity: string; sourceIdentifier: string; creationTime: number | null };
  const [openEvents, setOpenEvents] = React.useState<OpenEvent[] | null>(null);
  const [openEventsMsg, setOpenEventsMsg] = React.useState('');
  const [openEventsErr, setOpenEventsErr] = React.useState(false);
  const [closing, setClosing] = React.useState(false);

  const loadOpenEvents = async () => {
    setOpenEventsMsg('Loading…');
    try {
      const res = await fetch('/api/situations/open-events');
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setOpenEvents(data.events || []); setOpenEventsMsg(''); setOpenEventsErr(false); }
      else { setOpenEvents([]); setOpenEventsMsg(data.error || `Failed (${res.status})`); setOpenEventsErr(true); }
    } catch (e: any) { setOpenEvents([]); setOpenEventsMsg(e.message || 'Network error'); setOpenEventsErr(true); }
  };

  const closeEvents = async (body: { traceId?: string; sourceIdentifier?: string; all?: boolean }) => {
    setClosing(true);
    try {
      const res = await fetch('/api/situations/close-events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      setOpenEventsMsg(res.ok ? `Closed ${data.closed ?? 0} event(s).` : (data.error || `Failed (${res.status})`));
      setOpenEventsErr(!res.ok);
    } catch (e: any) { setOpenEventsMsg(e.message || 'Network error'); setOpenEventsErr(true); }
    finally { setClosing(false); await loadOpenEvents(); }
  };

  useEffect(() => {
    if (!open) return;
    loadOpenEvents();
  }, [open]);

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
          <a href="/connections" className="block text-tiny text-blue-400 hover:underline">
            Manage connections →
          </a>

          <ConnectionForm
            value={toFormValue(envVars)}
            onChange={(next) => setEnvVars(fromFormValue(envVars, next))}
            errors={computeErrors(envVars)}
            showApiKey={showApiKey}
            onToggleApiKey={() => setShowApiKey((s) => !s)}
            hideName
            hideSignals
          />

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

          <div className="space-y-2 pt-2 border-t border-gray-800">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Sent events (open in Helix)</div>
              <div className="flex gap-2">
                <button className="text-xs text-blue-400 hover:underline" onClick={loadOpenEvents} disabled={closing}>Refresh</button>
                {openEvents && openEvents.length > 0 && (
                  <button className="text-xs text-red-400 hover:underline" onClick={() => closeEvents({ all: true })} disabled={closing}>Close all</button>
                )}
              </div>
            </div>
            {openEventsMsg && <p className={`text-tiny ${openEventsErr ? 'text-danger-text' : 'text-gray-400'} mt-1`}>{openEventsMsg}</p>}
            {openEvents && openEvents.length === 0 && !openEventsMsg && <p className="text-tiny text-gray-500 mt-1">No open configurator events.</p>}
            <ul className="mt-2 space-y-1">
              {(openEvents || []).map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 text-tiny bg-gray-900 rounded px-2 py-1">
                  <span className="truncate"><span className="text-gray-400">{e.severity}</span> {e.service} — {e.msg}</span>
                  <button className="text-red-400 hover:underline shrink-0" onClick={() => closeEvents({ sourceIdentifier: e.sourceIdentifier })} disabled={closing || !e.sourceIdentifier}>Close</button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <footer className="sticky bottom-0 bg-gray-1000 border-t border-gray-800 px-6 py-4 flex items-center justify-between gap-3">
          <span className="text-tiny text-gray-500 truncate" title="The configurator install serving this page">
            {installLabel}
          </span>
          <div className="flex items-center gap-3 shrink-0">
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
          </div>
        </footer>
      </aside>
    </>
  );
};
