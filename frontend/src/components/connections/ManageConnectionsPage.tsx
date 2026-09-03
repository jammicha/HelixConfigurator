import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useConnections } from '../../hooks/useConnections';
import type { Connection } from '../../hooks/useConnections';
import { validateConnectionFields } from '../../utils/connectionValidators';
import { ConnectionForm, emptyConnectionFormValue } from './ConnectionForm';
import type { ConnectionFormValue } from './ConnectionForm';
import { NavAvatar } from '../NavAvatar';

const HeaderUserMenu: React.FC = () => {
  const [authStatus, setAuthStatus] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => setAuthStatus({ required: !!d.required, authenticated: !!d.authenticated }))
      .catch(() => setAuthStatus({ required: false, authenticated: true }));
  }, []);
  return (
    <NavAvatar
      authStatus={authStatus}
      onLogout={async () => {
        try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        window.location.href = '/';
      }}
    />
  );
};

const connectionToFormValue = (c: Connection): ConnectionFormValue => ({
  name: c.name,
  endpoint: c.endpoint,
  apiKey: '', // never returned by the server; blank means "keep existing" on edit
  xSource: c.xSource,
  businessServiceKey: c.businessServiceKey,
  eventsEndpoint: c.eventsEndpoint,
  signals: c.signals,
});

// Client-side error map for the form, matching validateConnectionFields'
// shape. apiKey's "Required" rule is skipped while editing an existing
// connection, since a blank key there means "keep the current one" rather
// than an actual omission.
const computeFormErrors = (value: ConnectionFormValue, isEdit: boolean): Record<string, string> => {
  const { errors } = validateConnectionFields({
    name: value.name, endpoint: value.endpoint, apiKey: value.apiKey, xSource: value.xSource, signals: value.signals,
  });
  if (isEdit && !value.apiKey.trim()) delete errors.apiKey;
  return errors;
};

const healthDotClass = (verdict: string | undefined): string => {
  if (verdict === 'healthy') return 'bg-success-text';
  if (verdict === 'failing') return 'bg-danger-text';
  if (verdict === 'disabled') return 'bg-gray-700';
  return 'bg-gray-500'; // idle / unknown
};

const healthLabel = (verdict: string | undefined): string => {
  if (verdict === 'healthy') return 'Healthy';
  if (verdict === 'failing') return 'Failing';
  if (verdict === 'disabled') return 'Disabled';
  if (verdict === 'idle') return 'Idle';
  return 'Unknown';
};

type TestOutcome = { status: string; message: string } | null;

export const ManageConnectionsPage: React.FC = () => {
  const { connections, activeId, health, loading, error, create, update, remove, activate, test } = useConnections();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formValue, setFormValue] = useState<ConnectionFormValue>(emptyConnectionFormValue);
  const [showApiKey, setShowApiKey] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');
  const [testOutcomes, setTestOutcomes] = useState<Record<string, TestOutcome>>({});

  const openCreate = () => {
    setEditingId(null);
    setFormValue(emptyConnectionFormValue);
    setShowApiKey(false);
    setServerErrors({});
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (c: Connection) => {
    setEditingId(c.id);
    setFormValue(connectionToFormValue(c));
    setShowApiKey(false);
    setServerErrors({});
    setFormError('');
    setFormOpen(true);
  };

  const closeForm = () => { setFormOpen(false); };

  const isEdit = editingId !== null;
  const clientErrors = computeFormErrors(formValue, isEdit);
  const errors = { ...clientErrors, ...serverErrors };
  const canSubmit = Object.keys(clientErrors).length === 0;

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setFormError('');
    setServerErrors({});
    const payload: Record<string, unknown> = {
      name: formValue.name.trim(),
      endpoint: formValue.endpoint.trim(),
      xSource: formValue.xSource,
      businessServiceKey: formValue.businessServiceKey,
      eventsEndpoint: formValue.eventsEndpoint,
      signals: formValue.signals,
    };
    if (formValue.apiKey.trim()) payload.apiKey = formValue.apiKey.trim();
    try {
      if (isEdit && editingId) await update(editingId, payload);
      else await create(payload);
      setFormOpen(false);
    } catch (e: any) {
      if (e?.errors) setServerErrors(e.errors);
      else setFormError(e?.message || 'Request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const withRowBusy = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setRowError('');
    try { await fn(); }
    catch (e: any) { setRowError(e?.message || 'Request failed'); }
    finally { setBusyId(null); }
  };

  const handleToggleEnabled = (c: Connection) => withRowBusy(c.id, () => update(c.id, { enabled: !c.enabled }));
  const handleActivate = (c: Connection) => withRowBusy(c.id, () => activate(c.id));
  const handleDelete = (c: Connection) => {
    if (!window.confirm(`Delete connection "${c.name}"? This removes it from the collector configuration.`)) return;
    withRowBusy(c.id, () => remove(c.id));
  };
  const handleTest = (c: Connection) => withRowBusy(c.id, async () => {
    const result = await test(c.id);
    setTestOutcomes((prev) => ({ ...prev, [c.id]: { status: result.status, message: result.message } }));
  });

  return (
    <div className="min-h-screen bg-gray-1000 text-gray-100 flex flex-col">
      <header className="bg-helixNav flex items-center px-5 h-14 font-helix w-full flex-shrink-0 sticky top-0 z-40 border-b border-[#3a3f4a]">
        <div className="flex items-center gap-4">
          <a href="/" className="flex items-center" aria-label="Helix OTel Configurator home">
            <img src="/bmc-logo.svg" alt="BMC" className="h-7 w-auto" />
          </a>
          <h1 className="text-white font-normal text-[1.1875rem] m-0 tracking-normal">
            Helix OTel Configurator
          </h1>
        </div>
        <nav className="flex items-center gap-7 text-sm text-[#cfd3da] ml-10">
          <a href="/?view=onboarding" className="hover:text-white transition-colors">
            Onboarding
          </a>
          <a href="/" className="hover:text-white transition-colors">
            Gateway Dashboard
          </a>
          <a href="/otel-data" className="hover:text-white transition-colors">
            View OTel Data
          </a>
          <span className="text-white font-semibold border-b-2 border-primary pb-0.5">
            Manage Connections
          </span>
        </nav>
        <div className="ml-auto">
          <HeaderUserMenu />
        </div>
      </header>

      <main className="max-w-5xl w-full mx-auto px-6 py-4 space-y-4 flex-1 overflow-y-auto">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold">Manage Connections</h1>
            <p className="text-base text-gray-400 leading-relaxed max-w-2xl">
              Configure one or more Helix connections. Multiple enabled connections can send
              telemetry at once, but single-tenant features (the AIOps Business Service link,
              the OTel dashboard link, and the generated Helm chart) always follow the{' '}
              <span className="font-semibold text-gray-200">active</span> connection.
            </p>
          </header>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 rounded font-semibold text-sm bg-primary hover:bg-primary-hover text-white transition-all shrink-0"
          >
            <Plus className="w-4 h-4" />
            Add connection
          </button>
        </div>

        {rowError && (
          <div className="flex gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm items-start">
            <X className="w-4 h-4 text-danger-text flex-shrink-0 mt-0.5" aria-label="Error" />
            <div className="text-gray-300">{rowError}</div>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-gray-500 text-sm py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading connections…
          </div>
        )}

        {!loading && error && (
          <div className="flex gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm items-start">
            <X className="w-4 h-4 text-danger-text flex-shrink-0 mt-0.5" aria-label="Error" />
            <div className="text-gray-300">{error}</div>
          </div>
        )}

        {!loading && !error && connections.length === 0 && (
          <div className="adapt-card text-center py-10 space-y-2">
            <p className="text-gray-300">No connections configured yet.</p>
            <p className="text-tiny text-gray-500">Add a connection to start sending telemetry to Helix.</p>
          </div>
        )}

        {!loading && !error && connections.length > 0 && (
          <ul className="space-y-3">
            {connections.map((c) => {
              const h = health[c.id];
              const isActive = c.id === activeId;
              const isBusy = busyId === c.id;
              const outcome = testOutcomes[c.id];
              return (
                <li key={c.id} className="adapt-card space-y-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`inline-block w-2.5 h-2.5 rounded-full ${healthDotClass(h?.verdict)}`}
                          title={`Health: ${healthLabel(h?.verdict)}`}
                          aria-label={`Health: ${healthLabel(h?.verdict)}`}
                        />
                        <span className="font-semibold text-gray-100 truncate">{c.name}</span>
                        {isActive && <span className="adapt-badge-info">Active</span>}
                        {!c.enabled && <span className="adapt-badge-warning">Disabled</span>}
                      </div>
                      <p className="text-tiny text-gray-500 truncate" title={c.endpoint}>{c.endpoint}</p>
                      <p className="text-tiny text-gray-500 truncate">X-Source: {c.xSource || '(none)'}</p>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {c.signals.traces && <span className="adapt-badge-success">Traces</span>}
                        {c.signals.metrics && <span className="adapt-badge-success">Metrics</span>}
                        {c.signals.logs && <span className="adapt-badge-success">Logs</span>}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <label className="flex items-center gap-2 text-tiny text-gray-400 select-none">
                        <input
                          type="checkbox"
                          checked={c.enabled}
                          disabled={isBusy}
                          onChange={() => handleToggleEnabled(c)}
                          className="accent-primary w-4 h-4"
                        />
                        Enabled
                      </label>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <button
                          type="button"
                          onClick={() => openEdit(c)}
                          disabled={isBusy}
                          className="px-3 py-1.5 rounded border border-gray-800 hover:border-active text-tiny font-semibold text-gray-200 disabled:opacity-60"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleTest(c)}
                          disabled={isBusy}
                          className="px-3 py-1.5 rounded border border-gray-800 hover:border-active text-tiny font-semibold text-gray-200 disabled:opacity-60 inline-flex items-center gap-1.5"
                        >
                          {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          Test
                        </button>
                        <button
                          type="button"
                          onClick={() => handleActivate(c)}
                          disabled={isBusy || isActive || !c.enabled}
                          title={!c.enabled ? 'Enable this connection first' : undefined}
                          className="px-3 py-1.5 rounded border border-gray-800 hover:border-active text-tiny font-semibold text-gray-200 disabled:opacity-60"
                        >
                          Activate
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(c)}
                          disabled={isBusy}
                          className="p-1.5 rounded border border-gray-800 hover:border-danger/60 text-gray-400 hover:text-danger-text disabled:opacity-60"
                          aria-label={`Delete ${c.name}`}
                          title="Delete connection"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {outcome && (
                    <div role="status" aria-live="polite" className={`flex items-start gap-2 text-tiny p-2.5 rounded border ${
                      outcome.status === 'valid' ? 'bg-success/10 border-success/40 text-success-text' : 'bg-warning/10 border-warning/40 text-warning'
                    }`}>
                      {outcome.status === 'valid'
                        ? <Check className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
                      <span className="text-gray-200">{outcome.message}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {formOpen && (
        <>
          <div onClick={submitting ? undefined : closeForm} className="fixed inset-0 bg-black/50 z-40" aria-hidden="true" />
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto py-10 px-4">
            <div role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit connection' : 'Add connection'} className="adapt-card w-full max-w-xl space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-200">{isEdit ? 'Edit connection' : 'Add connection'}</h2>
                <button
                  type="button"
                  onClick={closeForm}
                  disabled={submitting}
                  className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-900 disabled:opacity-60"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <ConnectionForm
                value={formValue}
                onChange={setFormValue}
                errors={errors}
                showApiKey={showApiKey}
                onToggleApiKey={() => setShowApiKey((s) => !s)}
              />

              {formError && (
                <div className="flex gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm items-start">
                  <X className="w-4 h-4 text-danger-text flex-shrink-0 mt-0.5" aria-label="Error" />
                  <div className="text-gray-300">{formError}</div>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-800">
                <button
                  type="button"
                  onClick={closeForm}
                  disabled={submitting}
                  className="px-4 py-2 rounded font-semibold text-sm text-gray-300 hover:text-gray-100 hover:bg-gray-900 transition-colors disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit || submitting}
                  title={!canSubmit ? 'Fix the field errors above before continuing' : ''}
                  className="bg-primary hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-2 rounded font-semibold transition-all text-sm flex items-center gap-2"
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create connection'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
