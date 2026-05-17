import React, { useState } from 'react';
import { Cpu, Container, CheckCircle, Loader2 } from 'lucide-react';
import type { AgentlessStatus, ReceiverStatus } from './types';

type Props = {
  status: AgentlessStatus | null;
  onEnable: (receiver: 'hostmetrics' | 'dockerstats') => Promise<void>;
};

// One row in the panel. Reused by both receiver cards.
const ReceiverCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  status: ReceiverStatus | undefined;
  onEnable: () => Promise<void>;
  loading: boolean;
  error: string | null;
}> = ({ icon, title, description, status, onEnable, loading, error }) => {
  const enabled = !!status?.enabled;
  const flowing = enabled && (status?.acceptedMetricPoints ?? 0) > 0;
  return (
    <div className={`rounded border p-4 ${flowing ? 'border-green-800 bg-green-950/20' : 'border-gray-800 bg-gray-1000'}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 ${flowing ? 'text-green-400' : 'text-gray-400'}`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
            {flowing && (
              <span className="inline-flex items-center gap-1 text-tiny text-green-300">
                <CheckCircle className="w-3.5 h-3.5" />
                {status!.acceptedMetricPoints.toLocaleString()} metrics accepted
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-1">{description}</p>
          {error && (
            <p className="text-tiny text-red-300 mt-2">{error}</p>
          )}
          <div className="mt-3">
            {enabled ? (
              <span className="text-tiny text-gray-500">
                {flowing ? 'Active — flowing to Helix.' : 'Enabled — waiting for first scrape (up to 30s).'}
              </span>
            ) : (
              <button
                onClick={onEnable}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-tiny font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
              >
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Enable {title.toLowerCase()}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const Layer1Agentless: React.FC<Props> = ({ status, onEnable }) => {
  const [loading, setLoading] = useState<{ hostmetrics: boolean; dockerstats: boolean }>({ hostmetrics: false, dockerstats: false });
  const [error, setError] = useState<{ hostmetrics: string | null; dockerstats: string | null }>({ hostmetrics: null, dockerstats: null });

  const click = async (receiver: 'hostmetrics' | 'dockerstats') => {
    setLoading((s) => ({ ...s, [receiver]: true }));
    setError((s) => ({ ...s, [receiver]: null }));
    try {
      await onEnable(receiver);
    } catch (e) {
      setError((s) => ({ ...s, [receiver]: (e as Error).message }));
    } finally {
      setLoading((s) => ({ ...s, [receiver]: false }));
    }
  };

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-1000 p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">
        Layer 1 — Collect what's already there
      </h2>
      <p className="text-sm text-gray-400 mb-4">
        Two zero-code receivers running inside the Helix Gateway. No changes to your apps.
      </p>
      <div className="space-y-3">
        <ReceiverCard
          icon={<Cpu className="w-5 h-5" />}
          title="Host metrics"
          description="CPU, memory, disk, network, and load from the machine running Helix."
          status={status?.hostmetrics}
          onEnable={() => click('hostmetrics')}
          loading={loading.hostmetrics}
          error={error.hostmetrics}
        />
        <ReceiverCard
          icon={<Container className="w-5 h-5" />}
          title="Container stats"
          description="Per-container CPU, memory, network, and block I/O from every container running on this Docker host."
          status={status?.dockerstats}
          onEnable={() => click('dockerstats')}
          loading={loading.dockerstats}
          error={error.dockerstats}
        />
      </div>
    </section>
  );
};
