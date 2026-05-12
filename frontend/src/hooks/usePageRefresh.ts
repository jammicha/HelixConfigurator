import { useEffect } from 'react';

// Unified stream mode. Replaces the previous separate Pause toggle and
// Auto-refresh interval — those overlapped too much to justify two controls.
// - 'live'    : SSE merges + 30 s poll (real-time mode)
// - '30s/1m/5m': SSE off, poll at that cadence (snapshot modes)
// - 'paused'  : SSE off, no poll (frozen view for reading)
export type StreamMode = 'live' | '30s' | '1m' | '5m' | 'paused';

export const STREAM_MODE_POLL_MS: Record<StreamMode, number | null> = {
  live: 30_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 5 * 60_000,
  paused: null,
};

export const isStreamLive = (mode: StreamMode) => mode === 'live';

// Kept for backwards compat with any caller still on the old enum (none
// remain in-tree, but the type is exported and there may be downstream code).
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
export function usePageRefresh(mode: StreamMode, poll: () => void) {
  useEffect(() => {
    const ms = STREAM_MODE_POLL_MS[mode];
    if (ms == null) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      poll();
    }, ms);
    return () => clearInterval(id);
  }, [mode, poll]);
}
