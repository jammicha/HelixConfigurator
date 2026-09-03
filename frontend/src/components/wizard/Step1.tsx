import React from 'react';
import { X, Loader2, AlertTriangle, Check } from 'lucide-react';
import { ConnectionForm } from '../connections/ConnectionForm';
import type { ConnectionFormValue } from '../connections/ConnectionForm';
import { validateConnectionFields } from '../../utils/connectionValidators';

export type EnvVars = {
  HELIX_ENDPOINT: string;
  HELIX_API_KEY: string;
  X_SOURCE: string;
  BUSINESS_SERVICE_KEY: string;
  // Optional: not part of the wizard's original four fields, but /api/env
  // reads and writes it (see backend/routes/env.js) and ConnectionForm
  // renders an Events Endpoint field alongside the others.
  HELIX_EVENTS_ENDPOINT?: string;
};

type Props = {
  envVars: EnvVars;
  setEnvVars: (next: EnvVars) => void;
  showApiKey: boolean;
  setShowApiKey: (fn: (s: boolean) => boolean) => void;
  setupError: string;
  isVerifying: boolean;
  onInitialize: () => void;
  onTestConnection: () => void;
  testConnectionResult: { status: string; message: string; remediation?: string; httpStatus?: number; latencyMs?: number } | null;
  testingConnection: boolean;
  primaryLabel?: string;
  heading?: string;
};

// Step 1 saves through the single-connection /api/env facade (see
// handleInitialize in App.tsx), which knows nothing about a connection name
// or per-signal toggles - those belong to a Connection record and are set on
// the Manage Connections page. ConnectionForm still requires a `name` and
// `signals` value on its ConnectionFormValue shape, so the adapter below
// fills both with a fixed, always-valid placeholder: `hideName`/`hideSignals`
// keep them off screen, and the placeholders keep the shared validator from
// ever reporting an error for a field this form doesn't render.
const PLACEHOLDER_SIGNALS = { traces: true, metrics: true, logs: true };

const toFormValue = (envVars: EnvVars): ConnectionFormValue => ({
  name: 'step1-connection',
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

// Mirrors the field set Step 1 actually renders (endpoint, apiKey, xSource).
// name/signals errors can never fire given the always-valid placeholders
// above, but are stripped defensively so a future validator change can't
// surface an error for a field this form hides.
const computeErrors = (envVars: EnvVars): Record<string, string> => {
  const { errors } = validateConnectionFields({
    name: 'step1-connection',
    endpoint: envVars.HELIX_ENDPOINT,
    apiKey: envVars.HELIX_API_KEY,
    xSource: envVars.X_SOURCE,
    signals: PLACEHOLDER_SIGNALS,
  });
  delete errors.name;
  delete errors.signals;
  return errors;
};

export const Step1: React.FC<Props> = ({
  envVars,
  setEnvVars,
  showApiKey,
  setShowApiKey,
  setupError,
  isVerifying,
  onInitialize,
  onTestConnection,
  testConnectionResult,
  testingConnection,
  primaryLabel = 'Save & initialize →',
  heading = 'Step 1: Configure helix-gateway',
}) => {
  const errors = computeErrors(envVars);
  const canSubmit = Object.keys(errors).length === 0;
  const formValue = toFormValue(envVars);

  return (
    <div className="adapt-card">
      <a
        href="/step-zero"
        className="block rounded border border-blue-900 bg-blue-950/30 p-3 text-tiny text-blue-200 hover:bg-blue-950/50 transition-colors mb-4"
      >
        New to OpenTelemetry? <span className="font-semibold underline">Start here</span>
      </a>
      <h2 className="text-lg font-semibold mb-4 text-gray-200">{heading}</h2>
      <div className="mb-4">
        <ConnectionForm
          value={formValue}
          onChange={(next) => setEnvVars(fromFormValue(envVars, next))}
          errors={errors}
          showApiKey={showApiKey}
          onToggleApiKey={() => setShowApiKey(s => !s)}
          hideName
          hideSignals
        />
      </div>

      {setupError && (
        <div className="mb-4 flex gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm items-start">
          <X className="w-4 h-4 text-danger-text flex-shrink-0 mt-0.5" aria-label="Error" />
          <div><span className="text-danger-text font-semibold">Verification failed:</span> <span className="text-gray-300">{setupError}</span></div>
        </div>
      )}

      <div className="space-y-2 mb-3">
        <button
          type="button"
          onClick={onTestConnection}
          disabled={testingConnection || !canSubmit}
          className="inline-flex items-center gap-2 px-4 py-2 rounded font-semibold text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60"
          title={!canSubmit ? 'Fill in valid Endpoint and API Key first' : 'Probe Helix with the values above (does not save)'}
        >
          {testingConnection ? (<><Loader2 className="w-4 h-4 animate-spin" /> Testing…</>) : 'Test connection'}
        </button>
        {testConnectionResult && (
          <div role="status" aria-live="polite" className={`flex items-start gap-2 text-tiny p-2.5 rounded border ${
            testConnectionResult.status === 'valid' ? 'bg-success/10 border-success/40 text-success-text' : 'bg-warning/10 border-warning/40 text-warning'
          }`}>
            {testConnectionResult.status === 'valid'
              ? <Check className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
            <div className="flex-1">
              <div className="text-gray-200">{testConnectionResult.message}</div>
              {testConnectionResult.remediation && <p className="text-gray-400 mt-0.5">{testConnectionResult.remediation}</p>}
            </div>
          </div>
        )}
      </div>

      <button
        onClick={onInitialize}
        disabled={isVerifying || !canSubmit}
        title={!canSubmit ? 'Fix the field errors above before continuing' : ''}
        className="w-full bg-primary hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded font-semibold transition-all"
      >
        {isVerifying ? 'Saving…' : primaryLabel}
      </button>
    </div>
  );
};
