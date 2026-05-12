import React, { useEffect, useRef, useState } from 'react';
import { Container, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { SnippetBlock } from '../SnippetBlock';
import type { SmartAddProposal, SmartAddResult } from '../../hooks/useSmartAdd';

type Props = {
  smartAddProposal: SmartAddProposal | null;
  smartAddResult: SmartAddResult | null;
  smartAddLoading: boolean;
  onOpenSmartAddPreview: () => void;
  onOpenGatewayConfig: () => void;
  onDismissResult: () => void;
  onVerifyExporter: (() => void) | null;
  onBack: () => void;
  onNext: () => void;
};

export const Step2: React.FC<Props> = ({
  smartAddProposal,
  smartAddResult,
  smartAddLoading,
  onOpenSmartAddPreview,
  onOpenGatewayConfig,
  onDismissResult,
  onVerifyExporter,
  onBack,
  onNext,
}) => {
  // Track verify-button result inline. Without this the button does nothing
  // visually for fast local YAML re-reads — the proposal might transition
  // alreadyConfigured → alreadyConfigured with no UI delta.
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'done'>('idle');
  const sawLoadingRef = useRef(false);
  useEffect(() => {
    if (verifyStatus !== 'verifying') return;
    if (smartAddLoading) {
      sawLoadingRef.current = true;
    } else if (sawLoadingRef.current) {
      sawLoadingRef.current = false;
      setVerifyStatus('done');
      const t = setTimeout(() => setVerifyStatus('idle'), 2500);
      return () => clearTimeout(t);
    }
  }, [smartAddLoading, verifyStatus]);
  const handleVerify = () => {
    if (!onVerifyExporter) return;
    setVerifyStatus('verifying');
    onVerifyExporter();
  };
  const verifyBadge = verifyStatus === 'verifying'
    ? (<span className="inline-flex items-center gap-1 text-tiny text-gray-400"><Loader2 className="w-3 h-3 animate-spin" /> Verifying…</span>)
    : verifyStatus === 'done'
    ? (<span className="inline-flex items-center gap-1 text-tiny text-success"><CheckCircle2 className="w-3 h-3" /> Verified just now</span>)
    : null;

  return (
  <div className="adapt-card">
    <h2 className="text-lg font-bold mb-4 text-gray-200">Step 2: Add helix-gateway as an exporter</h2>

    <div className="mb-4 flex items-start gap-3 p-3 bg-active/10 border border-active/40 rounded text-sm">
      <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
      <span className="text-gray-200"><span className="font-semibold">helix-gateway is already configured.</span> Just add it as an exporter in your collector config.</span>
    </div>

    {/* Smart-add — when exactly one OTel collector is detected on this host,
        the configurator can read its config, compute the merge, and apply it
        (with a backup + restart) for the user. POC scope. */}
    {smartAddResult && (
      <div className={`mb-4 flex items-start gap-3 p-3 rounded text-sm ${smartAddResult.ok ? 'bg-success/10 border border-success/40' : 'bg-danger/10 border border-danger/40'}`}>
        {smartAddResult.ok ? <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />}
        <span className="text-gray-200 flex-1 break-words">{smartAddResult.message}</span>
        <button
          onClick={onDismissResult}
          className="text-gray-400 hover:text-gray-200 p-0.5 rounded hover:bg-gray-800 flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    )}
    {smartAddProposal && (
      <div className="mb-5 p-4 bg-gray-1000 border border-active/40 rounded">
        <div className="flex items-center gap-2 mb-2">
          <Container className="w-4 h-4 text-active" />
          <span className="text-sm font-semibold text-gray-100">Smart-add — apply automatically</span>
          <span className="ml-auto text-tiny text-gray-500">POC</span>
        </div>
        {smartAddProposal.error ? (
          <>
            <p className="text-tiny text-warning mb-3">⚠ {smartAddProposal.error} You can still apply the snippet below manually.</p>
            {onVerifyExporter && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleVerify}
                  disabled={verifyStatus === 'verifying'}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60"
                >Verify exporter</button>
                {verifyBadge}
              </div>
            )}
          </>
        ) : smartAddProposal.alreadyConfigured ? (
          <>
            <p className="text-tiny text-gray-300 mb-3">
              Detected <code className="font-mono text-gray-100">{smartAddProposal.name}</code> at <code className="font-mono text-gray-200">{smartAddProposal.configPath}</code>.{' '}
              <span className="text-success font-semibold">Already configured</span> — <code className="font-mono">{smartAddProposal.existingExporterName}</code> already points at <code className="font-mono">helix-gateway:4318</code>. No changes needed.
            </p>
            {onVerifyExporter && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleVerify}
                  disabled={verifyStatus === 'verifying'}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60"
                >Re-verify exporter</button>
                {verifyBadge}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-tiny text-gray-300 mb-3">
              Detected <code className="font-mono text-gray-100">{smartAddProposal.name}</code> at <code className="font-mono text-gray-200">{smartAddProposal.configPath}</code>.{' '}
              We'll add <code className="font-mono text-gray-100">{smartAddProposal.exporterName}</code> as an exporter and wire it into{' '}
              <strong className="text-gray-200">{(smartAddProposal.addedToPipelines || []).join(', ')}</strong> pipelines.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={onOpenSmartAddPreview}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-primary hover:bg-primary-hover text-white"
              >
                Review changes
              </button>
              {onVerifyExporter && (
                <button
                  onClick={handleVerify}
                  disabled={verifyStatus === 'verifying'}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-tiny rounded font-semibold uppercase tracking-wider bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60"
                  title="Re-check whether helix-gateway is already wired into this collector's pipelines"
                >Verify exporter</button>
              )}
              {verifyBadge}
              <span className="text-tiny text-gray-500">Or copy the snippets below to apply manually.</span>
            </div>
          </>
        )}
      </div>
    )}
    {smartAddLoading && (
      <div className="mb-4 flex items-center gap-2 text-tiny text-gray-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading detected collector config…
      </div>
    )}

    <div className="mb-2 flex items-baseline justify-between gap-3">
      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Exporter</span>
    </div>
    <SnippetBlock text={`exporters:
  otlphttp/helix_sidecar:
    endpoint: "http://helix-gateway:4318"
    tls:
      insecure: true`} />
    <p className="text-tiny text-gray-500 -mt-4 mb-6">
      In your main collector config (e.g. <code className="font-mono">otelcol-config.yaml</code>). No API key needed here —{' '}
      <button onClick={onOpenGatewayConfig} className="text-active hover:underline font-semibold">view gateway config to see where it's set</button>.
    </p>

    <div className="mb-2 flex items-baseline justify-between gap-3">
      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Pipelines</span>
    </div>
    <SnippetBlock text={`service:
  pipelines:
    traces:
      exporters: [..., otlphttp/helix_sidecar]
    metrics:
      exporters: [..., otlphttp/helix_sidecar]
    logs:
      exporters: [..., otlphttp/helix_sidecar]`} />
    <p className="text-tiny text-gray-500 -mt-4 mb-6">Wire into whichever pipelines your collector uses. Restart your collector after saving.</p>

    <div className="mb-3 flex items-start gap-2.5 p-3 rounded border border-warning/40 bg-warning/10 text-tiny text-gray-300">
      <span className="text-warning font-bold flex-shrink-0 leading-tight" aria-hidden="true">!</span>
      <span>After saving, restart your collector container so the new exporter takes effect.</span>
    </div>
    <div className="flex gap-4">
      <button
        onClick={onBack}
        className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
      >Back</button>
      <button
        onClick={onNext}
        className="flex-1 bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm"
      >Next: Connect →</button>
    </div>
  </div>
  );
};
