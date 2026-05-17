import React from 'react';
import type { AgentlessStatus } from './types';

type Props = {
  status: AgentlessStatus | null;
  onEnable: (receiver: 'hostmetrics' | 'dockerstats') => Promise<void>;
};

export const Layer1Agentless: React.FC<Props> = () => (
  <section className="rounded-lg border border-gray-800 bg-gray-1000 p-6">
    <h2 className="text-lg font-semibold text-gray-100 mb-1">
      Layer 1 — Collect what's already there
    </h2>
    <p className="text-sm text-gray-400 mb-4">
      Two zero-code receivers running inside the Helix Gateway. No changes to your apps.
    </p>
    <div className="text-gray-500 text-sm">(Cards added in Tasks 9–10.)</div>
  </section>
);
