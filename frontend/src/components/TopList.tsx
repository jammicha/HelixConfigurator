import React from 'react';
import { ChevronRight } from 'lucide-react';
import { Sparkline } from './Sparkline';

export type TopListRow = {
  key: string;
  primary: string;
  secondary?: string | null;
  /** The metric value (count, percentage, etc.). Drives the horizontal bar width. */
  metric: number;
  /** Pre-formatted display string for the metric, right-aligned. */
  metricLabel: string;
  /** Optional sparkline per row (e.g. error occurrences over time). */
  sparkline?: number[] | null;
  /** Tag pill text (e.g. error rate "12% err"). Backwards-compat with the
   *  single-tag callers; new callers should use `tags` for multi-tag rows. */
  tag?: { label: string; tone: 'danger' | 'warning' | 'neutral' | 'success' } | null;
  /** Multiple pills (e.g. Apdex + error rate). Renders left of the metric. */
  tags?: Array<{ label: string; tone: 'danger' | 'warning' | 'neutral' | 'success'; title?: string }>;
};

type Props = {
  title: string;
  rows: TopListRow[];
  /** Color used for the in-row horizontal bar. Defaults to active blue. */
  barColor?: string;
  /** Right-side caret + cursor-pointer hint. */
  onRowClick?: (row: TopListRow) => void;
  emptyText?: string;
};

/**
 * Horizontal-bar Top-N list. Each row: primary label, optional secondary,
 * an inline proportional bar (max-relative), and a right-aligned metric.
 * Clicking a row fires onRowClick — used to drilldown from the Overview to
 * Traces or Errors filtered by the selected entity.
 */
export const TopList: React.FC<Props> = ({
  title,
  rows,
  barColor = '#3759d8',
  onRowClick,
  emptyText = 'No data in this window.',
}) => {
  const max = Math.max(1, ...rows.map(r => r.metric));
  return (
    <div className="adapt-card">
      <div className="text-tiny font-semibold text-gray-400 uppercase tracking-wider mb-3">{title}</div>
      {rows.length === 0 ? (
        <div className="text-tiny text-gray-500 py-2">{emptyText}</div>
      ) : (
        <div className="space-y-2.5">
          {rows.map(r => {
            const pct = (r.metric / max) * 100;
            const RowEl: React.ElementType = onRowClick ? 'button' : 'div';
            const toneClassFor = (tone: 'danger' | 'warning' | 'neutral' | 'success') =>
              tone === 'danger' ? 'bg-danger/15 text-[#ff8a8a] border-danger/30'
              : tone === 'warning' ? 'bg-warning/15 text-warning border-warning/30'
              : tone === 'success' ? 'bg-success/15 text-success border-success/30'
              : 'bg-gray-800 text-gray-300 border-gray-700';
            const allTags = [
              ...(r.tags || []),
              ...(r.tag ? [{ label: r.tag.label, tone: r.tag.tone }] : []),
            ];
            return (
              <RowEl
                key={r.key}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`flex items-center gap-3 w-full text-left ${onRowClick ? 'hover:bg-gray-1000 rounded transition-colors cursor-pointer px-1.5 -mx-1.5 py-1.5 -my-1.5' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm text-gray-100 font-mono truncate">{r.primary}</span>
                    {r.secondary && <span className="text-tiny text-gray-500 truncate">{r.secondary}</span>}
                    {allTags.map((t, i) => (
                      <span
                        key={i}
                        title={(t as any).title}
                        className={`text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${toneClassFor(t.tone)}`}
                      >
                        {t.label}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 h-1 rounded-sm bg-gray-800 overflow-hidden">
                    <div className="h-full" style={{ width: `${pct}%`, background: barColor }} />
                  </div>
                </div>
                {r.sparkline && r.sparkline.length > 0 && (
                  <Sparkline data={r.sparkline} width={64} height={20} stroke={barColor} />
                )}
                <div className="text-sm font-mono text-gray-200 tabular-nums w-16 text-right">{r.metricLabel}</div>
                {onRowClick && <ChevronRight className="w-4 h-4 text-gray-600 flex-shrink-0" />}
              </RowEl>
            );
          })}
        </div>
      )}
    </div>
  );
};
