import React from 'react';
import { CheckCircle2, AlertTriangle, Hexagon, Loader2 } from 'lucide-react';
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

type Props = {
  bridgeStatus: BridgeStatus;
  detectedCollectors: DetectedCollector[];
  receiverNow: ReceiverCounters | null;
  receiverBaseline: ReceiverCounters | null;
  receiverError: string;
  appExportErrors: { container: string; lines: string[] }[];
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
    <div className={`font-mono text-xl mt-1 ${value > 0 ? 'text-success' : 'text-gray-300'}`}>{value > 0 ? '+' : ''}{value}</div>
  </div>
);

export const Step4: React.FC<Props> = ({
  bridgeStatus,
  detectedCollectors,
  receiverNow,
  receiverBaseline,
  receiverError,
  appExportErrors,
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

  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 4: Verify telemetry is flowing</h2>
      <p className="text-sm text-gray-400 mb-5">Restart your app or collector first if you just changed config.</p>

      {bridgeStatus?.kind === 'skipped' && !someoneAttached && (
        <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-gray-200">
            <span className="font-semibold">Auto-attach was skipped and helix-gateway isn't sharing a network with any detected collector.</span>{' '}
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
            <span className="font-semibold">Auto-attach failed in Step 1: </span>{bridgeStatus.reason}.{' '}
            <button onClick={() => onJumpToStep(3)} className="text-active hover:underline font-semibold">Go back to Step 3</button>{' '}
            to connect manually if you haven't already.
          </span>
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
            <div className="text-tiny text-warning font-semibold uppercase tracking-wider mb-1">⚠ Errors detected on your side</div>
            {appExportErrors.map(err => (
              <div key={err.container} className="mb-2 last:mb-0">
                <div className="text-tiny text-gray-300 font-mono mb-0.5">{err.container}</div>
                <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-all bg-gray-1000 rounded p-2 max-h-32 overflow-auto select-text" style={{ fontFamily: "'Source Code Pro', monospace" }}>{err.lines.slice(-3).join('\n')}</pre>
              </div>
            ))}
            <div className="text-tiny text-gray-400 mt-1">
              Common fixes: confirm the container is on the <code className="font-mono text-gray-300">helix-bridge</code> network, the endpoint is <code className="font-mono text-gray-300">http://helix-gateway:4318</code> (not gRPC :4317), and the API key is correct.
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
                <div className="mt-2 text-tiny text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1.5">
                  <span className="font-semibold">Heads up:</span> your <code className="font-mono">HELIX_API_KEY</code> is a placeholder — Helix returns 200 for any request. Replace it with a real tenant key.
                </div>
              )}
            </div>
          </div>
        ) : traceVerifyResult && traceVerifyResult.status === 'rejected' ? (
          <div className="flex items-start gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm">
            <span className="text-danger font-bold flex-shrink-0 leading-tight">×</span>
            <div>
              <span className="text-gray-200 font-semibold">Helix rejected the trace.</span>
              <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
              {traceVerifyResult.remediation && <p className="text-tiny text-gray-400 mt-1">{traceVerifyResult.remediation}</p>}
            </div>
          </div>
        ) : traceVerifyResult && traceVerifyResult.status === 'pending' ? (
          <div className="flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
            <div>
              <span className="text-gray-200 font-semibold">Trace queued but not yet exported.</span>
              <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
              {traceVerifyResult.remediation && <p className="text-tiny text-gray-400 mt-1">{traceVerifyResult.remediation}</p>}
            </div>
          </div>
        ) : traceVerifyResult && traceVerifyResult.status === 'error' ? (
          <div className="flex items-start gap-3 p-3 bg-danger/10 border border-danger/40 rounded text-sm">
            <span className="text-danger font-bold flex-shrink-0 leading-tight">×</span>
            <div>
              <span className="text-gray-200 font-semibold">Verification failed.</span>
              <span className="text-gray-300 ml-1">{traceVerifyResult.message}.</span>
              {traceVerifyResult.remediation && <p className="text-tiny text-gray-400 mt-1">{traceVerifyResult.remediation}</p>}
            </div>
          </div>
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
          onClick={onLaunchDashboard}
          className="flex-1 bg-success hover:bg-success-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm"
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
