import { useEffect } from 'react';

export type RefreshInterval = 'off' | '10s' | '30s' | '60s' | '5m';

export const REFRESH_INTERVAL_MS: Record<RefreshInterval, number | null> = {
  off: null,
  '10s': 10_000,
  '30s': 30_000,
  '60s': 60_000,
  '5m': 5 * 60_000,
};

/**
 * Page-wide refresh orchestrator. Fires the supplied poll callback at the
 * selected cadence (default 60s) and pauses while the document is hidden so
 * a backgrounded window doesn't keep hammering the gateway. Polling stops
 * entirely when the user selects "off".
 *
 * Doesn't fire on mount — that's the caller's job (typically via an
 * inputs-change effect inside whatever hook is being polled). This keeps
 * the "initial fetch" and "periodic refresh" responsibilities cleanly
 * separated.
 */
export function usePageRefresh(interval: RefreshInterval, poll: () => void) {
  useEffect(() => {
    const ms = REFRESH_INTERVAL_MS[interval];
    if (ms == null) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      poll();
    }, ms);
    return () => clearInterval(id);
  }, [interval, poll]);
}
