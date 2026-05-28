import React from 'react';
import { Play, Square, Loader2, ExternalLink } from 'lucide-react';
import { useSyntheticRun } from '../../hooks/useSyntheticRun';

type Props = {
  // Optional label override for the start button. Defaults to a generic
  // "Run demo scenario" — callers in narrower contexts (e.g. a banner
  // sitting next to a "Send a test trace" CTA) can clarify intent.
  label?: string;
  // Hide the "view in /otel-data" link while running. Use when the caller
  // is already on /otel-data so the link would just re-navigate the user
  // to the page they're already viewing.
  hideViewLink?: boolean;
};

// Single-button form factor of Layer2Synthetic, sharing the lifecycle hook.
// Inline-block sized so it can sit on a banner row or an empty-state CTA
// cluster without dominating the layout. Continuous-mode toggle and the
// full pre/post-run pitch live on the full /step-zero card.
export const SyntheticRunCompact: React.FC<Props> = ({
  label = 'Run demo scenario',
  hideViewLink = false,
}) => {
  const { status, starting, startError, start, stop } = useSyntheticRun();
  const isRunning = !!status?.running;

  if (isRunning) {
    return (
      <div className="inline-flex flex-wrap items-center gap-2 text-tiny">
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-blue-950/40 border border-blue-900 text-blue-200">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span className="font-mono text-blue-100">{status?.sent_traces ?? 0}</span>
          <span className="text-blue-300/80">
            traces
            {status?.eta_s != null ? ` · ${status.eta_s}s left` : status?.continuous ? ' · running' : ''}
          </span>
        </span>
        {!hideViewLink && (
          <a
            href={status?.local_deep_link || '/otel-data'}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-info hover:underline"
          >
            View <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <button
          onClick={stop}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-700 text-gray-200 hover:bg-gray-800"
        >
          <Square className="w-3 h-3" /> Stop
        </button>
      </div>
    );
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        onClick={() => start()}
        disabled={starting}
        className="inline-flex items-center gap-2 px-4 py-2 rounded font-semibold text-sm bg-primary hover:bg-primary-hover text-white disabled:opacity-60"
        title="Run a 60s burst of realistic synthetic telemetry across 5 services so the dashboards have data to show"
      >
        {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        {label}
      </button>
      {startError && <span className="text-tiny text-danger-text">{startError}</span>}
    </div>
  );
};
