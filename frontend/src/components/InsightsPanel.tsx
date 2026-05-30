import React from 'react';
import { Sparkles, AlertTriangle, Activity, CheckCircle2 } from 'lucide-react';
import type { HelixEnv } from './otel-data/types';
import { hasRealHelixEndpoint } from './otel-data/utils';

export type InsightFinding = {
  severity: 'info' | 'warning' | 'danger';
  title: string;
  body: string;
  /** True when this finding's title also fired in the previous fetch. Rendered
   *  with reduced visual weight so a persisting anomaly looks settled rather
   *  than alarmingly-fresh on every poll. */
  ongoing?: boolean;
  service?: string; // Sourced from backend
};

type Props = {
  findings: InsightFinding[];
  loading?: boolean;
  helixEnv?: HelixEnv | null;
};

/**
 * Davis-flavored insights card. The ADAPT design system reserves HelixGPT
 * orange (#f86e00) for AI / GenAI-generated content; these findings are
 * rule-based comparisons but are presented as an AI-flavored narrative
 * surface, so the orange accent is the correct ADAPT-mandated treatment.
 *
 * Renders as a card with a 2px orange left-border and a Sparkles icon. Body
 * text stays neutral — the surface signals "AI-flavored content here" via
 * structure, not gratuitous color throughout.
 */
export const InsightsPanel: React.FC<Props> = ({ findings, loading, helixEnv }) => {
  // Never hide the card outright. An empty findings list rendered as
  // "nothing here" looks broken; rendering a positive "no anomalies" finding
  // tells the user the rules ran and had nothing to flag.
  const effectiveFindings: InsightFinding[] = findings && findings.length > 0
    ? findings
    : [{
        severity: 'info' as const,
        title: 'No anomalies vs prior window',
        body: 'p95 latency, error rate, throughput, and per-service distributions look consistent with the same-duration window immediately before this one.',
      }];
  return (
    <div className="relative mb-4 adapt-card !pl-4">
      {/* HelixGPT-orange AI accent — left border only, per ADAPT */}
      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: '#f86e00' }} />
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-3.5 h-3.5" style={{ color: '#f86e00' }} />
        <span className="text-tiny font-semibold text-gray-300 uppercase tracking-wider">Insights</span>
        <span className="text-tiny text-gray-500 normal-case tracking-normal font-normal">· window-over-window anomaly findings</span>
      </div>
      {loading && effectiveFindings.length === 0 ? (
        <div className="text-tiny text-gray-500">Analyzing recent traces…</div>
      ) : (
        <ul className="space-y-2.5">
          {effectiveFindings.map((f, i) => {
            const isPositive = f.title === 'No anomalies vs prior window';
            const Icon = isPositive ? CheckCircle2
              : f.severity === 'danger' ? AlertTriangle
              : f.severity === 'warning' ? AlertTriangle
              : Activity;
            const iconColor = isPositive ? '#11845b' :
              f.severity === 'danger' ? '#b2001e' :
              f.severity === 'warning' ? '#d9ae00' :
              '#8c8fa1';

            const showLink = !isPositive && f.service && helixEnv && hasRealHelixEndpoint(helixEnv);
            const linkUrl = showLink ? (() => {
              const base = helixEnv!.endpoint.replace(/\/+$/, '');
              const params = new URLSearchParams({
                orgId: helixEnv!.tenantId,
                'var-BusinessService': helixEnv!.source || '',
                'var-OTelNamespace': helixEnv!.source || '',
                'var-OTelService': f.service!,
                'var-status': 'STATUS_CODE_UNSET',
                from: 'now-3h',
                to: 'now',
                timezone: 'browser',
              });
              return `${base}/dashboards/d/OTelServiceOverview/otel-service-overview?${params.toString()}`;
            })() : null;

            return (
              <li key={i} className={`flex items-start gap-2.5 ${f.ongoing ? 'opacity-60' : ''}`}>
                <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: iconColor }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-gray-100 font-semibold">{f.title}</div>
                    {f.ongoing && (
                      <span className="text-tiny font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-400">
                        ongoing
                      </span>
                    )}
                  </div>
                  <p className="text-tiny text-gray-400 leading-relaxed mt-0.5">{f.body}</p>
                  {showLink && linkUrl && (
                    <div className="mt-1">
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-link hover:underline hover:text-white"
                        style={{ color: '#8ca1f3' }}
                      >
                        Investigate {f.service} in Helix AIOps →
                      </a>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
