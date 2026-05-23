import React from 'react';
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { SyntheticRunCompact } from '../step-zero/SyntheticRunCompact';

type SystemHealth = {
  gatewayStatus: 'running' | 'restarting' | 'exited' | 'unknown' | 'error';
  gatewayExitCode?: number;
  throughput: { totalSpans: number; spansPerSec: number; windowMs: number };
  recentErrors: Array<{ ts: number; tag: string; message: string }>;
};

type PipelineStatus = 'receiving' | 'degraded' | 'broken';

// `showSyntheticRun` flags the one state where the inline "Run demo
// scenario" CTA makes sense — gateway is healthy, no traffic yet. In every
// other state the user either has traffic (no need for demo data) or a
// real problem to fix first (don't paper over it with synthetic data).
type DerivedStatus = {
  status: PipelineStatus;
  headline: string;
  detail: string;
  showSyntheticRun?: boolean;
};

const deriveStatus = (h: SystemHealth | null): DerivedStatus => {
  if (!h) return { status: 'degraded', headline: 'Checking pipeline…', detail: 'Loading health data.' };

  if (h.gatewayStatus === 'exited' || h.gatewayStatus === 'error') {
    return {
      status: 'broken',
      headline: 'Telemetry is not reaching Helix.',
      detail: `helix-gateway is ${h.gatewayStatus}${h.gatewayExitCode != null ? ` (exit ${h.gatewayExitCode})` : ''}. Restart it from the gateway controls below.`,
    };
  }

  if (h.gatewayStatus === 'restarting') {
    return {
      status: 'degraded',
      headline: 'Pipeline restarting.',
      detail: 'helix-gateway is coming back up. Telemetry may be paused for a few seconds.',
    };
  }

  // Gateway is running (or 'unknown' on first probe — treat as running).
  const spans = h.throughput.totalSpans;
  const rate = h.throughput.spansPerSec;
  const recentErrorTag = h.recentErrors[0]?.tag;

  if (spans === 0) {
    return {
      status: 'receiving',
      headline: 'Ready to receive telemetry.',
      detail: 'No traffic yet. Run the demo scenario to populate your dashboards with realistic data, or instrument an app.',
      showSyntheticRun: true,
    };
  }

  if (recentErrorTag) {
    return {
      status: 'degraded',
      headline: 'Pipeline degraded.',
      detail: `${spans.toLocaleString()} spans in the last hour but recent errors logged (${recentErrorTag}). Check Last error for details.`,
    };
  }

  const rateLabel = rate < 1 ? `${(rate * 60).toFixed(1)} spans/min` : `${rate.toFixed(1)} spans/s`;
  return {
    status: 'receiving',
    headline: 'Telemetry is flowing into Helix.',
    detail: `${rateLabel} over the last hour (${spans.toLocaleString()} spans total).`,
  };
};

const STYLES: Record<PipelineStatus, { bg: string; icon: React.ReactNode }> = {
  receiving: {
    bg: 'bg-success/10 border-success/40',
    icon: <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />,
  },
  degraded: {
    bg: 'bg-warning/10 border-warning/40',
    icon: <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0" />,
  },
  broken: {
    bg: 'bg-danger/10 border-danger/40',
    icon: <AlertTriangle className="w-5 h-5 text-danger flex-shrink-0" />,
  },
};

type Props = { health: SystemHealth | null };

export const PipelineStatusBanner: React.FC<Props> = ({ health }) => {
  const loading = !health;
  const { status, headline, detail, showSyntheticRun } = deriveStatus(health);
  const style = STYLES[status];
  return (
    <div className={`rounded-lg border p-4 flex items-start gap-3 ${style.bg}`}>
      {loading ? <Loader2 className="w-5 h-5 text-gray-400 flex-shrink-0 animate-spin" /> : style.icon}
      <div className="flex-1 min-w-0">
        <div className="text-lg font-semibold text-gray-100">{headline}</div>
        <div className="text-base text-gray-300 mt-0.5">{detail}</div>
        {showSyntheticRun && (
          <div className="mt-3">
            <SyntheticRunCompact />
          </div>
        )}
      </div>
    </div>
  );
};
