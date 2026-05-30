import React, { useState } from 'react';
import { Play, Square, ExternalLink, Loader2 } from 'lucide-react';
import { useSyntheticRun } from '../../hooks/useSyntheticRun';

export const Layer2Synthetic: React.FC = () => {
  const { status, starting, startError, haveRun, start, stop } = useSyntheticRun();
  const [continuous, setContinuous] = useState(false);

  const isRunning = !!status?.running;
  const isContinuous = !!status?.continuous;
  const showPostRun = !isRunning && haveRun && (status?.sent_traces ?? 0) > 0;

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-1000 p-4">
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-[10px] uppercase tracking-wider text-blue-300 font-semibold">Demo</span>
      </div>
      <h2 className="text-base font-semibold text-gray-100 mb-1">
        {showPostRun ? 'Scenario complete' : isRunning ? 'Running scenario' : 'See Helix populated'}
      </h2>
      <p className="text-xs text-gray-400 mb-3 leading-relaxed">
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
        <div className="font-mono text-[11px] text-gray-300 bg-gray-900 border border-gray-800 rounded p-2 mb-3 whitespace-pre text-center">
{`checkout-web → cart-api → inventory-db
      ↳ payment-svc → stripe-mock
      ↳ notification-svc`}
        </div>
      )}

      {startError && (
        <p className="text-xs text-red-300 mb-2">{startError}</p>
      )}

      {isRunning ? (
        <div className="space-y-2">
          <div className="rounded border border-blue-900 bg-blue-950/30 p-3">
            <div className="flex justify-between items-baseline mb-1">
              <span className="text-xl font-bold font-mono text-blue-200">{status!.sent_traces}</span>
              <span className="text-xs text-gray-400">
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
          <div className="flex gap-2">
            <a
              href={status?.local_deep_link || '/otel-data'}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90"
            >
              View in /otel-data <ExternalLink className="w-3 h-3" />
            </a>
            <button
              onClick={stop}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-xs font-semibold text-gray-100 hover:bg-gray-900"
            >
              <Square className="w-3 h-3" /> Stop
            </button>
          </div>
        </div>
      ) : showPostRun ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <a
              href={status?.local_deep_link || '/otel-data'}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90"
            >
              View in /otel-data <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={() => start({ continuous })}
              disabled={starting}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-xs font-semibold text-gray-100 hover:bg-gray-900 disabled:opacity-60"
            >
              {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Run again
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
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
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => start({ continuous })}
            disabled={starting}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
          >
            {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Run scenario
          </button>
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(e) => setContinuous(e.target.checked)}
              className="cursor-pointer"
            />
            Continuous mode
          </label>
        </div>
      )}
    </section>
  );
};
