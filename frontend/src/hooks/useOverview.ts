import { useCallback, useEffect, useRef, useState } from 'react';
import type { OverviewData, HeatmapData } from '../components/OverviewTab';
import type { InsightFinding } from '../components/InsightsPanel';
import type { ServiceMapData } from '../components/ServiceMap';

type TracesHistogram = {
  bucketStartMs: number;
  bucketEndMs: number;
  bucketSizeMs: number;
  buckets: Array<{
    tsMs: number; total: number;
    ok?: number; slow?: number; error?: number;
    p50?: number | null; p95?: number | null;
  }>;
};

type LogsHistogram = {
  bucketStartMs: number;
  bucketEndMs: number;
  bucketSizeMs: number;
  buckets: Array<{
    tsMs: number; total: number;
    debug?: number; info?: number; warn?: number; error?: number;
  }>;
};

type BundleResponse = {
  overview: OverviewData;
  tracesHistogram: TracesHistogram;
  priorTotals: number[] | null;
  logsHistogram: LogsHistogram;
  heatmap: HeatmapData;
  insights: { findings: InsightFinding[] };
  serviceMap: ServiceMapData;
};

type Args = {
  /** Active time window for the page. Includes both relative range (since-only)
   *  and explicit ranges (since + until). */
  sinceMs?: number;
  untilMs?: number;
  /** Optional service filter applied to the trace/overview windowing. */
  service?: string;
};

export type UseOverview = {
  overview: OverviewData | null;
  tracesHistogram: TracesHistogram | null;
  logsHistogram: LogsHistogram | null;
  priorTotals: number[] | null;
  heatmap: HeatmapData | null;
  insights: InsightFinding[];
  serviceMap: ServiceMapData | null;
  loading: boolean;
  /** Imperative refresh — used by the page-wide refresh interval orchestrator. */
  refresh: () => Promise<void>;
};

/**
 * One-stop hook for the Overview tab. Owns all six datasets that used to be
 * fetched in lockstep from separate endpoints and consolidates them into a
 * single /api/overview-bundle round-trip. The composite endpoint avoids
 * the SQLite-serialization bottleneck where six concurrent requests piled up
 * against the same DB.
 *
 * Re-fetches automatically when any input arg changes; the imperative
 * `refresh()` is what the page-level refresh-interval timer calls to poll.
 */
export function useOverview({ sinceMs, untilMs, service }: Args): UseOverview {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [tracesHistogram, setTracesHistogram] = useState<TracesHistogram | null>(null);
  const [logsHistogram, setLogsHistogram] = useState<LogsHistogram | null>(null);
  const [priorTotals, setPriorTotals] = useState<number[] | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapData | null>(null);
  const [insights, setInsights] = useState<InsightFinding[]>([]);
  const [serviceMap, setServiceMap] = useState<ServiceMapData | null>(null);
  const [loading, setLoading] = useState(false);

  // Inflight token: if a new fetch starts before the old one resolves, we
  // ignore the stale response. Prevents flicker / out-of-order overwrites.
  const inflightRef = useRef(0);
  // Remember last batch of finding titles so we can tag persisting anomalies
  // as `ongoing`. Without this, the same finding text re-rendered on every
  // poll looks alarmingly-fresh; with it, persisting anomalies dim down.
  const lastFindingTitlesRef = useRef<Set<string>>(new Set());

  const fetchBundle = useCallback(async () => {
    const params = new URLSearchParams({ buckets: '60' });
    if (sinceMs != null) params.set('sinceMs', String(sinceMs));
    if (untilMs != null) params.set('untilMs', String(untilMs));
    if (service) params.set('service', service);
    const myToken = ++inflightRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/overview-bundle?${params}`);
      if (!res.ok) return;
      const data: BundleResponse = await res.json();
      if (myToken !== inflightRef.current) return; // stale
      setOverview(data.overview);
      setTracesHistogram(data.tracesHistogram);
      setLogsHistogram(data.logsHistogram);
      setPriorTotals(data.priorTotals ?? null);
      setHeatmap(data.heatmap);
      // Tag findings whose title also appeared in the previous batch as
      // `ongoing`. Title equality is the discriminator because bodies often
      // contain rolling numbers that would defeat a content hash.
      const incoming = data.insights?.findings || [];
      const tagged = incoming.map(f => ({
        ...f,
        ongoing: lastFindingTitlesRef.current.has(f.title),
      }));
      lastFindingTitlesRef.current = new Set(incoming.map(f => f.title));
      setInsights(tagged);
      setServiceMap(data.serviceMap);
    } catch { /* non-fatal */ } finally {
      if (myToken === inflightRef.current) setLoading(false);
    }
  }, [sinceMs, untilMs, service]);

  // Auto-fetch when inputs change. The poll-on-interval is left to the
  // caller (usePageRefresh) so the page-wide refresh selector controls all
  // pollers from one place.
  useEffect(() => { fetchBundle(); }, [fetchBundle]);

  return { overview, tracesHistogram, logsHistogram, priorTotals, heatmap, insights, serviceMap, loading, refresh: fetchBundle };
}
