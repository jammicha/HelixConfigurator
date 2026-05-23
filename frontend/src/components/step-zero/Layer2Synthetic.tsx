import React, { useState } from 'react';
import { Play, Square, ExternalLink, Loader2 } from 'lucide-react';
import { useSyntheticRun } from '../../hooks/useSyntheticRun';

// Layer2Synthetic takes no props. The component intentionally does NOT
// gate behavior on `envReady` (passed elsewhere in StepZero) — the
// local-fallback destination works without HELIX_ENDPOINT and is part of
// the "Step 0 truly works from zero" promise. The destination decision
// happens server-side at /start.
//
// Lifecycle (status polling, start/stop, error handling) lives in
// useSyntheticRun so the OverviewTab empty state and the dashboard
// PipelineStatusBanner can share it via SyntheticRunCompact without
// duplicating the polling logic.
export const Layer2Synthetic: React.FC = () => {
  const { status, starting, startError, haveRun, start, stop } = useSyntheticRun();
  // Continuous-mode toggle is part of the full /step-zero card only;
  // the compact variant always runs a fixed-duration scenario.
  const [continuous, setContinuous] = useState(false);

  const isRunning = !!status?.running;
  const isContinuous = !!status?.continuous;
  const showPostRun = !isRunning && haveRun && (status?.sent_traces ?? 0) > 0;

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-1000 p-6">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-tiny uppercase tracking-wider text-blue-300">Demo</span>
      </div>
      <h2 className="text-xl font-semibold text-gray-100 mb-1">
        {showPostRun ? 'Scenario complete' : isRunning ? 'Running scenario' : 'See Helix populated'}
      </h2>
      <p className="text-sm text-gray-400 mb-4">
        {showPostRun ? (
          <>{status!.sent_traces} traces sent &middot; {status!.sent_with_errors} with errors. Eight diagnostic patterns to hunt for: stripe-mock latency tail (~8%), inventory cascade errors (~3%), N+1 inventory queries (~5%), cart-api cache misses (~5%), inventory pool waits (~4%), notification render slow (~2%), retry storms (~2%), and cold-start spikes (~2%, visible as outlier badges in /otel-data).</>
        ) : isRunning ? (
          status?.destination === 'gateway'
            ? <>Streaming through Helix Gateway → your Helix tenant + <code>/otel-data</code></>
            : <>Helix not configured yet. Streaming to <code>/otel-data</code> only. Complete Step 1 to also reach your tenant.</>
        ) : (
          <>60-second burst of realistic e-commerce traffic across 5 services. Eight diagnostic patterns are woven in (slow downstreams, cache misses, DB pool waits, cascading errors, N+1 queries, retry storms, cold starts, and a slow email renderer) so you can see how OTel surfaces each one.</>
        )}
      </p>

      {!isRunning && !showPostRun && (
        <div className="font-mono text-tiny text-gray-300 bg-gray-900 border border-gray-800 rounded p-3 mb-4 whitespace-pre">
{`checkout-web → cart-api → inventory-db
      ↳ payment-svc → stripe-mock
      ↳ notification-svc`}
        </div>
      )}

      {startError && (
        <p className="text-tiny text-red-300 mb-3">{startError}</p>
      )}

      {isRunning ? (
        <div className="space-y-3">
          <div className="rounded border border-blue-900 bg-blue-950/30 p-4">
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-2xl font-bold font-mono text-blue-200">{status!.sent_traces}</span>
              <span className="text-tiny text-gray-400">
                traces sent &middot; {status!.sent_with_errors} errors
                {isContinuous ? ' · running continuously' : status!.eta_s != null ? ` · ${status!.eta_s}s remaining` : ''}
              </span>
            </div>
            {!isContinuous && status!.eta_s != null && (
              <div className="h-1 bg-blue-950 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${Math.min(100, ((status!.elapsed_s ?? 0) / ((status!.elapsed_s ?? 0) + status!.eta_s)) * 100)}%` }}
                />
              </div>
            )}
          </div>
          <a
            href={status?.local_deep_link || '/otel-data'}
            className="w-full inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-tiny font-semibold text-white hover:bg-primary/90"
          >
            View in /otel-data <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={stop}
            className="w-full inline-flex items-center justify-center gap-2 rounded border border-gray-700 px-4 py-2 text-tiny font-semibold text-gray-100 hover:bg-gray-900"
          >
            <Square className="w-3.5 h-3.5" /> Stop
          </button>
        </div>
      ) : showPostRun ? (
        <div className="space-y-2">
          {/*
            The "Open service map in Helix" link was removed: the URL we
            generated (OTelNamespaceOverview dashboard) is not actually the
            service map. The backend still emits helix_deep_link for future
            use once we wire up the correct service-map URL pattern.
          */}
          <a
            href={status?.local_deep_link || '/otel-data'}
            className="w-full inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-tiny font-semibold text-white hover:bg-primary/90"
          >
            View in /otel-data <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => start({ continuous })}
            disabled={starting}
            className="w-full inline-flex items-center justify-center gap-2 rounded border border-gray-700 px-4 py-2 text-tiny font-semibold text-gray-100 hover:bg-gray-900 disabled:opacity-60"
          >
            {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Run again
          </button>
          <label className="flex items-center gap-2 text-tiny text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(e) => setContinuous(e.target.checked)}
              className="cursor-pointer"
            />
            Continuous mode (run until stopped)
          </label>
        </div>
      ) : (
        <>
          {/*
            We intentionally do NOT gate on `envReady`. The local-fallback
            destination works without HELIX_ENDPOINT and is part of the
            "Step 0 truly works from zero" promise. The destination decision
            happens server-side at /start.
          */}
          <button
            onClick={() => start({ continuous })}
            disabled={starting}
            className="w-full inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run scenario
          </button>
          <label className="flex items-center gap-2 text-tiny text-gray-400 mt-3 cursor-pointer">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(e) => setContinuous(e.target.checked)}
              className="cursor-pointer"
            />
            Continuous mode (run until stopped)
          </label>
        </>
      )}
    </section>
  );
};
