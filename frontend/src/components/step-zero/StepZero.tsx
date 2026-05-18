import React, { useEffect, useState, useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import { Layer1Agentless } from './Layer1Agentless';
import { Layer2Synthetic } from './Layer2Synthetic';
import type { AgentlessStatus } from './types';

export const StepZero: React.FC = () => {
  const [status, setStatus] = useState<AgentlessStatus | null>(null);
  // envReady gates the Enable buttons. The gateway's existing bmchelix exporter
  // refuses to start without HELIX_ENDPOINT, so clicking Enable before Step 1
  // is complete triggers a rollback. We block at the UI to avoid the cryptic
  // "rolled back" error and surface a clear "Complete Step 1 first" affordance.
  // Long-term fix is Option B in the design notes: wire Step 0 metrics into
  // the local viewer so the bmchelix dependency is decoupled.
  const [envReady, setEnvReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Fetch status and env in parallel — both are cheap reads, and the env
      // re-check on every poll means Step 0 unlocks live when the user
      // finishes Step 1 in another tab/window without a page reload.
      const [statusRes, envRes] = await Promise.all([
        fetch('/api/step-zero/agentless/status', { credentials: 'include' }),
        fetch('/api/env', { credentials: 'include' }),
      ]);
      if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
      const data = (await statusRes.json()) as AgentlessStatus;
      setStatus(data);
      if (envRes.ok) {
        const env = await envRes.json().catch(() => ({}));
        setEnvReady(!!(env && typeof env === 'object' && env.HELIX_ENDPOINT));
      }
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Initial fetch + 5s poll. Hidden-tab pauses to save battery.
  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, 5000);
    const onVis = () => { if (document.visibilityState !== 'hidden') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  const enable = useCallback(async (receiver: 'hostmetrics' | 'dockerstats') => {
    const r = await fetch(`/api/step-zero/agentless/${receiver}/enable`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      // Surface the backend's `details` field alongside `error` so users see
      // the actual collector rejection reason instead of just "rolled back".
      const detail = body.details ? `: ${body.details}` : '';
      throw new Error(`${body.error || `HTTP ${r.status}`}${detail}`);
    }
    await refresh();
  }, [refresh]);

  return (
    <div className="min-h-screen bg-gray-1000 text-gray-100">
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Start from zero</h1>
          <p className="text-sm text-gray-400">
            Get telemetry flowing into Helix without instrumenting your apps. Click a button below
            and the Helix Gateway will start scraping data on your behalf.
          </p>
        </header>

        {err && (
          <div className="rounded border border-red-900 bg-red-950/40 text-red-200 text-sm p-3">
            Failed to load status: {err}
          </div>
        )}

        <Layer2Synthetic />

        <details className="rounded-lg border border-gray-800 bg-gray-1000">
          <summary className="cursor-pointer select-none px-6 py-4 text-tiny font-semibold text-gray-300 hover:text-gray-100">
            ▸ Advanced: pull host/container metrics directly
          </summary>
          <div className="px-6 pb-6">
            <Layer1Agentless status={status} envReady={envReady} onEnable={enable} />
          </div>
        </details>

        <footer className="pt-4 border-t border-gray-800">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100"
          >
            Continue to the full wizard <ArrowRight className="w-4 h-4" />
          </a>
        </footer>
      </main>
    </div>
  );
};
