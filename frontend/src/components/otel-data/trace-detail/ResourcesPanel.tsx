import { useEffect, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import { Sparkline } from '../../Sparkline';

export type MetricSeries = {
  points: { tsNs: number; value: number }[];
  peak: number | null;
  atTrace: number | null;
  unit: string;
};
export type ResourcePayload = {
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

// Fetch the per-trace resource series once when the drawer opens. Returns null
// while loading, on failure, or for an unknown trace — callers treat null (and
// `empty: true`) as "no resource cells", so the drawer is never blocked.
export function useTraceResources(traceId: string): ResourcePayload | null {
  const [data, setData] = useState<ResourcePayload | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/traces/${traceId}/resources`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [traceId]);
  return data;
}

// A resource metric (CPU or memory) rendered as a trace-summary cell — value at
// trace time, a compact trend sparkline, and the window peak. Mirrors
// SummaryCell's styling so it sits naturally in the summary strip. CPU reads
// hot (warning/danger tone) on high utilization.
export const ResourceCell: React.FC<{
  kind: 'cpu' | 'memory';
  series: MetricSeries;
}> = ({ kind, series }) => {
  const isCpu = kind === 'cpu';
  const label = isCpu ? 'CPU' : 'Memory';
  const icon = isCpu ? <Cpu className="w-3.5 h-3.5" /> : <MemoryStick className="w-3.5 h-3.5" />;
  const stroke = isCpu ? '#3759d8' : '#0aa4a4';
  const format = isCpu ? formatPct : formatBytes;
  const at = series.atTrace;
  const tone = isCpu && at != null
    ? (at >= 0.9 ? 'danger' : at >= 0.75 ? 'warning' : null)
    : null;
  const toneClass = tone === 'danger' ? 'text-[#ff8a8a]' : tone === 'warning' ? 'text-warning' : 'text-gray-100';
  return (
    <div className="adapt-card !p-3">
      <div className="flex items-center gap-1.5 text-tiny text-gray-500 uppercase tracking-wider font-semibold">
        {icon} {label}
      </div>
      <div className={`mt-1 tabular-nums text-base ${toneClass}`}>{format(at)}</div>
      <Sparkline data={series.points.map(p => p.value)} stroke={stroke} width={88} height={16} filled />
      <div className="text-tiny text-gray-500 mt-0.5">peak {format(series.peak)}</div>
    </div>
  );
};
