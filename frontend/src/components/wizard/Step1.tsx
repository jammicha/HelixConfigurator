import React from 'react';
import { Check, X, Loader2, AlertTriangle } from 'lucide-react';
import { parseHelixKeyBundle } from '../../utils/helixKey';
import { extractServiceKey } from '../otel-data/utils';

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
  onTestConnection: () => void;
  testConnectionResult: { status: string; message: string; remediation?: string; httpStatus?: number; latencyMs?: number } | null;
  testingConnection: boolean;
};

// Per-field validation. Returns null when valid, or a short user-facing error.
const validateEndpoint = (value: string): string | null => {
  if (!value) return 'Required';
  if (!/^https?:\/\//i.test(value)) return 'Must start with https://';
  if (/\/otlp(\/|$)/.test(value)) return 'Remove /otlp/... The gateway adds the path itself.';
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
  if (value !== value.trim()) return 'No leading or trailing whitespace';
  // OTel resource attribute values are arbitrary UTF-8 strings; only reject
  // control chars (which would also break the HTTP header these flow into).
  if (/[\x00-\x1f\x7f]/.test(value)) return 'Cannot contain control characters';
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
  onTestConnection,
  testConnectionResult,
  testingConnection,
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
      <a
        href="/step-zero"
        className="block rounded border border-blue-900 bg-blue-950/30 p-3 text-tiny text-blue-200 hover:bg-blue-950/50 transition-colors mb-4"
      >
        New to OpenTelemetry? <span className="font-semibold underline">Start here</span>
      </a>
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 1: Configure helix-gateway</h2>
      <p className="text-sm text-gray-400 mb-6">Tell the sidecar where Helix lives and what to call your service. The gateway restarts on save.</p>
      <div className="space-y-4 mb-6">
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            Helix Endpoint
            {!errors.HELIX_ENDPOINT && envVars.HELIX_ENDPOINT && <Check className="w-3.5 h-3.5 text-success inline" aria-label="OK" />}
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
            aria-invalid={!!(envVars.HELIX_ENDPOINT && errors.HELIX_ENDPOINT)}
            aria-describedby={envVars.HELIX_ENDPOINT && errors.HELIX_ENDPOINT ? 'helix-endpoint-error' : undefined}
            className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.HELIX_ENDPOINT && errors.HELIX_ENDPOINT ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
            placeholder="https://your-tenant.onbmc.com"
          />
          {envVars.HELIX_ENDPOINT && errors.HELIX_ENDPOINT && (
            <p id="helix-endpoint-error" className="text-tiny text-danger">{errors.HELIX_ENDPOINT}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            X-API Key
            {!errors.HELIX_API_KEY && envVars.HELIX_API_KEY && <Check className="w-3.5 h-3.5 text-success inline" aria-label="OK" />}
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
              aria-invalid={!!(envVars.HELIX_API_KEY && errors.HELIX_API_KEY)}
              aria-describedby={envVars.HELIX_API_KEY && errors.HELIX_API_KEY ? 'helix-api-key-error' : undefined}
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
          <p className="text-tiny text-gray-500">Paste the full key. The format is parsed automatically.</p>
          {envVars.HELIX_API_KEY && errors.HELIX_API_KEY && (
            <p id="helix-api-key-error" className="text-tiny text-danger">{errors.HELIX_API_KEY}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2 flex-wrap">
            <span className="flex items-center gap-2">
              X-Source
              {!errors.X_SOURCE && envVars.X_SOURCE && <Check className="w-3.5 h-3.5 text-success inline" aria-label="OK" />}
            </span>
            <span className="normal-case tracking-normal text-gray-500 font-normal">· Business Service name in Helix topology &amp; AIOps</span>
          </label>
          <input
            type="text"
            name="helix-x-source"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={envVars.X_SOURCE}
            onChange={(e) => setEnvVars({ ...envVars, X_SOURCE: e.target.value })}
            aria-invalid={!!(envVars.X_SOURCE && errors.X_SOURCE)}
            aria-describedby={envVars.X_SOURCE && errors.X_SOURCE ? 'helix-x-source-error' : undefined}
            className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.X_SOURCE && errors.X_SOURCE ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
            placeholder="e.g. payment-service"
          />
          <p className="text-tiny text-gray-500">Choose a name that will map to a business service in Helix AIOps.</p>
          {envVars.X_SOURCE && errors.X_SOURCE && (
            <p id="helix-x-source-error" className="text-tiny text-danger">{errors.X_SOURCE}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2">
            <span>App URL</span>
            <span className="normal-case tracking-normal text-gray-500 font-normal">· optional</span>
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
            aria-invalid={!!(envVars.APP_URL && errors.APP_URL)}
            aria-describedby={envVars.APP_URL && errors.APP_URL ? 'helix-app-url-error' : undefined}
            className={`w-full bg-gray-1000 border rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all text-sm ${envVars.APP_URL && errors.APP_URL ? 'border-danger/60 focus:border-danger' : 'border-gray-800 focus:border-active'}`}
            placeholder="https://example.com or http://localhost:8080"
          />
          <p className="text-tiny text-gray-500">
            Used for the "Open application" deep-link on the dashboard. <code className="font-mono">localhost</code>, an IP, or a public URL: anything that opens your app's UI from a browser is fine. Network wiring between helix-gateway and your collector happens on Step 3.
          </p>
          {envVars.APP_URL && errors.APP_URL && (
            <p id="helix-app-url-error" className="text-tiny text-danger">{errors.APP_URL}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-baseline gap-2">
            <span>AIOps Business Service Key</span>
            <span className="normal-case tracking-normal text-gray-500 font-normal">· optional</span>
          </label>
          <input
            type="text"
            name="helix-business-service-key"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={envVars.BUSINESS_SERVICE_KEY}
            // Accept the bare opaque key, a URL fragment, or the full AIOps
            // service URL. extractServiceKey normalizes all three to the
            // opaque key the backend stores — saves the user a paste-trim-
            // copy round trip when they grab the URL from their browser bar.
            onChange={(e) => setEnvVars({ ...envVars, BUSINESS_SERVICE_KEY: extractServiceKey(e.target.value) })}
            className="w-full bg-gray-1000 border border-gray-800 focus:border-active rounded px-3 py-2 text-gray-100 focus:outline-none focus:shadow-[0_0_0_2px_rgba(55,89,216,0.2)] transition-all font-mono text-sm"
            placeholder="e.g. LYVlMZN2grhnvxM4uik8s5PmVpJNidFS, or paste the full AIOps service URL"
          />
          <p className="text-tiny text-gray-500">
            Enables the "Open in AIOps" deep-link on the dashboard and the per-trace "Send to AIOps" pin on the trace viewer. Find it at <code className="font-mono">https://&lt;tenant&gt;/aiops/#/entities/service/&lt;KEY&gt;?type=key</code>. Paste either the key or the full URL.
          </p>
        </div>
      </div>

      {setupError && (
        <div className="mb-4 flex gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm items-start">
          <X className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" aria-label="Error" />
          <div><span className="text-danger font-semibold">Verification failed:</span> <span className="text-gray-300">{setupError}</span></div>
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
            testConnectionResult.status === 'valid' ? 'bg-success/10 border-success/40 text-success' : 'bg-warning/10 border-warning/40 text-warning'
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
        className="w-full bg-primary hover:bg-primary-hover disabled:opacity-60 disabled:cursor-not-allowed text-white px-6 py-3 rounded font-semibold transition-all"
      >
        {isVerifying ? 'Saving…' : 'Save & initialize →'}
      </button>
    </div>
  );
};
