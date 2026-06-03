import React, { useEffect, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { Sparkline } from '../../Sparkline';

type MetricSeries = {
  points: { tsNs: number; value: number }[];
  peak: number | null;
  atTrace: number | null;
  unit: string;
};
type ResourcePayload = {
  window: { startNs: number; endNs: number };
  cpu: MetricSeries;
  memory: MetricSeries;
  empty: boolean;
};

const formatPct = (ratio: number | null): string =>
  ratio == null ? '—' : `${Math.round(ratio * 100)}%`;

const formatBytes = (n: number | null): string => {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

// One metric row: a label + headline (at-trace / peak) and a Sparkline of the
// surrounding context window. Reuses the shared Sparkline (no axis/markers).
const MetricRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  series: MetricSeries;
  stroke: string;
  format: (v: number | null) => string;
}> = ({ icon, label, series, stroke, format }) => (
  <div className="flex items-center justify-between gap-4 py-2">
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-gray-500">{icon}</span>
      <span className="text-sm text-gray-300">{label}</span>
    </div>
    <div className="flex items-center gap-4">
      <div className="text-right">
        <div className="text-sm font-semibold text-gray-100">{format(series.atTrace)}</div>
        <div className="text-tiny text-gray-500">peak {format(series.peak)}</div>
      </div>
      <Sparkline data={series.points.map(p => p.value)} stroke={stroke} width={140} height={32} filled />
    </div>
  </div>
);

// Resource utilization (CPU / memory) for the trace's service, sampled over a
// context window around the trace. Supplementary: it never blocks the drawer —
// loading and fetch failures render nothing, and a service with no process.*
// metrics renders a quiet empty state.
export const ResourcesPanel: React.FC<{ traceId: string }> = ({ traceId }) => {
  const [data, setData] = useState<ResourcePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setData(null);
    fetch(`/api/traces/${traceId}/resources`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setFailed(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [traceId]);

  if (loading || failed || !data) return null;

  return (
    <div className="mb-4 bg-gray-900 border border-gray-800 rounded p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-semibold text-gray-200">Resources</span>
        <span className="text-tiny text-gray-500">CPU &amp; memory around this trace (±90s)</span>
      </div>
      {data.empty ? (
        <div className="text-tiny text-gray-500 py-2">
          No resource metrics for this service in this window — enable runtime
          metrics (<code className="font-mono text-gray-400">process.*</code>) or
          the hostmetrics fallback.
        </div>
      ) : (
        <div className="divide-y divide-gray-800">
          <MetricRow
            icon={<Cpu className="w-4 h-4" />}
            label="CPU utilization"
            series={data.cpu}
            stroke="#3759d8"
            format={formatPct}
          />
          <MetricRow
            icon={<MemoryStick className="w-4 h-4" />}
            label="Memory usage"
            series={data.memory}
            stroke="#0aa4a4"
            format={formatBytes}
          />
        </div>
      )}
    </div>
  );
};
