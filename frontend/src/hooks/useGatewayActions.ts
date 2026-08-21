import { useState } from 'react';
import { waitForGatewayRunning } from '../utils/gateway';
import type { ShowToast } from './useToasts';

type ActionLoading = 'start' | 'stop' | 'restart' | null;

type Deps = {
  showToast: ShowToast;
  setGatewayStatus: (status: string) => void;
  setCollectorDiag: (diag: any) => void;
  pushTimelineEvent: (kind: 'restart', message: string) => void;
};

// Gateway start/stop/restart actions plus the shared actionLoading guard.
// start/stop share one shape; restart additionally flips the status pill to
// "restarting", records a timeline event, polls until the gateway settles,
// and refreshes the collector diagnostic.
export const useGatewayActions = ({
  showToast,
  setGatewayStatus,
  setCollectorDiag,
  pushTimelineEvent,
}: Deps) => {
  const [actionLoading, setActionLoading] = useState<ActionLoading>(null);

  const runGatewayAction = async (
    action: 'start' | 'stop',
    messages: { ok: string; fail: string; err: string },
  ) => {
    if (actionLoading) return;
    setActionLoading(action);
    try {
      const res = await fetch(`/api/lifecycle/${action}`, { method: 'POST' });
      showToast(res.ok ? messages.ok : messages.fail, res.ok ? 'success' : 'error');
    } catch (e) {
      showToast(messages.err, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleStart = () => runGatewayAction('start', {
    ok: 'Gateway Started Successfully', fail: 'Failed to start gateway', err: 'Error starting gateway',
  });
  const handleStop = () => runGatewayAction('stop', {
    ok: 'Gateway Stopped Successfully', fail: 'Failed to stop gateway', err: 'Error stopping gateway',
  });

  const handleRestart = async () => {
    if (actionLoading) return;
    setActionLoading('restart');
    setGatewayStatus('restarting');
    try {
      const res = await fetch('/api/lifecycle/restart', { method: 'POST' });
      if (res.ok) {
        showToast('Gateway Restarted Successfully');
        pushTimelineEvent('restart', 'Gateway restarted');
        // Poll for the gateway to settle instead of a blind 3s sleep.
        const ready = await waitForGatewayRunning(15000);
        if (!ready.ok) showToast(ready.error, 'error');
        const collectorStatus = await fetch('/api/diagnostics/collector').then(r => r.json());
        setCollectorDiag(collectorStatus);
      } else {
        showToast('Failed to restart gateway', 'error');
      }
    } catch (e) {
      showToast('Error restarting gateway', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  return { actionLoading, handleStart, handleStop, handleRestart };
};
