import { useEffect } from 'react';

type Options = { enabled?: boolean };

// Poll a JSON endpoint on an interval, pausing while the tab is hidden and
// snapping fresh the instant it becomes visible again. The in-flight request
// is aborted and the interval/visibility listener torn down on unmount (or
// when `enabled` flips false). onData receives the parsed JSON; onError fires
// on network/parse failures but not on aborts.
//
// The effect re-subscribes only when url/interval/enabled change, so the
// onData/onError closures are captured per-subscription — matching the
// original poll effects, whose callbacks only touched stable state setters.
export const usePolledFetch = (
  url: string,
  intervalMs: number,
  onData: (data: any) => void,
  onError: () => void,
  { enabled = true }: Options = {},
) => {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    const tick = () => {
      // Skip while backgrounded; the visibilitychange handler re-fires this
      // immediately on return so the UI snaps current.
      if (document.visibilityState === 'hidden') return;
      fetch(url, { signal: controller.signal })
        .then(res => res.json())
        .then(data => { if (!cancelled) onData(data); })
        .catch((err) => {
          if (cancelled || err.name === 'AbortError') return;
          onError();
        });
    };
    tick();
    const interval = setInterval(tick, intervalMs);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs, enabled]);
};
