import React from 'react';
import { CheckCircle2, AlertTriangle, Hexagon, Loader2, X } from 'lucide-react';
import type { BridgeStatus, DetectedCollector } from './Step3';
import type { EnvVars } from './Step1';

type ReceiverCounters = {
  acceptedSpans: number;
  acceptedMetricPoints: number;
  acceptedLogRecords: number;
};

type TraceVerifyResult = {
  status: string;
  message: string;
  remediation?: string;
} | null;

type ApiKeyProbe = {
  status: string;
  message: string;
  remediation?: string;
  httpStatus?: number;
} | null;

type Props = {
  bridgeStatus: BridgeStatus;
  detectedCollectors: DetectedCollector[];
  receiverNow: ReceiverCounters | null;
  receiverBaseline: ReceiverCounters | null;
  receiverError: string;
  appExportErrors: { container: string; lines: string[] }[];
  gatewayStatus: string;
  restartingGateway: boolean;
  onRestartGateway: () => void;
  apiKeyProbe: ApiKeyProbe;
  probingApiKey: boolean;
  onProbeApiKey: () => void;
  traceVerifyResult: TraceVerifyResult;
  verifyingTrace: boolean;
  envVars: EnvVars;
  onJumpToStep: (step: number) => void;
  onVerifyTelemetry: () => void;
  onLaunchDashboard: () => void;
};

const delta = (now: number | undefined, base: number | undefined) =>
  typeof now === 'number' && typeof base === 'number' ? Math.max(0, now - base) : 0;

const CounterCard: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="bg-gray-1000 border border-gray-800 rounded px-3 py-2.5">
    <div className="text-tiny text-gray-500 uppercase tracking-wider">{label}</div>
    <div className={`text-xl font-semibold tabular-nums mt-1 ${value > 0 ? 'text-success' : 'text-gray-300'}`}>{value > 0 ? '+' : ''}{value}</div>
  </div>
);

export const Step4: React.FC<Props> = ({
  bridgeStatus,
  detectedCollectors,
  receiverNow,
  receiverBaseline,
  receiverError,
  appExportErrors,
  gatewayStatus,
  restartingGateway,
  onRestartGateway,
  apiKeyProbe,
  probingApiKey,
  onProbeApiKey,
  traceVerifyResult,
  verifyingTrace,
  envVars,
  onJumpToStep,
  onVerifyTelemetry,
  onLaunchDashboard,
}) => {
  const dSpans = delta(receiverNow?.acceptedSpans, receiverBaseline?.acceptedSpans);
  const dMetrics = delta(receiverNow?.acceptedMetricPoints, receiverBaseline?.acceptedMetricPoints);
  const dLogs = delta(receiverNow?.acceptedLogRecords, receiverBaseline?.acceptedLogRecords);
  const someoneAttached = detectedCollectors.some(c => c.sharesNetworkWithSidecar);
  const k8sDetected = detectedCollectors.some(c => c.isKubernetes);
  // Show the gateway-status warning only once we've actually probed the
  // status (status !== 'unknown') and it's not the healthy state. The
  // 'restarting' state is the transient one we set ourselves on click.
  const gatewayNotRunning = gatewayStatus !== 'unknown' && gatewayStatus !== 'running';

  // Inline "Test API key against Helix" affordance — appears under each
  // failed verify branch. Bypasses the gateway and posts a synthetic OTLP
  // payload directly to Helix to disambiguate "key rejected" from
  // "pipeline broken" (the verify-trace check can fail for both reasons).
  const probeIsSuccess = apiKeyProbe?.status === 'valid';
  // Probe failures (rejected/tenant-error/network-error/helix-error) all
  // either point at Step 1 fields (HELIX_API_KEY, HELIX_ENDPOINT) or, in the
  // network-error case, a typo or misconfigured URL — also a Step 1 fix.
  // Offer a direct jump-back so the user doesn't have to click their way
  // up the Stepper looking for the right field.
  const probeNeedsStep1Fix = apiKeyProbe != null && apiKeyProbe.status !== 'valid';

  // Shared shell for the 4 failure-tone trace-verify banners (rejected /
  // queued_customer / queued_gateway / pending / error). Each used to be
  // 7 lines of nearly-identical JSX. Each tone maps to color + icon.
  type BannerTone = 'success' | 'warning' | 'danger';
  const renderTraceBanner = (
    tone: BannerTone,
    title: string,
    message: string,
    remediation: string | undefined,
    includeProbe: boolean,
  ) => {
    const toneClasses = tone === 'success'
      ? 'bg-success/10 border-success/40'
      : tone === 'warning'
        ? 'bg-warning/10 border-warning/40'
        : 'bg-danger/10 border-danger/40';
    const icon = tone === 'success'
      ? <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
      : tone === 'warning'
        ? <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
        : <X className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" aria-label="Error" />;
    return (
      <div className={`flex items-start gap-3 p-3 border rounded text-sm ${toneClasses}`}>
        {icon}
        <div className="flex-1">
          <span className="text-gray-200 font-semibold">{title}</span>
          <span className="text-gray-300 ml-1">{message}.</span>
          {remediation && <p className="text-tiny text-gray-400 mt-1">{remediation}</p>}
          {includeProbe && renderApiKeyProbe()}
        </div>
      </div>
    );
  };
  const renderApiKeyProbe = () => (
    <div className="mt-2 pt-2 border-t border-gray-800/60">
      {apiKeyProbe ? (
        <div className={`flex items-start gap-2 text-tiny ${probeIsSuccess ? 'text-success' : 'text-warning'}`}>
          {probeIsSuccess
            ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          <div className="flex-1">
            <div className="text-gray-200">
              <span className="font-semibold">API key probe:</span>{' '}
              <span className="text-gray-300">{apiKeyProbe.message}</span>
            </div>
            {apiKeyProbe.remediation && <p className="text-gray-400 mt-0.5">{apiKeyProbe.remediation}</p>}
            {probeNeedsStep1Fix && (
              <div className="mt-1.5 flex items-center gap-3 flex-wrap">
                <button
                  onClick={() => onJumpToStep(1)}
                  className="inline-flex items-center gap-1 text-tiny font-semibold text-active hover:underline"
                  title="Go back to Step 1 to update HELIX_API_KEY or HELIX_ENDPOINT"
                >
                  Fix in Step 1 →
                </button>
                <span className="text-tiny text-gray-500">After saving Step 1, come back here and click Re-test or Verify again.</span>
              </div>
            )}
          </div>
          <button
            onClick={onProbeApiKey}
            disabled={probingApiKey}
            className="text-active hover:underline font-semibold disabled:opacity-60 flex-shrink-0"
          >Re-test</button>
        </div>
      ) : (
        <button
          onClick={onProbeApiKey}
          disabled={probingApiKey}
          className="inline-flex items-center gap-1.5 text-tiny text-active hover:underline font-semibold disabled:opacity-60"
        >
          {probingApiKey && <Loader2 className="w-3 h-3 animate-spin" />}
          {probingApiKey ? 'Probing Helix…' : 'Test API key against Helix →'}
        </button>
      )}
    </div>
  );

  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 4: Verify telemetry is flowing</h2>
      <p className="text-sm text-gray-400 mb-5">Restart your app or collector first if you just changed config.</p>

      {!someoneAttached && (
        // Step 3 hasn't wired the gateway to any detected collector's
        // network yet. Live counters will stay at zero on this page until
        // they do. Auto-bridge no longer exists — Step 3 is the only path.
        <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-gray-200">
            <span className="font-semibold">helix-gateway isn't sharing a network with any detected collector yet.</span>{' '}
            Live counters will stay at zero until you{' '}
            <button onClick={() => onJumpToStep(3)} className="text-active hover:underline font-semibold">go back to Step 3</button>{' '}
            and attach.
          </span>
        </div>
      )}
      {bridgeStatus?.kind === 'error' && (
        <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-gray-200">
            <span className="font-semibold">Step 1 didn't fully apply: </span>{bridgeStatus.reason}.{' '}
            <button onClick={() => onJumpToStep(1)} className="text-active hover:underline font-semibold">Go back to Step 1</button>{' '}
            to retry or restart helix-gateway from the dashboard.
          </span>
        </div>
      )}

      {gatewayNotRunning && (
        <div className="mb-4 flex items-start gap-3 p-3 rounded border border-warning/40 bg-warning/10 text-sm">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-gray-200">
              <span className="font-semibold">Helix gateway is not running</span>
              {gatewayStatus === 'restarting'
                ? <> — restarting…</>
                : <> (<code className="font-mono text-gray-300">{gatewayStatus}</code>). Telemetry from your collector won't reach Helix until it's back up.</>}
            </div>
          </div>
          <button
            onClick={onRestartGateway}
            disabled={restartingGateway || gatewayStatus === 'restarting'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-tiny rounded font-semibold bg-warning hover:bg-warning/90 text-gray-1000 disabled:opacity-60 flex-shrink-0"
          >
            {restartingGateway || gatewayStatus === 'restarting'
              ? (<><Loader2 className="w-3 h-3 animate-spin" /> Restarting</>)
              : 'Restart gateway'}
          </button>
        </div>
      )}

      <div className="mb-5">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Live counters
        </div>
        <div className="grid grid-cols-3 gap-3">
          <CounterCard label="Spans" value={dSpans} />
          <CounterCard label="Metric points" value={dMetrics} />
          <CounterCard label="Log records" value={dLogs} />
        </div>
        {receiverError && <div className="mt-2 text-tiny text-warning">⚠ {receiverError}</div>}
        {appExportErrors.length > 0 && (
          <div className="mt-3 p-2.5 rounded border border-warning/40 bg-warning/10">
            <div className="text-tiny text-warning font-semibold uppercase tracking-wider mb-1">⚠ Errors detected in your collector</div>
            {appExportErrors.map(err => (
              <div key={err.container} className="mb-2 last:mb-0">
                <div className="text-tiny text-gray-300 font-mono mb-0.5">{err.container}</div>
                <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-all bg-gray-1000 rounded p-2 max-h-32 overflow-auto select-text" style={{ fontFamily: "'Source Code Pro', monospace" }}>{err.lines.slice(-3).join('\n')}</pre>
              </div>
            ))}
            <div className="text-tiny text-gray-400 mt-1">
              Common fixes: confirm the collector shares a network with <code className="font-mono text-gray-300">helix-gateway</code>, the exporter endpoint is <code className="font-mono text-gray-300">http://helix-gateway:4318</code> (not gRPC :4317), and the API key is correct.
            </div>
          </div>
        )}
      </div>

      {k8sDetected && (
        <div className="mb-5 flex items-start gap-3 p-2.5 rounded border border-primary/40 bg-primary/10 text-tiny text-gray-300">
          <Hexagon className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
          <span>Kubernetes detected — <code className="font-mono">k8s.namespace.name</code> and <code className="font-mono">k8s.cluster.name</code> are being enriched automatically via the K8s Attribute Enrichment template.</span>
        </div>
      )}

      <div className="mb-5">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Gateway → Helix</div>
        {traceVerifyResult && traceVerifyResult.status === 'exported' ? (
          <div className="flex items-start gap-3 p-3 bg-success/10 border border-success/40 rounded text-sm">
            <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="text-gray-200 font-semibold">Synthetic trace reached Helix.</span>
              <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
              <div className="text-tiny text-gray-500 mt-1">
                Run <button onClick={onVerifyTelemetry} disabled={verifyingTrace} className="text-active hover:underline font-semibold disabled:opacity-60">again</button> any time.
              </div>
              {envVars.HELIX_API_KEY && envVars.HELIX_API_KEY.startsWith('FAKE-') && (
                <div className="mt-2 text-tiny text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1.5 flex items-start gap-2">
                  <span className="flex-1">
                    <span className="font-semibold">Heads up:</span> your <code className="font-mono">HELIX_API_KEY</code> is a placeholder — Helix returns 200 for any request. Replace it with a real tenant key.
                  </span>
                  <button
                    onClick={() => onJumpToStep(1)}
                    className="font-semibold text-active hover:underline flex-shrink-0"
                  >Fix in Step 1 →</button>
                </div>
              )}
            </div>
          </div>
        ) : traceVerifyResult && traceVerifyResult.status === 'rejected' ? (
          renderTraceBanner('danger', 'Helix rejected the trace.', traceVerifyResult.message, traceVerifyResult.remediation, true)
        ) : traceVerifyResult && traceVerifyResult.status === 'queued_customer' ? (
          // Customer collector is queueing or failing — gateway is unreachable
          // from its side. Remediation lives in Step 3, so suppress the API
          // key probe (it'd be misleading here).
          renderTraceBanner('warning', 'Trace stuck at your collector — helix-gateway not reachable from it.', traceVerifyResult.message, traceVerifyResult.remediation, false)
        ) : traceVerifyResult && traceVerifyResult.status === 'queued_gateway' ? (
          renderTraceBanner('warning', "Trace queued at the gateway — Helix hasn't acknowledged.", traceVerifyResult.message, traceVerifyResult.remediation, true)
        ) : traceVerifyResult && traceVerifyResult.status === 'pending' ? (
          renderTraceBanner('warning', 'Trace queued but not yet exported.', traceVerifyResult.message, traceVerifyResult.remediation, true)
        ) : traceVerifyResult && traceVerifyResult.status === 'error' ? (
          renderTraceBanner('danger', 'Verification failed.', traceVerifyResult.message, traceVerifyResult.remediation, true)
        ) : (
          <div className="flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
            <span className="text-gray-200">Not yet verified. Run the synthetic check below.</span>
          </div>
        )}
      </div>

      <div className="flex gap-4">
        <button
          onClick={() => onJumpToStep(3)}
          className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
        >Back</button>
        <button
          onClick={onVerifyTelemetry}
          disabled={verifyingTrace}
          className="flex-1 bg-warning hover:bg-warning-hover text-gray-900 px-6 py-3 rounded font-semibold transition-all disabled:opacity-60 disabled:cursor-not-allowed text-sm flex items-center justify-center gap-2"
          title="Inject a synthetic trace and confirm it reaches Helix — independent of your app"
        >
          {verifyingTrace && <Loader2 className="w-4 h-4 animate-spin" />}
          {verifyingTrace ? 'Verifying…' : 'Verify gateway → Helix'}
        </button>
        <button
          // Disabled until Verify has run at least once. The user could
          // technically launch without running it (and pre-this gate, often
          // did), then hit a wall on the dashboard because nothing had
          // confirmed the gateway → Helix path is healthy. Any verify
          // outcome unlocks — even pending/queued/rejected — because if
          // they're debugging, the dashboard is the right next surface.
          onClick={onLaunchDashboard}
          disabled={!traceVerifyResult}
          title={!traceVerifyResult ? 'Run Verify gateway → Helix first so we know your pipeline is wired up before you leave onboarding.' : 'Open the gateway dashboard'}
          className="flex-1 bg-success hover:bg-success-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm disabled:opacity-60 disabled:cursor-not-allowed"
        >Launch dashboard</button>
      </div>

      <div className="mt-6 pt-4 border-t border-gray-800 text-tiny text-gray-500 leading-relaxed">
        <span className="font-semibold text-gray-400 uppercase tracking-wider">After launch:</span>
        <ul className="mt-2 space-y-1 list-disc list-inside">
          <li>Run a <span className="text-gray-300">Diagnostic Health Check</span> to validate config, API key, and tenant reachability.</li>
          <li>Use <span className="text-gray-300">Load Template</span> in the YAML editor to switch to a tail-sampling, Prometheus, or Kubernetes-attribute starter.</li>
          <li>Add an <span className="text-gray-300">AIOps Business Service Key</span> from Settings to enable the deep-link button.</li>
        </ul>
      </div>
    </div>
  );
};
