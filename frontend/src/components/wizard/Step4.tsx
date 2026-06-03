import React from 'react';
import { CheckCircle2, AlertTriangle, Hexagon, Loader2, X, ArrowRight } from 'lucide-react';
import type { BridgeStatus, DetectedCollector } from './Step3';
import { computeVerifyState } from './verifyVerdict';

type ReceiverCounters = {
  acceptedSpans: number;
  acceptedMetricPoints: number;
  acceptedLogRecords: number;
};

type Props = {
  bridgeStatus: BridgeStatus;
  detectedCollectors: DetectedCollector[];
  receiverNow: ReceiverCounters | null;
  receiverBaseline: ReceiverCounters | null;
  receiverError: string;
  appExportErrors: { container: string; lines: string[]; ongoing?: boolean; lastErrorAgeSec?: number | null }[];
  gatewayStatus: string;
  restartingGateway: boolean;
  onRestartGateway: () => void;
  onJumpToStep: (step: number) => void;
  onLaunchDashboard: () => void;
};

const delta = (now: number | undefined, base: number | undefined) =>
  typeof now === 'number' && typeof base === 'number' ? Math.max(0, now - base) : 0;

const CounterCard: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="bg-gray-1000 border border-gray-800 rounded px-3 py-2.5">
    <div className="text-tiny text-gray-500 uppercase tracking-wider">{label}</div>
    <div className={`text-xl font-semibold tabular-nums mt-1 ${value > 0 ? 'text-success-text' : 'text-gray-300'}`}>{value > 0 ? '+' : ''}{value}</div>
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
  onJumpToStep,
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

  // Single top-line verdict for "am I good or bad?" — pure, unit-tested logic in
  // verifyVerdict.ts. Flow wins over retry noise: if telemetry is arriving, the
  // collector's retry queue is just catching up, so we don't alarm. This is a
  // read-only read of the user's real telemetry — onboarding no longer injects
  // a synthetic trace, so nothing here gates leaving the step.
  const verdict = computeVerifyState({
    flowing: dSpans > 0 || dMetrics > 0 || dLogs > 0,
    ongoingErrors: appExportErrors.some(e => e.ongoing),
    hasErrors: appExportErrors.length > 0,
    gatewayNotRunning,
  });
  const verdictTone = {
    good: 'bg-success/10 border-success/40',
    warn: 'bg-warning/10 border-warning/40',
    bad: 'bg-danger/10 border-danger/40',
    idle: 'bg-gray-1000 border-gray-800',
  }[verdict.tone];
  const VerdictIcon = { good: CheckCircle2, warn: AlertTriangle, bad: X, idle: Hexagon }[verdict.tone];

  return (
    <div className="adapt-card">
      <h2 className="text-lg font-semibold mb-2 text-gray-200">Step 4: Verify telemetry is flowing</h2>
      <p className="text-sm text-gray-400 mb-4">If you just changed config, restart your app or collector before verifying.</p>

      <div className={`mb-4 flex items-start gap-3 p-3 rounded border ${verdictTone}`}>
        <VerdictIcon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${verdict.tone === 'good' ? 'text-success-text' : verdict.tone === 'warn' ? 'text-warning' : verdict.tone === 'bad' ? 'text-danger-text' : 'text-gray-400'}`} aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-100">{verdict.title}</div>
          <div className="text-tiny text-gray-300 mt-0.5">
            {verdict.detail}
            {verdict.step != null && (
              <> <button onClick={() => onJumpToStep(verdict.step!)} className="text-link hover:underline font-semibold">Go to Step {verdict.step}</button></>
            )}
          </div>
        </div>
      </div>

      {!someoneAttached && detectedCollectors.length > 0 && (
        // Collectors were detected on this host but none of them are bridged
        // to helix-gateway yet. Live counters will stay at zero until the
        // user attaches one via Step 3. Suppressed when no collectors were
        // detected at all — that case is "helix-gateway IS the collector,"
        // already covered by Step 3's skip path.
        <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-gray-200">
            <span className="font-semibold">helix-gateway isn't sharing a network with any detected collector yet.</span>{' '}
            Live counters will stay at zero until you{' '}
            <button onClick={() => onJumpToStep(3)} className="text-link hover:underline font-semibold">go back to Step 3</button>{' '}
            and attach.
          </span>
        </div>
      )}
      {bridgeStatus?.kind === 'error' && (
        <div className="mb-4 flex items-start gap-3 p-3 bg-warning/10 border border-warning/40 rounded text-sm">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-gray-200">
            <span className="font-semibold">Step 1 didn't fully apply: </span>{bridgeStatus.reason}.{' '}
            <button onClick={() => onJumpToStep(1)} className="text-link hover:underline font-semibold">Go back to Step 1</button>{' '}
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
                ? <> (restarting…)</>
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
        {verdict.errorPanel === 'warning' ? (
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
        ) : verdict.errorPanel === 'muted' ? (
          <div className="mt-3 text-tiny text-gray-500">
            Your collector logged a few export retries earlier; they've since cleared.
          </div>
        ) : null}
      </div>

      {k8sDetected && (
        <div className="mb-5 flex items-start gap-3 p-2.5 rounded border border-primary/40 bg-primary/10 text-tiny text-gray-300">
          <Hexagon className="w-3.5 h-3.5 text-link flex-shrink-0 mt-0.5" />
          <span>Kubernetes detected. <code className="font-mono">k8s.namespace.name</code> and <code className="font-mono">k8s.cluster.name</code> are being enriched automatically via the K8s Attribute Enrichment template.</span>
        </div>
      )}

      <div className="flex gap-4">
        <button
          onClick={() => onJumpToStep(3)}
          className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 px-6 py-3 rounded font-semibold transition-colors text-sm"
        >Back</button>
        <button
          onClick={onLaunchDashboard}
          title="Open the gateway dashboard"
          className="flex-1 bg-success hover:bg-success-hover text-white px-6 py-3 rounded font-semibold transition-all text-sm flex items-center justify-center gap-2"
        >Next: Link your service <ArrowRight className="w-4 h-4" /></button>
      </div>

      <div className="mt-6 pt-4 border-t border-gray-800 text-tiny text-gray-500 leading-relaxed">
        <span className="font-semibold text-gray-400 uppercase tracking-wider">After launch:</span>
        <ul className="mt-2 space-y-1 list-disc list-inside">
          <li>Run a <span className="text-gray-300">Diagnostic Health Check</span> to validate config, API key, and tenant reachability.</li>
          <li>Use <span className="text-gray-300">Load Template</span> in the YAML editor to switch to a tail-sampling, Prometheus, or Kubernetes-attribute starter.</li>
          <li>Use the dashboard's <span className="text-gray-300">Business Service</span> card to link a Business Service and enable the AIOps deep-link.</li>
        </ul>
      </div>
    </div>
  );
};
