import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Sparkline } from './Sparkline';

type Props = {
  label: string;
  /** Pre-formatted value (e.g. "1.2k", "342 ms", "4.1%"). */
  value: string;
  /** Pre-formatted "vs previous window" string (e.g. "+12%", "-4%"). null hides the row. */
  delta?: string | null;
  /** Direction of the delta — drives icon + color. 'flat' renders neutral gray. */
  deltaDirection?: 'up' | 'down' | 'flat' | null;
  /** Whether 'up' is good (e.g. throughput) or bad (e.g. error rate). Default: 'up' is good. */
  betterWhen?: 'up' | 'down';
  sparkline?: number[];
  /** Grafana-style "min / max / avg over window" detail line under the delta. Pre-formatted. */
  summary?: { min: string; max: string; avg: string } | null;
  /** Optional click handler — turns the card into an interactive surface. */
  onClick?: () => void;
};

/**
 * Big-number stat card with delta-vs-previous-window and an inline sparkline.
 * ADAPT-flat: solid surface, 1px gray-800 border, 4px radius, no gradients,
 * no glow, no scale-on-hover. Hover just bumps the border color.
 */
export const StatCard: React.FC<Props> = ({
  label,
  value,
  delta,
  deltaDirection = null,
  betterWhen = 'up',
  sparkline,
  summary,
  onClick,
}) => {
  const deltaTone =
    deltaDirection === 'flat' || !deltaDirection
      ? 'text-gray-500'
      : deltaDirection === betterWhen
        ? 'text-success'
        : 'text-danger';
  const DeltaIcon =
    deltaDirection === 'up' ? TrendingUp : deltaDirection === 'down' ? TrendingDown : Minus;

  const Wrap: React.ElementType = onClick ? 'button' : 'div';
  return (
    <Wrap
      onClick={onClick}
      className={`adapt-card w-full text-left ${onClick ? 'hover:border-gray-700 transition-colors cursor-pointer' : ''}`}
    >
      {/* Typography aligned to ADAPT KPI tile spec
          (ui_kits/helix-app/styles.css, .hx-kpi):
          - label: 12px / 600 / uppercase / 0.05em tracking / fg2
          - value: 32px / 700 / Open Sans (not mono) / line-height 1
          - delta: 12px / fg3
          The project's dark palette + sparkline are kept; Adapt's left-
          border tone variants are not used here because the delta
          already carries the up/down signal. */}
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-[0.05em] mb-1">{label}</div>
      <div className="flex items-end justify-between gap-3 mb-1">
        <div className="text-[32px] font-bold text-gray-100 leading-none tabular-nums">{value}</div>
        {sparkline && <Sparkline data={sparkline} width={84} height={26} />}
      </div>
      {delta && (
        <div className={`text-xs inline-flex items-center gap-1 ${deltaTone}`}>
          <DeltaIcon className="w-3 h-3" />
          <span className="font-semibold">{delta}</span>
          <span className="text-gray-500 font-normal normal-case tracking-normal">vs prior window</span>
        </div>
      )}
      {summary && (
        <div className="mt-1 flex items-center gap-2.5 text-xs text-gray-500 tabular-nums">
          <span><span className="opacity-60">min</span> {summary.min}</span>
          <span><span className="opacity-60">max</span> {summary.max}</span>
          <span><span className="opacity-60">avg</span> {summary.avg}</span>
        </div>
      )}
    </Wrap>
  );
};
