type MetricsSample = { received: number; sent: number; failed: number };

type Props = {
  liveMetrics: MetricsSample;
  metricsHistory: MetricsSample[];
  // Count of drop events scraped from the streamed container logs (separate
  // from gateway-side send failures in liveMetrics.failed).
  diagAlertCount: number;
};

// Per-sample deltas from the cumulative counter history, clamped at zero so a
// counter reset (gateway restart) doesn't render as a negative spike.
const ratesFor = (history: MetricsSample[], key: keyof MetricsSample): number[] => {
  if (history.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < history.length; i++) {
    out.push(Math.max(0, history[i][key] - history[i - 1][key]));
  }
  return out;
};

const Spark = ({ data, stroke }: { data: number[]; stroke: string }) => {
  if (data.length < 2) return <div style={{ height: 14 }} />;
  const max = Math.max(...data, 1);
  const w = 72, h = 14;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} className="mt-1">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.2} />
    </svg>
  );
};

// The three live-counter cards (Received / Sent / Dropped) with per-card
// sparklines, shown above the diagnostic log pane.
export const LiveMetricsCards = ({ liveMetrics, metricsHistory, diagAlertCount }: Props) => {
  // The "Dropped" card reflects both gateway-side send failures
  // (otelcol_exporter_send_failed_*) and log-pattern alerts from the streamed
  // container. Show the larger so users don't see "0" while a 196-event alert
  // is screaming; hover breaks down where it came from.
  const droppedHeadline = Math.max(liveMetrics.failed, diagAlertCount);
  const breakdown = `Gateway send-failures (otelcol_exporter_send_failed_*): ${liveMetrics.failed}\nDrop events in streamed logs: ${diagAlertCount}`;
  return (
    <div className="flex gap-2">
      <div className="bg-gray-800 border-l-2 border-info px-3 py-1.5 rounded-r min-w-[88px]">
        <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Received</div>
        <div className="text-xl font-semibold text-info leading-none tabular-nums">{liveMetrics.received}</div>
        <Spark data={ratesFor(metricsHistory, 'received')} stroke="#3759d8" />
      </div>
      <div className="bg-gray-800 border-l-2 border-success px-3 py-1.5 rounded-r min-w-[88px]">
        <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Sent</div>
        <div className="text-xl font-semibold text-success-text leading-none tabular-nums">{liveMetrics.sent}</div>
        <Spark data={ratesFor(metricsHistory, 'sent')} stroke="#11845b" />
      </div>
      <div
        className="bg-gray-800 border-l-2 border-danger px-3 py-1.5 rounded-r min-w-[88px]"
        title={breakdown}
      >
        <div className="text-tiny text-gray-500 uppercase tracking-wider font-semibold">Dropped</div>
        <div className="text-xl font-semibold text-danger-text leading-none tabular-nums">{droppedHeadline}</div>
        {liveMetrics.failed !== diagAlertCount && (
          <div className="text-[9px] text-gray-500 leading-tight">
            {diagAlertCount} log · {liveMetrics.failed} metric
          </div>
        )}
        <Spark data={ratesFor(metricsHistory, 'failed')} stroke="#b2001e" />
      </div>
    </div>
  );
};
