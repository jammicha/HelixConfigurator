import { useState, useEffect, useCallback } from 'react';

// Status payload from /api/step-zero/synthetic/status. The destination
// ('gateway' vs 'local') is decided server-side based on whether
// HELIX_ENDPOINT is configured — clients don't gate on env readiness,
// so the local-fallback path works from zero per the Step 0 promise.
export type SyntheticStatus = {
  running: boolean;
  run_id?: string;
  sent_traces: number;
  sent_with_errors: number;
  elapsed_s?: number;
  eta_s?: number | null;
  destination?: 'gateway' | 'local';
  continuous?: boolean;
  helix_deep_link?: string | null;
  local_deep_link?: string;
};

export type UseSyntheticRun = {
  status: SyntheticStatus | null;
  starting: boolean;
  startError: string | null;
  // True once the user has run at least one scenario this session — drives
  // the "post-run summary vs first-time pitch" UI choice in callers that
  // want to distinguish those states (e.g. the full Layer2Synthetic card).
  haveRun: boolean;
  start: (opts?: { continuous?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
};

// Shared synthetic-scenario lifecycle: status polling + start/stop calls.
// Extracted from Layer2Synthetic so the OverviewTab empty state and the
// dashboard PipelineStatusBanner can offer the same "Run demo scenario"
// affordance without re-implementing the polling + error semantics.
//
// Polls every 1s while running and every 5s when idle. Multiple consumers
// can mount this independently — the server is the single source of truth,
// /status is read-only and cheap, and each consumer's local UI state stays
// in sync with what the server reports.
export function useSyntheticRun(): UseSyntheticRun {
  const [status, setStatus] = useState<SyntheticStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [haveRun, setHaveRun] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/step-zero/synthetic/status', { credentials: 'include' });
      if (!r.ok) return;
      const data = (await r.json()) as SyntheticStatus;
      setStatus(data);
      if (data.running || (data.sent_traces ?? 0) > 0) setHaveRun(true);
    } catch { /* transient; next poll retries */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, status?.running ? 1000 : 5000);
    return () => clearInterval(id);
  }, [fetchStatus, status?.running]);

  const start = useCallback(async (opts?: { continuous?: boolean }) => {
    setStartError(null);
    setStarting(true);
    try {
      const r = await fetch('/api/step-zero/synthetic/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ continuous: opts?.continuous ?? false }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      await fetchStatus();
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }, [fetchStatus]);

  const stop = useCallback(async () => {
    try {
      await fetch('/api/step-zero/synthetic/stop', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: status?.run_id }),
      });
      await fetchStatus();
    } catch { /* polling will reconcile */ }
  }, [fetchStatus, status?.run_id]);

  return { status, starting, startError, haveRun, start, stop };
}
