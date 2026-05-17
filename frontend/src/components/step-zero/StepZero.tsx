import React, { useEffect, useState, useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import { Layer1Agentless } from './Layer1Agentless';
import type { AgentlessStatus } from './types';

export const StepZero: React.FC = () => {
  const [status, setStatus] = useState<AgentlessStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/step-zero/agentless/status', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as AgentlessStatus;
      setStatus(data);
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
      throw new Error(body.error || body.details || `HTTP ${r.status}`);
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

        <Layer1Agentless status={status} onEnable={enable} />

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
