import React, { useState } from 'react';
import { ExternalLink, Loader2, Send, CheckCircle2, AlertTriangle } from 'lucide-react';
import { buildHelixBusinessServiceUrl } from './otel-data/utils';
import { StatCard } from './StatCard';
import { TopList } from './TopList';
import type { TopListRow } from './TopList';
import { TimelineChart, TIMELINE_COLORS } from './TimelineChart';
import { Heatmap } from './Heatmap';
import type { HeatmapData as HeatmapDataInternal } from './Heatmap';
import { ServiceMap } from './ServiceMap';
import type { ServiceMapData } from './ServiceMap';
import { HelixCtaBanner } from './otel-data/HelixCtaBanner';
import type { HelixEnv } from './otel-data/types';
import { SyntheticRunCompact } from './step-zero/SyntheticRunCompact';

// Shapes returned by /api/overview and /api/traces/latency-heatmap. Re-exported
// from OtelDataPage so the parent doesn't need to redefine.
export type OverviewStat = {
  value: number;
  prev: number;
  delta: number | null;
  sparkline: number[];
  summary?: { min: number; max: number; avg: number } | null;
};
export type OverviewData = {
  windowMs: { start: number; end: number };
  prevWindowMs: { start: number; end: number };
  sparkBucketSizeMs: number;
  stats: {
    totalTraces: OverviewStat;
    p95LatencyMs: OverviewStat;
    errorRate: OverviewStat;
    throughputPerMin: OverviewStat;
  };
  topServices: Array<{ name: string; count: number; errorCount: number; errorRate: number; apdex: number | null }>;
  topErrors: Array<{ exceptionType: string; serviceName: string; count: number; sparkline: number[] }>;
  annotations?: Array<{ tsMs: number; label: string; tone?: 'info' | 'warning' | 'danger' }>;
};
export type HeatmapData = HeatmapDataInternal;

// Trace timeline data — same shape the Traces tab consumes, passed through
// so the Overview shows the identical chart instead of refetching.
type TracesHistogramRow = {
  tsMs: number; total: number;
  ok?: number; slow?: number; error?: number;
  p50?: number | null; p95?: number | null; p99?: number | null;
};
type TracesHistogram = {
  bucketStartMs: number;
  bucketEndMs: number;
  bucketSizeMs: number;
  buckets: TracesHistogramRow[];
};

type Props = {
  data: OverviewData | null;
  heatmap: HeatmapData | null;
  tracesHistogram: TracesHistogram | null;
  serviceMap: ServiceMapData | null;
  loading: boolean;
  customRange: { sinceMs: number; untilMs: number } | null;
  onClearCustomRange: () => void;
  onBucketClick: (sinceMs: number, untilMs: number) => void;
  /** Drilldown: jump to Traces tab with serviceFilter set. */
  onDrilldownService: (serviceName: string) => void;
  /** Drilldown: jump to Errors sub-tab, optionally filtered by service. */
  onDrilldownError: (exceptionType: string, serviceName: string) => void;
  /** Drilldown from heatmap cell: zoom traces into that time window + duration band. */
  onDrilldownHeatmapCell: (sinceMs: number, untilMs: number, minDurationMs: number) => void;
  /** Helix tenant config — when set to a non-placeholder endpoint, the AIOps CTA banner renders. */
  helixEnv: HelixEnv | null;
  /** User-selected slow threshold (ms). Drives the reference line on the latency histogram so it tracks the same value as the Operations / Traces views. */
  slowThresholdMs: number;
};

const formatNumber = (n: number): string => {
  if (!isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(1);
};
const formatPercent = (frac: number): string => {
  if (!isFinite(frac)) return '—';
  if (frac >= 0.1) return `${(frac * 100).toFixed(1)}%`;
  return `${(frac * 100).toFixed(2)}%`;
};
const formatDuration = (ms: number): string => {
  if (!isFinite(ms) || ms === 0) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
};
// Format a raw {min, max, avg} numeric triple through the same value formatter
// used for the headline number, so the small detail line stays consistent
// (e.g. "min 412 ms · max 1.32 s · avg 678 ms").
const summaryFmt = (
  s: { min: number; max: number; avg: number } | null | undefined,
  fmt: (n: number) => string,
): { min: string; max: string; avg: string } | null => {
  if (!s) return null;
  return { min: fmt(s.min), max: fmt(s.max), avg: fmt(s.avg) };
};

const formatDelta = (delta: number | null): { text: string; direction: 'up' | 'down' | 'flat' | null } => {
  if (delta === null) return { text: '—', direction: null };
  if (delta === 0) return { text: '0%', direction: 'flat' };
  const sign = delta > 0 ? '+' : '';
  return {
    text: `${sign}${(delta * 100).toFixed(1)}%`,
    direction: delta > 0 ? 'up' : 'down',
  };
};

export const OverviewTab: React.FC<Props> = ({
  data,
  heatmap,
  tracesHistogram,
  serviceMap,
  loading,
  customRange,
  onClearCustomRange,
  onBucketClick,
  onDrilldownService,
  onDrilldownError,
  onDrilldownHeatmapCell,
  helixEnv,
  slowThresholdMs,
}) => {
  // Shared-crosshair: hover any chart, all charts on the page get a guide at
  // the same time-X. State is lifted here so the volume chart and heatmap
  // can sync without prop-drilling further.
  const [hoveredTimeMs, setHoveredTimeMs] = useState<number | null>(null);
  // Local state for the empty-state "Send a test trace" CTA. Doesn't need
  // to bubble up — the SSE feed will re-render OverviewTab once the
  // synthetic span lands.
  const [testTraceStatus, setTestTraceStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [testTraceError, setTestTraceError] = useState<string>('');
  const sendTestTrace = async () => {
    if (testTraceStatus === 'sending') return;
    setTestTraceStatus('sending');
    setTestTraceError('');
    try {
      const res = await fetch('/api/diagnostics/inject-trace', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setTestTraceStatus('sent');
      setTimeout(() => setTestTraceStatus('idle'), 4000);
    } catch (e: any) {
      setTestTraceError(e?.message || 'Failed to send test trace');
      setTestTraceStatus('error');
    }
  };
  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading overview…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        No overview data available yet.
      </div>
    );
  }
  // Empty-but-not-loading state: the window resolved with zero traces.
  // Distinguish this from the loading spinner so the user has clear next
  // steps (send a synthetic trace to verify the pipeline, or go back to
  // the dashboard to check the gateway) instead of a flat "no data" line.
  if (data.stats.totalTraces.value === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-4">
          <h3 className="text-base font-semibold text-gray-200">No traces in this window</h3>
          <p className="text-sm text-gray-400">
            The gateway isn't receiving traces for the selected time range. Send a single test trace to verify
            the pipeline, or run the demo scenario to populate the dashboards with 60s of realistic traffic.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            {/*
              Two distinct calls-to-action here:
                - "Send a test trace" — single synthetic span, verifies plumbing only.
                - "Run demo scenario"  — 60s of multi-service traffic with eight
                                          diagnostic patterns woven in, so the empty
                                          charts above actually have something to show.
              The compact button is the same one the dashboard banner uses, so both
              entry points share lifecycle state via useSyntheticRun.
            */}
            <button
              onClick={sendTestTrace}
              disabled={testTraceStatus === 'sending'}
              className="inline-flex items-center gap-2 px-4 py-2 rounded font-semibold text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 disabled:opacity-60"
            >
              {testTraceStatus === 'sending'
                ? (<><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>)
                : testTraceStatus === 'sent'
                ? (<><CheckCircle2 className="w-4 h-4" /> Sent. Refreshing shortly</>)
                : (<><Send className="w-4 h-4" /> Send a test trace</>)}
            </button>
            <SyntheticRunCompact hideViewLink />
            <a
              href="/"
              className="inline-flex items-center gap-2 px-4 py-2 rounded font-semibold text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200"
            >
              Check gateway →
            </a>
          </div>
          {testTraceStatus === 'error' && (
            <p className="text-tiny text-danger-text inline-flex items-center gap-1 justify-center">
              <AlertTriangle className="w-3.5 h-3.5" /> {testTraceError}
            </p>
          )}
        </div>
      </div>
    );
  }

  const total = data.stats.totalTraces;
  const p95 = data.stats.p95LatencyMs;
  const err = data.stats.errorRate;
  const tput = data.stats.throughputPerMin;

  const totalDelta = formatDelta(total.delta);
  const p95Delta = formatDelta(p95.delta);
  const errDelta = formatDelta(err.delta);
  const tputDelta = formatDelta(tput.delta);

  const apdexTone = (a: number): 'success' | 'warning' | 'danger' =>
    a >= 0.9 ? 'success' : a >= 0.7 ? 'warning' : 'danger';
  const topServiceRows: TopListRow[] = data.topServices.map(s => {
    const tags: Array<{ label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; title?: string }> = [];
    if (s.apdex !== null) {
      tags.push({
        label: `Apdex ${s.apdex.toFixed(2)}`,
        tone: apdexTone(s.apdex),
        title: 'New Relic-style Apdex with T=500ms. ≥0.9 healthy, 0.7–0.9 warning, <0.7 unhappy.',
      });
    }
    if (s.errorRate >= 0.001) {
      tags.push({
        label: `${formatPercent(s.errorRate)} err`,
        tone: s.errorRate >= 0.05 ? 'danger' : 'warning',
      });
    }
    return {
      key: s.name,
      primary: s.name,
      metric: s.count,
      metricLabel: formatNumber(s.count),
      tags,
    };
  });

  const topErrorRows: TopListRow[] = data.topErrors.map(e => ({
    key: `${e.exceptionType}|${e.serviceName}`,
    primary: e.exceptionType,
    secondary: e.serviceName || null,
    metric: e.count,
    metricLabel: formatNumber(e.count),
    sparkline: e.sparkline,
  }));

  return (
    <div className="flex-1 overflow-y-auto pb-6">
      <HelixCtaBanner helixEnv={helixEnv} />
      {customRange && (
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <div className="text-tiny text-gray-400">
            <span className="text-link font-semibold uppercase tracking-wider mr-2">Zoomed</span>
            {new Date(customRange.sinceMs).toLocaleTimeString([], { hour12: false })} –{' '}
            {new Date(customRange.untilMs).toLocaleTimeString([], { hour12: false })}
          </div>
          <button
            onClick={onClearCustomRange}
            className="text-tiny text-link hover:underline font-semibold"
          >Clear time selection</button>
        </div>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard
          label="Total traces"
          value={formatNumber(total.value)}
          delta={totalDelta.text}
          deltaDirection={totalDelta.direction}
          betterWhen="up"
          sparkline={total.sparkline}
          summary={summaryFmt(total.summary, formatNumber)}
        />
        <StatCard
          label="p95 latency"
          value={formatDuration(p95.value)}
          delta={p95Delta.text}
          deltaDirection={p95Delta.direction}
          betterWhen="down"
          sparkline={p95.sparkline}
          summary={summaryFmt(p95.summary, formatDuration)}
        />
        <StatCard
          label="Error rate"
          value={formatPercent(err.value)}
          delta={errDelta.text}
          deltaDirection={errDelta.direction}
          betterWhen="down"
          sparkline={err.sparkline}
          summary={summaryFmt(err.summary, formatPercent)}
        />
        <StatCard
          label="Throughput"
          value={`${formatNumber(tput.value)} / min`}
          delta={tputDelta.text}
          deltaDirection={tputDelta.direction}
          betterWhen="up"
          sparkline={tput.sparkline}
          summary={summaryFmt(tput.summary, formatNumber)}
        />
      </div>

      {/* Latency percentile band — p50/p95/p99 over time. Replaces the
          earlier trace-volume bar chart; volume is implied by the stat
          cards above and the Traces tab still shows the stacked-status
          timeline. */}
      {tracesHistogram && tracesHistogram.buckets.length > 0 && (
        <div className="adapt-card !p-3 mb-4">
          <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
            Latency <span className="normal-case tracking-normal text-gray-500 font-normal">· p50/p95/p99 · click or drag to zoom</span>
          </div>
          <TimelineChart
            mode="latency"
            buckets={tracesHistogram.buckets as any}
            bucketSizeMs={tracesHistogram.bucketSizeMs}
            height={108}
            segments={[]}
            percentiles={tracesHistogram.buckets.map(b => ({
              p50: b.p50 ?? null,
              p95: b.p95 ?? null,
              p99: b.p99 ?? null,
            }))}
            selectedRange={customRange}
            onBucketClick={onBucketClick}
            onRangeSelect={onBucketClick}
            hoveredTimeMs={hoveredTimeMs}
            onHoverTimeChange={setHoveredTimeMs}
            latencyThresholdsMs={[{ value: slowThresholdMs, label: `slow threshold (${formatDuration(slowThresholdMs)})` }]}
            annotations={data.annotations}
          />
        </div>
      )}

      {/* Top services + Top errors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
        <TopList
          title="Top services"
          rows={topServiceRows}
          onRowClick={(r) => onDrilldownService(r.key)}
          emptyText="No services have produced traces in this window."
        />
        <TopList
          title="Top errors"
          rows={topErrorRows}
          barColor={TIMELINE_COLORS.error}
          onRowClick={(r) => {
            const [exceptionType, serviceName] = r.key.split('|');
            onDrilldownError(exceptionType, serviceName);
          }}
          emptyText="No errors recorded in this window."
        />
      </div>

      {/* Service map (Datadog-style topology) */}
      {serviceMap && serviceMap.nodes.length > 0 && (
        <div className="adapt-card !p-3 mb-4">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider min-w-0 truncate">
              Service map <span className="normal-case tracking-normal text-gray-500 font-normal">· inter-service calls from spans · click a node to filter traces</span>
            </div>
            {(() => {
              const url = buildHelixBusinessServiceUrl(helixEnv);
              if (!url) return null;
              return (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-tiny text-link hover:text-white inline-flex items-center gap-1.5 font-semibold whitespace-nowrap"
                >
                  Open in AIOps Topology
                  <ExternalLink className="w-3 h-3" />
                </a>
              );
            })()}
          </div>
          <ServiceMap data={serviceMap} onNodeClick={onDrilldownService} />
        </div>
      )}

      {/* Latency heatmap */}
      {heatmap && heatmap.cells.length > 0 && (
        <div className="adapt-card !p-3">
          <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
            Latency distribution <span className="normal-case tracking-normal text-gray-500 font-normal">· click a cell to drill into traces in that band</span>
          </div>
          <Heatmap
            data={heatmap}
            height={220}
            onCellClick={(s, u, minMs) => onDrilldownHeatmapCell(s, u, minMs)}
            hoveredTimeMs={hoveredTimeMs}
            onHoverTimeChange={setHoveredTimeMs}
          />
        </div>
      )}
    </div>
  );
};
