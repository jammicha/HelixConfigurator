import React from 'react';
import { parseHelixKeyBundle } from '../../utils/helixKey';

export type EnvVars = {
  HELIX_ENDPOINT: string;
  HELIX_API_KEY: string;
  X_SOURCE: string;
  APP_URL: string;
  BUSINESS_SERVICE_KEY: string;
};

type Props = {
  envVars: EnvVars;
  setEnvVars: (next: EnvVars) => void;
  showApiKey: boolean;
  setShowApiKey: (fn: (s: boolean) => boolean) => void;
  setupError: string;
  isVerifying: boolean;
  onInitialize: () => void;
};

// Per-field validation. Returns null when valid, or a short user-facing error.
const validateEndpoint = (value: string): string | null => {
  if (!value) return 'Required';
  if (!/^https?:\/\//i.test(value)) return 'Must start with https://';
  if (/\/otlp(\/|$)/.test(value)) return 'Remove /otlp/... — the gateway adds the path itself';
  try { new URL(value); } catch { return 'Not a valid URL'; }
  return null;
};
const validateApiKey = (value: string): string | null => {
  if (!value) return 'Required';
  const parts = value.split('::');
  if (parts.length !== 3 || parts.some(p => !p.trim())) {
    return 'Must be three non-empty :: separated parts';
  }
  return null;
};
const validateXSource = (value: string): string | null => {
  if (!value) return 'Required';
  if (!/^[a-zA-Z0-9\-_]+$/.test(value)) return 'Letters, digits, dash, underscore only';
  return null;
};
const validateAppUrl = (value: string): string | null => {
  if (!value) return null;
  try { new URL(value); } catch { return 'Not a valid URL'; }
  return null;
};

export const Step1: React.FC<Props> = ({
  envVars,
  setEnvVars,
  showApiKey,
  setShowApiKey,
  setupError,
  isVerifying,
  onInitialize,
}) => {
  const errors = {
    HELIX_ENDPOINT: validateEndpoint(envVars.HELIX_ENDPOINT),
    HELIX_API_KEY: validateApiKey(envVars.HELIX_API_KEY),
    X_SOURCE: validateXSource(envVars.X_SOURCE),
    APP_URL: validateAppUrl(envVars.APP_URL),
  };
  const canSubmit = Object.values(errors).every(e => e === null);

  return (
    <div className="adapt-card">
      <h2 className="text-lg font-bold mb-2 text-gray-200">Step 1: Configure helix-gateway</h2>
      <p className="text-sm text-gray-400 mb-6">Tell the sidecar where Helix lives and what to call your service. The gateway restarts on save.</p>
      <div className="space-y-4 mb-6">
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            Helix Endpoint
            {!errors.HELIX_ENDPOINT && envVars.HELIX_ENDPOINT && <span className="text-success normal-case tracking-normal">✓</span>}
          </label>
          <input
            type="url"
            name="helix-ingest-endpoint"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={envVars.HELIX_ENDPOINT}
            onChange={(e) => setEnvVars({ ...envVars, HELIX_ENDPOINT: e.target.value })}
            className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.HELIX_ENDPOINT && errors.HELIX_ENDPOINT ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
            placeholder="https://your-tenant.onbmc.com"
          />
          {envVars.HELIX_ENDPOINT && errors.HELIX_ENDPOINT && (
            <p className="text-tiny text-danger">{errors.HELIX_ENDPOINT}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2 flex-wrap">
            <span className="flex items-center gap-2">
              X-Source
              {!errors.X_SOURCE && envVars.X_SOURCE && <span className="text-success normal-case tracking-normal">✓</span>}
            </span>
            <span className="normal-case tracking-normal text-gray-500 font-normal">— Business Service name in Helix topology &amp; AIOps</span>
          </label>
          <input
            type="text"
            name="helix-x-source"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={envVars.X_SOURCE}
            onChange={(e) => setEnvVars({ ...envVars, X_SOURCE: e.target.value.replace(/[^a-zA-Z0-9\-_]/g, '') })}
            className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.X_SOURCE && errors.X_SOURCE ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
            placeholder="e.g. payment-service"
          />
          <p className="text-tiny text-gray-500">Choose a name that maps to a real service your team owns.</p>
          {envVars.X_SOURCE && errors.X_SOURCE && (
            <p className="text-tiny text-danger">{errors.X_SOURCE}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            X-API Key
            {!errors.HELIX_API_KEY && envVars.HELIX_API_KEY && <span className="text-success normal-case tracking-normal">✓</span>}
          </label>
          <div className="relative">
            <input
              type="text"
              name="helix-x-api-key"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              value={envVars.HELIX_API_KEY}
              onChange={(e) => {
                const parsed = parseHelixKeyBundle(e.target.value);
                setEnvVars({ ...envVars, HELIX_API_KEY: parsed ?? e.target.value });
              }}
              style={!showApiKey ? { WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties : undefined}
              className={`w-full bg-gray-1000 border rounded px-3 py-2 pr-16 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm ${envVars.HELIX_API_KEY && errors.HELIX_API_KEY ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
              placeholder="Paste your API key from the Helix portal"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(s => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-tiny text-gray-400 hover:text-gray-200 uppercase tracking-wider font-semibold px-1"
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-tiny text-gray-500">Paste the full key — the format is parsed automatically.</p>
          {envVars.HELIX_API_KEY && errors.HELIX_API_KEY && (
            <p className="text-tiny text-danger">{errors.HELIX_API_KEY}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2">
            <span>App URL</span>
            <span className="normal-case tracking-normal text-gray-500 font-normal">— optional</span>
          </label>
          <input
            type="url"
            name="helix-app-url"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={envVars.APP_URL}
            onChange={(e) => setEnvVars({ ...envVars, APP_URL: e.target.value })}
            className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.APP_URL && errors.APP_URL ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
            placeholder="http://localhost:8080"
          />
          {envVars.APP_URL && errors.APP_URL && (
            <p className="text-tiny text-danger">{errors.APP_URL}</p>
          )}
        </div>
      </div>

      {setupError && (
        <div className="mb-4 flex gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm items-start">
          <span className="text-danger font-bold flex-shrink-0 leading-tight">×</span>
          <div><span className="text-danger font-semibold">Verification failed:</span> <span className="text-gray-300">{setupError}</span></div>
        </div>
      )}

      <button
        onClick={onInitialize}
        disabled={isVerifying || !canSubmit}
        title={!canSubmit ? 'Fix the field errors above before continuing' : ''}
        className="w-full bg-primary hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-3 rounded font-semibold transition-all"
      >
        {isVerifying ? 'Saving…' : 'Save & initialize →'}
      </button>
    </div>
  );
};
