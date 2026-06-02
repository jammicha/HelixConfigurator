/**
 * A tiny re-entrancy guard for periodic pollers.
 *
 * The OTel viewer fires several independent interval pollers (traces, services,
 * operations) against a synchronous-SQLite backend. If a response is slow, an
 * un-guarded interval keeps firing and requests pile up faster than the
 * single-threaded backend can drain them — the runaway queue that gridlocked the
 * page. A guard bounds the in-flight count to one per poller by skipping ticks
 * that arrive while a prior run is still pending.
 *
 * Kept as a plain factory (no React) so the skip logic is unit-testable in the
 * pure-function test environment; `useGuardedPoll` wraps it for components.
 */
export type PollGuard = {
  /** Invoke `fn` unless a prior invocation is still pending. Returns whether it ran. */
  run: (fn: () => void | Promise<unknown>) => boolean;
  /** True while a run is in flight. */
  readonly pending: boolean;
};

export function createPollGuard(): PollGuard {
  let inFlight = false;
  return {
    run(fn) {
      if (inFlight) return false;
      inFlight = true;
      // Settle the flag once fn's work completes — whether it resolves, rejects,
      // or throws synchronously — so a failed poll can't wedge the guard shut.
      // The polled fn owns its own error handling; we only manage the flag.
      (async () => {
        try { await fn(); } catch { /* polled fn owns its errors */ } finally { inFlight = false; }
      })();
      return true;
    },
    get pending() { return inFlight; },
  };
}
