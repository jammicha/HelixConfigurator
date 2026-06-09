import React, { useState } from 'react';
import { Activity, AlertTriangle, Server, Play, Pause, RotateCw, Loader2 } from 'lucide-react';

type SystemHealth = {
  gatewayStatus: 'running' | 'restarting' | 'exited' | 'unknown' | 'error';
  gatewayExitCode?: number;
  throughput: { totalSpans: number; spansPerSec: number; windowMs: number };
  recentErrors: Array<{ ts: number; tag: string; message: string }>;
};

type ActionLoading = 'start' | 'stop' | 'restart' | null;

type Props = {
  health: SystemHealth | null;
  // Live gateway state polled in App.tsx — drives the inline action button
  // enablement so users can't double-Start while the daemon is mid-action.
  gatewayStatus: string;
  actionLoading: ActionLoading;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  // Kubernetes/operator onboarding target: the gateway is cluster-managed, so
  // hide the local Docker container state + start/stop/restart controls.
  k8sMode?: boolean;
};

const fmtRate = (rate: number): string => {
  if (rate === 0) return '0 spans/s';
  if (rate < 1) return `${(rate * 60).toFixed(1)} spans/min`;
  return `${rate.toFixed(1)} spans/s`;
};

const fmtAgo = (ts: number): string => {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
};

export const SystemHealthPanel: React.FC<Props> = ({ health, gatewayStatus, actionLoading, onStart, onStop, onRestart, k8sMode = false }) => {
  const [showErrors, setShowErrors] = useState(false);
  if (!health) {
    return (
      <div className="adapt-card">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">System health</div>
        <div className="text-tiny text-gray-500">Loading…</div>
      </div>
    );
  }
  const lastErr = health.recentErrors[0];
  const iconBtn = (loadingKey: ActionLoading, disabled: boolean, onClick: () => void, label: string, Icon: React.ComponentType<{ className?: string }>) => (
    <button
      onClick={onClick}
      disabled={disabled || actionLoading !== null}
      title={label}
      aria-label={label}
      className="p-1 text-gray-500 hover:text-gray-200 disabled:opacity-50 disabled:hover:text-gray-500 disabled:cursor-not-allowed"
    >
      {actionLoading === loadingKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
    </button>
  );
  return (
    <div className="adapt-card">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">System health</div>
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-1000 border border-gray-800 rounded p-3">
          <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><Server className="w-3 h-3" /> Gateway</div>
          {k8sMode ? (
            // K8s/operator targets: the gateway lives in the user's cluster and
            // the configurator is generate-only — the local Docker container
            // state (and its start/stop controls) would mislead here.
            <>
              <div className="text-sm font-semibold text-gray-200">in your cluster</div>
              <div className="text-tiny text-gray-500">Helm/Operator-managed — check it with kubectl</div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className={`text-sm font-semibold ${health.gatewayStatus === 'running' ? 'text-success-text' : 'text-warning'}`}>
                {health.gatewayStatus}{health.gatewayExitCode != null ? ` (${health.gatewayExitCode})` : ''}
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {iconBtn('start', gatewayStatus === 'running', onStart, 'Start', Play)}
                {iconBtn('stop', gatewayStatus === 'exited', onStop, 'Stop', Pause)}
                {iconBtn('restart', false, onRestart, 'Restart', RotateCw)}
              </div>
            </div>
          )}
        </div>
        <div className="bg-gray-1000 border border-gray-800 rounded p-3">
          <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><Activity className="w-3 h-3" /> Throughput (1h)</div>
          <div className="text-sm font-semibold text-gray-200 tabular-nums">{fmtRate(health.throughput.spansPerSec)}</div>
        </div>
        <div className="bg-gray-1000 border border-gray-800 rounded p-3">
          <div className="text-tiny text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" /> Last error</div>
          {lastErr ? (
            <>
              <div className="text-sm font-semibold text-warning truncate" title={lastErr.message}>{lastErr.tag}</div>
              <div className="text-tiny text-gray-500">{fmtAgo(lastErr.ts)}</div>
            </>
          ) : (
            <div className="text-sm text-gray-500">None</div>
          )}
        </div>
      </div>
      {health.recentErrors.length > 0 && (
        <div className="mt-3 border-t border-gray-800 pt-2">
          <button
            onClick={() => setShowErrors(s => !s)}
            className="text-tiny text-gray-400 hover:text-gray-200 font-semibold"
          >
            {showErrors ? 'Hide' : 'Show'} recent errors ({health.recentErrors.length})
          </button>
          {showErrors && (
            <ul className="mt-2 space-y-1">
              {health.recentErrors.map((e, i) => (
                <li key={i} className="text-tiny text-gray-400 flex gap-2">
                  <span className="text-gray-500 font-mono">{fmtAgo(e.ts)}</span>
                  <span className="text-gray-300 font-mono">{e.tag}</span>
                  <span className="text-gray-400 break-all">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
