import React from 'react';
import { Check } from 'lucide-react';
import { parseHelixKeyBundle, extractServiceKey } from '../../utils/helixKey';
import type { Signals } from '../../utils/connectionValidators';

// The full set of fields a connection's create/edit form controls. This is a
// pure, controlled shape shared by ManageConnectionsPage, the wizard's
// Step 1 (a later task adopts it), and the settings drawer, so it carries no
// page-specific concerns (no submit/test callbacks, no "enabled" toggle -
// those stay on the consuming page).
export type ConnectionFormValue = {
  name: string;
  endpoint: string;
  // Write-only in the UI: never populated from a GET (the server does not
  // return stored keys). Left blank on an edit means "keep the existing
  // key" - callers should omit an empty apiKey from their update payload.
  apiKey: string;
  xSource: string;
  businessServiceKey: string;
  eventsEndpoint: string;
  signals: Signals;
};

export const emptyConnectionFormValue: ConnectionFormValue = {
  name: '',
  endpoint: '',
  apiKey: '',
  xSource: '',
  businessServiceKey: '',
  eventsEndpoint: '',
  signals: { traces: true, metrics: true, logs: true },
};

type Props = {
  value: ConnectionFormValue;
  onChange: (next: ConnectionFormValue) => void;
  // Field-name-keyed error map, matching validateConnectionFields' output
  // shape (and a server 400's `.errors`): name, endpoint, apiKey, xSource,
  // signals.
  errors: Record<string, string>;
  showApiKey: boolean;
  onToggleApiKey: () => void;
};

// Controlled connection fields, extracted from wizard/Step1.tsx so every
// place that creates or edits a connection shares one markup and one
// validation-error display. Per-field errors follow Step1's convention:
// shown only once the field has content, so a pristine "Required" error
// doesn't greet the user before they've typed anything.
export const ConnectionForm: React.FC<Props> = ({ value, onChange, errors, showApiKey, onToggleApiKey }) => {
  const set = (patch: Partial<ConnectionFormValue>) => onChange({ ...value, ...patch });
  const setSignal = (key: keyof Signals, checked: boolean) => set({ signals: { ...value.signals, [key]: checked } });

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="conn-form-name" className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          Connection Name
          {!errors.name && value.name && <Check className="w-3.5 h-3.5 text-success-text inline" aria-label="OK" />}
        </label>
        <input
          id="conn-form-name"
          type="text"
          name="connection-name"
          autoComplete="off"
          spellCheck={false}
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
          aria-invalid={!!(value.name && errors.name)}
          aria-describedby={value.name && errors.name ? 'conn-form-name-error' : undefined}
          className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all text-sm ${value.name && errors.name ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-link'}`}
          placeholder="e.g. Payments Prod"
        />
        {value.name && errors.name && (
          <p id="conn-form-name-error" className="text-tiny text-danger-text">{errors.name}</p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="conn-form-endpoint" className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          Helix Endpoint
          {!errors.endpoint && value.endpoint && <Check className="w-3.5 h-3.5 text-success-text inline" aria-label="OK" />}
        </label>
        <input
          id="conn-form-endpoint"
          type="url"
          name="helix-ingest-endpoint"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          value={value.endpoint}
          onChange={(e) => set({ endpoint: e.target.value })}
          aria-invalid={!!(value.endpoint && errors.endpoint)}
          aria-describedby={value.endpoint && errors.endpoint ? 'conn-form-endpoint-error' : undefined}
          className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all text-sm ${value.endpoint && errors.endpoint ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-link'}`}
          placeholder="https://your-tenant.onbmc.com"
        />
        {value.endpoint && errors.endpoint && (
          <p id="conn-form-endpoint-error" className="text-tiny text-danger-text">{errors.endpoint}</p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="conn-form-api-key" className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
          X-API Key
          {!errors.apiKey && value.apiKey && <Check className="w-3.5 h-3.5 text-success-text inline" aria-label="OK" />}
        </label>
        <div className="relative">
          <input
            id="conn-form-api-key"
            type="text"
            name="helix-x-api-key"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={value.apiKey}
            onChange={(e) => {
              const parsed = parseHelixKeyBundle(e.target.value);
              set({ apiKey: parsed ?? e.target.value });
            }}
            aria-invalid={!!(value.apiKey && errors.apiKey)}
            aria-describedby={value.apiKey && errors.apiKey ? 'conn-form-api-key-error' : undefined}
            style={!showApiKey ? { WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties : undefined}
            className={`w-full bg-gray-1000 border rounded px-3 py-2 pr-16 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all font-mono text-sm ${value.apiKey && errors.apiKey ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-link'}`}
            placeholder="Paste your API key from the Helix portal"
          />
          <button
            type="button"
            onClick={onToggleApiKey}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-tiny text-gray-400 hover:text-gray-200 uppercase tracking-wider font-semibold px-1"
          >
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="text-tiny text-gray-500">Paste the full key. The format is parsed automatically. Leave blank on edit to keep the current key.</p>
        {value.apiKey && errors.apiKey && (
          <p id="conn-form-api-key-error" className="text-tiny text-danger-text">{errors.apiKey}</p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="conn-form-x-source" className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2 flex-wrap">
          <span className="flex items-center gap-2">
            X-Source
            {!errors.xSource && value.xSource && <Check className="w-3.5 h-3.5 text-success-text inline" aria-label="OK" />}
          </span>
          <span className="normal-case tracking-normal text-gray-500 font-normal">· Business Service name in Helix topology &amp; AIOps</span>
        </label>
        <input
          id="conn-form-x-source"
          type="text"
          name="helix-x-source"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          value={value.xSource}
          onChange={(e) => set({ xSource: e.target.value })}
          aria-invalid={!!(value.xSource && errors.xSource)}
          aria-describedby={value.xSource && errors.xSource ? 'conn-form-x-source-error' : undefined}
          className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all text-sm ${value.xSource && errors.xSource ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-link'}`}
          placeholder="e.g. payment-service"
        />
        {value.xSource && errors.xSource && (
          <p id="conn-form-x-source-error" className="text-tiny text-danger-text">{errors.xSource}</p>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="conn-form-bskey" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          AIOps Business Service Key (optional)
        </label>
        <input
          id="conn-form-bskey"
          type="text"
          value={value.businessServiceKey}
          onChange={(e) => set({ businessServiceKey: extractServiceKey(e.target.value) })}
          className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-link focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all font-mono text-sm"
          placeholder="e.g. LYVlMZN2grhnvxM4uik8s5PmVpJNidFS, or paste the full AIOps service URL"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="conn-form-events-endpoint" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          AIOps Events Endpoint (optional)
        </label>
        <input
          id="conn-form-events-endpoint"
          type="text"
          value={value.eventsEndpoint}
          onChange={(e) => set({ eventsEndpoint: e.target.value })}
          className="w-full bg-gray-1000 border border-gray-800 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-link focus:shadow-[0_0_0_2px_rgba(165,186,255,0.55)] transition-all text-sm"
          placeholder="Falls back to the Helix Endpoint above when unset"
        />
      </div>

      <div className="space-y-1">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Signals to send</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={value.signals.traces} onChange={(e) => setSignal('traces', e.target.checked)} className="accent-primary w-4 h-4" />
            Traces
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={value.signals.metrics} onChange={(e) => setSignal('metrics', e.target.checked)} className="accent-primary w-4 h-4" />
            Metrics
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={value.signals.logs} onChange={(e) => setSignal('logs', e.target.checked)} className="accent-primary w-4 h-4" />
            Logs
          </label>
        </div>
        {errors.signals && (
          <p className="text-tiny text-danger-text">{errors.signals}</p>
        )}
      </div>
    </div>
  );
};
